import "colors";
import fs from "fs";
import path from "path";
import mongoose, {ClientSession, Types} from "mongoose";
import TaskModel from "../models/Task";
import MessageModel from "../models/Message";
import {ContentBlock} from "../models/Message";
import SessionModel, {ISession} from "../models/Session";
import {generateInvalidCode, generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {IDeleteSessionParams, IDeleteSessionResponse, IGetAllSessionsParams, IGetAllSessionsResponse, IGetSessionResponse, IPagination, IStubMessagesParams, IStubMessagesResponse} from "../types/session";

const CLAUDE_PROJECTS_DIR: string = path.join(process.env.HOME || '~', '.claude', 'projects');

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
            SessionModel.find(filter, {sessionId: 1, title: 1, aiModel: 1, projectDir: 1, source: 1, parentSessionId: 1, createdAt: 1, updatedAt: 1})
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

    static async getSessionBySessionId(sessionId: string): Promise<IGetSessionResponse> {
        console.log('Service: SessionService.getSessionBySessionId called'.cyan.italic, {sessionId});

        if (!sessionId) {
            console.debug('DEBUG: Missing sessionId, returning error'.cyan);
            return {error: generateInvalidCode('sessionId')};
        }

        const session: ISession | null = await SessionModel.findOne({sessionId});
        if (!session) {
            console.debug('DEBUG: Session not found'.cyan, {sessionId});
            return {error: generateNotFoundCode('session')};
        }

        const messages = await MessageModel.find({sessionInternalId: session._id}).sort({timestamp: 1});

        console.log('Database: Session fetched'.cyan, {sessionId, messages: messages.length});

        return {session, messages};
    }

    static async deleteSession({sessionId}: IDeleteSessionParams): Promise<IDeleteSessionResponse> {
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

        console.debug('DEBUG: Starting delete transaction'.cyan, {sessionId});
        const mongoSession: ClientSession = await mongoose.startSession();
        try {
            mongoSession.startTransaction();

            const {deletedCount: deletedTasksCount} = await TaskModel.deleteMany(
                {sessionId},
                {session: mongoSession},
            );
            const {deletedCount: deletedMessagesCount} = await MessageModel.deleteMany(
                {sessionInternalId: session._id},
                {session: mongoSession},
            );
            const {deletedCount: deletedSessionCount} = await SessionModel.deleteOne(
                {sessionId},
                {session: mongoSession},
            );

            await mongoSession.commitTransaction();
            console.log('Database: Session and messages deleted'.cyan, {deletedSessionCount, deletedTasksCount, deletedMessagesCount});

            return {deletedSessions: deletedSessionCount, deletedTasks: deletedTasksCount, deletedMessages: deletedMessagesCount};
        } catch (error: unknown) {
            await mongoSession.abortTransaction();
            throw error;
        } finally {
            await mongoSession.endSession();
        }
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
                    const tokenCount: number = Math.round((block.content as string).length / 4);
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
