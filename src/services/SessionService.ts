import "colors";
import fs from "fs";
import path from "path";
import mongoose, {ClientSession, Types} from "mongoose";
import TaskModel from "../models/Task";
import {IR2Config} from "../types/setup";
import {getR2Config} from "../utils/localConfig";
import {CLAUDE_PROJECTS_DIR} from "../utils/constants";
import SessionModel, {ISession} from "../models/Session";
import {deleteAttachmentsByUrls, isR2Configured} from "../utils/r2";
import MessageModel, {ContentBlock, IMessage} from "../models/Message";
import {generateInvalidCode, generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {IDeleteSessionParams, IDeleteSessionResponse, IGetAllSessionsParams, IGetAllSessionsResponse, IGetSessionPagination, IGetSessionResponse, IPagination, IStubMessagesParams, IStubMessagesResponse, IUpdateSessionParams, IUpdateSessionResponse} from "../types/session";

class SessionService {
    static async getAllSessions({title, source, projectDir, page = 1, limit = 20}: IGetAllSessionsParams): Promise<IGetAllSessionsResponse> {
        console.log('Service: SessionService.getAllSessions called'.cyan.italic);

        const filter: Record<string, unknown> = {};
        if (title) filter.title = {$regex: title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i'};
        if (source) filter.source = source;
        if (projectDir) filter.projectDir = projectDir;
        console.debug('DEBUG: Query filter built'.cyan, {filter, page, limit});

        const skip: number = (page - 1) * limit;

        const [sessions, total]: [ISession[], number] = await Promise.all([
            SessionModel.find(filter, {sessionId: 1, title: 1, description: 1, aiModel: 1, projectDir: 1, source: 1, parentSessionId: 1, createdAt: 1, updatedAt: 1})
                .sort({updatedAt: -1})
                .skip(skip)
                .limit(limit),
            SessionModel.countDocuments(filter),
        ]);

        console.log('Database: SessionService fetched'.cyan, sessions.length);

        const pagination: IPagination = {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        };

        return {sessions, pagination};
    }

    static async getSessionBySessionId(sessionId: string, limit: number = 50, cursor?: string): Promise<IGetSessionResponse> {
        console.log('Service: SessionService.getSessionBySessionId called'.cyan.italic, {sessionId, limit, cursor});

        if (!sessionId) {
            console.debug('DEBUG: Missing sessionId, returning error'.cyan);
            return {error: generateInvalidCode('sessionId')};
        }

        const session: ISession | null = await SessionModel.findOne({sessionId});
        if (!session) {
            console.debug('DEBUG: Session not found'.cyan, {sessionId});
            return {error: generateNotFoundCode('session')};
        }

        const messageMeta: Array<Pick<IMessage, 'uuid'>> = await MessageModel.find(
            {sessionInternalId: session._id},
            {uuid: 1},
            {sort: {timestamp: 1}},
        ).lean();
        const totalCount: number = messageMeta.length;

        let endIndex: number = totalCount;
        if (cursor) {
            const cursorIndex: number = messageMeta.findIndex((message: Pick<IMessage, 'uuid'>) => message.uuid === cursor);
            if (cursorIndex === -1) {
                console.debug('DEBUG: Cursor not found in session messages'.cyan, {sessionId, cursor});
                return {error: generateInvalidCode('cursor')};
            }
            endIndex = cursorIndex;
        }

        const startIndex: number = Math.max(0, endIndex - limit);
        const pageMeta: Array<Pick<IMessage, 'uuid'>> = messageMeta.slice(startIndex, endIndex);
        const pageUuids: string[] = pageMeta.map((message: Pick<IMessage, 'uuid'>) => message.uuid);

        const messageDocs: IMessage[] = pageUuids.length > 0
            ? await MessageModel.find({uuid: {$in: pageUuids}}).sort({timestamp: 1, _id: 1})
            : [];

        const pagination: IGetSessionPagination = {
            limit,
            totalCount,
            hasMore: startIndex > 0,
            nextCursor: startIndex > 0 ? pageMeta[0].uuid : null,
        };

        console.log('Database: Session fetched'.cyan, {
            sessionId,
            totalMessages: messageMeta.length,
            pageMessages: messageDocs.length,
            hasMore: pagination.hasMore,
            nextCursor: pagination.nextCursor,
            contextTokensUsed: session.contextTokensUsed,
            contextWindowSize: session.contextWindowSize,
        });

        return {session, messages: messageDocs, pagination};
    }

    static async updateSession({sessionId, title, description}: IUpdateSessionParams): Promise<IUpdateSessionResponse> {
        console.log('Service: SessionService.updateSession called'.cyan.italic, {sessionId});

        if (!sessionId) {
            console.debug('DEBUG: Missing sessionId, returning error'.cyan);
            return {error: generateInvalidCode('sessionId')};
        }

        const session: ISession | null = await SessionModel.findOne({sessionId});
        if (!session) {
            console.debug('DEBUG: Session not found'.cyan, {sessionId});
            return {error: generateNotFoundCode('session')};
        }

        if (title !== undefined) {
            if (!title.trim()) {
                console.debug('DEBUG: Empty title provided, returning error'.cyan);
                return {error: generateInvalidCode('title')};
            }
            if (title.trim().length > 100) {
                console.debug('DEBUG: Title exceeds 100 characters, returning error'.cyan);
                return {error: generateInvalidCode('title')};
            }
            session.title = title.trim();
            session.titleRenamed = true;
        }

        if (description !== undefined) {
            if (description.length > 500) {
                console.debug('DEBUG: Description exceeds 500 characters, returning error'.cyan);
                return {error: generateInvalidCode('description')};
            }
            session.description = description.trim();
        }

        await session.save();
        console.log('Database: Session updated'.cyan, {sessionId, title: session.title, description: session.description});

        return {session};
    }

    static async deleteSession({sessionId, reclaimR2}: IDeleteSessionParams): Promise<IDeleteSessionResponse> {
        console.log('Service: SessionService.deleteSession called'.cyan.italic, {sessionId});

        if (!sessionId) {
            console.debug('DEBUG: Missing sessionId, returning error'.cyan);
            return {error: generateInvalidCode('sessionId')};
        }

        const session: ISession | null = await SessionModel.findOne({sessionId});
        if (!session) {
            console.debug('DEBUG: Session not found'.cyan, {sessionId});
            return {error: generateNotFoundCode('session')};
        }

        // Collect R2 URLs BEFORE deleting from MongoDB — must happen while data still exists.
        // Extract from content blocks (image/document source.url, text file references) — this covers
        // both session-ID-prefixed attachments and first-message temp-UUID-prefixed orphan dirs.
        const r2UrlsToDelete: string[] = [];
        if (reclaimR2 && isR2Configured()) {
            const config: IR2Config = getR2Config()!;
            const userMessages = await MessageModel.find(
                {sessionInternalId: session._id, role: 'user'},
                {content: 1},
            ).lean();
            for (const msg of userMessages) {
                if (!Array.isArray(msg.content)) continue;
                for (const block of msg.content as Record<string, unknown>[]) {
                    if ((block.type === 'image' || block.type === 'document') &&
                        (block.source as Record<string, unknown>)?.type === 'url') {
                        const url: unknown = (block.source as Record<string, unknown>).url;
                        if (typeof url === 'string') r2UrlsToDelete.push(url);
                    } else if (block.type === 'text' && typeof block.text === 'string') {
                        // Text/code file references: "File attached: <name> — <url>"
                        const parts: string[] = block.text.split(' — ');
                        if (parts.length >= 2 && parts[0].startsWith('File attached:')) {
                            r2UrlsToDelete.push(parts[parts.length - 1]);
                        }
                    }
                }
            }
            // JSONL backup is stored separately — not in message content
            r2UrlsToDelete.push(`${config.publicUrl}/${sessionId}/${sessionId}.jsonl`);
            console.debug('DEBUG: Collected R2 URLs for deletion'.cyan, {count: r2UrlsToDelete.length});
        }

        console.debug('DEBUG: Starting delete transaction'.cyan, {sessionId});
        const mongoSession: ClientSession = await mongoose.startSession();
        let deletedTasksCount: number = 0;
        let deletedMessagesCount: number = 0;
        let deletedSessionCount: number = 0;
        try {
            mongoSession.startTransaction();

            ({deletedCount: deletedTasksCount} = await TaskModel.deleteMany(
                {sessionId},
                {session: mongoSession},
            ));
            ({deletedCount: deletedMessagesCount} = await MessageModel.deleteMany(
                {sessionInternalId: session._id},
                {session: mongoSession},
            ));
            ({deletedCount: deletedSessionCount} = await SessionModel.deleteOne(
                {sessionId},
                {session: mongoSession},
            ));

            await mongoSession.commitTransaction();
            console.log('Database: Session and messages deleted'.cyan, {deletedSessionCount, deletedTasksCount, deletedMessagesCount});
        } catch (error: unknown) {
            await mongoSession.abortTransaction();
            throw error;
        } finally {
            await mongoSession.endSession();
        }

        // After commit: delete pre-collected R2 objects (URLs captured before MongoDB was cleared)
        const deletedAttachments: number = r2UrlsToDelete.length
            ? await deleteAttachmentsByUrls(r2UrlsToDelete).catch(() => 0)
            : 0;

        return {deletedSessions: deletedSessionCount, deletedTasks: deletedTasksCount, deletedMessages: deletedMessagesCount, deletedAttachments};
    }

    static async stubMessages({sessionId, messageIds}: IStubMessagesParams): Promise<IStubMessagesResponse> {
        console.log('Service: SessionService.stubMessages called'.cyan.italic, {sessionId, messageIds});

        if (!sessionId) {
            console.debug('DEBUG: Missing sessionId, returning error'.cyan);
            return {error: generateInvalidCode('sessionId')};
        }
        if (!messageIds || messageIds.length === 0) {
            console.debug('DEBUG: Missing messageIds, returning error'.cyan);
            return {error: generateMissingCode('messageIds')};
        }

        const session: ISession | null = await SessionModel.findOne({sessionId});
        if (!session) {
            console.debug('DEBUG: Session not found'.cyan, {sessionId});
            return {error: generateNotFoundCode('session')};
        }

        let stubbedCount: number = 0;
        const stubbedUuids: Map<string, {toolResults: Array<{tool_use_id: string; tokenCount: number}>; hasThinking: boolean}> = new Map();

        for (const messageId of messageIds) {
            if (!Types.ObjectId.isValid(messageId)) continue;

            const message = await MessageModel.findById(messageId);
            if (!message || !Array.isArray(message.content)) continue;

            // Ensure message belongs to this session
            if (message.sessionInternalId.toString() !== (session._id as Types.ObjectId).toString()) continue;

            let modified: boolean = false;
            const blockStubs: Array<{tool_use_id: string; tokenCount: number}> = [];
            let thinkingStubbed: boolean = false;

            message.content = (message.content as ContentBlock[]).map((block: ContentBlock) => {
                if (block.type === 'tool_result' && !(block as any)._stubbed) {
                    let charCount: number;
                    if (typeof block.content === 'string') {
                        charCount = block.content.length;
                    } else if (Array.isArray(block.content)) {
                        charCount = JSON.stringify(block.content).length;
                    } else {
                        charCount = 0;
                    }
                    const tokenCount: number = Math.round(charCount / 4);
                    modified = true;
                    blockStubs.push({tool_use_id: block.tool_use_id, tokenCount});
                    return {
                        type: 'tool_result' as const,
                        tool_use_id: block.tool_use_id,
                        content: `[content removed — was ~${tokenCount} tokens]`,
                        is_error: block.is_error,
                        _stubbed: true,
                        _originalTokenCount: tokenCount,
                    };
                }
                if (block.type === 'thinking' && !(block as any)._stubbed) {
                    const tokenCount: number = Math.round(block.thinking.length / 4);
                    modified = true;
                    thinkingStubbed = true;
                    return {
                        type: 'thinking' as const,
                        thinking: `[thinking removed — was ~${tokenCount} tokens]`,
                        _stubbed: true,
                        _originalTokenCount: tokenCount,
                    };
                }
                return block;
            });

            if (modified) {
                message.markModified('content');
                await message.save();
                stubbedUuids.set(message.uuid, {toolResults: blockStubs, hasThinking: thinkingStubbed});
                stubbedCount++;
            }
        }

        let diskUpdated: boolean = false;
        if (stubbedCount > 0) {
            console.debug('DEBUG: Rewriting JSONL on disk'.cyan, {sessionId, stubbedCount, stubbedUuids: stubbedUuids.size});
            diskUpdated = SessionService.rewriteJsonl(session.projectDir, session.sessionId, stubbedUuids);
        }

        console.log('Database: Messages stubbed'.cyan, {stubbedCount, diskUpdated});
        return {stubbedCount, diskUpdated};
    }

    private static rewriteJsonl(projectDir: string, sessionId: string, stubbedUuids: Map<string, {toolResults: Array<{tool_use_id: string; tokenCount: number}>; hasThinking: boolean}>): boolean {
        const jsonlPath: string = path.join(CLAUDE_PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);

        if (!fs.existsSync(jsonlPath)) {
            console.warn(`Stub: JSONL file not found at ${jsonlPath}`.yellow);
            return false;
        }

        const lines: string[] = fs.readFileSync(jsonlPath, 'utf-8').split('\n');
        const updated: string[] = lines.map((line: string) => {
            if (!line.trim()) return line;

            let event: Record<string, unknown>;
            try {
                event = JSON.parse(line);
            } catch {
                return line;
            }

            const uuid: string = event.uuid as string;
            if (!uuid || !stubbedUuids.has(uuid)) return line;

            const message: Record<string, unknown> = event.message as Record<string, unknown>;
            if (!message || !Array.isArray(message.content)) return line;

            const stubInfo = stubbedUuids.get(uuid)!;
            const toolResultMap: Map<string, number> = new Map(
                stubInfo.toolResults.map(({tool_use_id, tokenCount}) => [tool_use_id, tokenCount]),
            );

            message.content = (message.content as Record<string, unknown>[]).map((block: Record<string, unknown>) => {
                if (block.type === 'tool_result') {
                    const toolUseId: string = block.tool_use_id as string;
                    if (!toolResultMap.has(toolUseId)) return block;
                    const tokenCount: number = toolResultMap.get(toolUseId)!;
                    // Write native Claude Code format — strip _stubbed/_originalTokenCount (MongoDB-only metadata)
                    return {
                        type: 'tool_result',
                        tool_use_id: toolUseId,
                        content: `[content removed — was ~${tokenCount} tokens]`,
                        is_error: block.is_error,
                    };
                }
                if (block.type === 'thinking' && stubInfo.hasThinking) {
                    const thinking: string = block.thinking as string;
                    if (thinking.startsWith('[thinking removed')) return block;
                    const tokenCount: number = Math.round(thinking.length / 4);
                    // Write native Claude Code format — strip _stubbed/_originalTokenCount (MongoDB-only metadata)
                    return {
                        type: 'thinking',
                        thinking: `[thinking removed — was ~${tokenCount} tokens]`,
                    };
                }
                return block;
            });

            return JSON.stringify(event);
        });

        fs.writeFileSync(jsonlPath, updated.join('\n'));
        console.log(`Stub: JSONL rewritten at ${jsonlPath}`.cyan);
        return true;
    }
}

export default SessionService;
