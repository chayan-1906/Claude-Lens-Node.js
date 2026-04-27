import "colors";
import {Types} from "mongoose";
import TaskModel from "../models/Task";
import MemoryModel from "../models/Memory";
import SessionModel from "../models/Session";
import MessageModel, {ContentBlock} from "../models/Message";
import {extractTextFromContent, makeSnippet} from "../utils/searchUtils";
import {ISearchMemoryResponse, ISearchMessageResponse, ISearchQuery, ISearchResponse, ISearchSessionResponse, ISearchTaskResponse} from "../types/search";

class SearchService {
    static async search({q, scope, sessionId, projectDir, limit = 20, skip = 0}: ISearchQuery): Promise<ISearchResponse> {
        console.log('Service: SearchService.search called'.cyan.italic, {q, scope, sessionId, projectDir, limit, skip});

        const safeLimit = Math.min(50, Math.max(1, limit));
        const safeSkip = Math.max(0, skip);

        switch (scope) {
            case 'session':
                return SearchService.searchSession(q, sessionId!, safeLimit, safeSkip);
            case 'project':
                return SearchService.searchProject(q, projectDir!, safeLimit, safeSkip);
            default:
                return SearchService.searchGlobal(q, safeLimit, safeSkip);
        }
    }

    private static async searchSession(q: string, sessionId: string, limit: number, skip: number): Promise<ISearchResponse> {
        const session = await SessionModel.findOne({sessionId}, 'sessionId title projectDir').lean();
        if (!session) return SearchService.empty();

        const sessionOid: Types.ObjectId = session._id as Types.ObjectId;

        const [msgs, tasks] = await Promise.all([
            MessageModel.find(
                {$text: {$search: q}, sessionInternalId: sessionOid},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
            TaskModel.find(
                {$text: {$search: q}, sessionId},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
        ]);

        const messages: ISearchMessageResponse[] = msgs.map((message) => ({
            _type: 'message' as const,
            messageId: String(message._id),
            uuid: message.uuid,
            snippet: makeSnippet(extractTextFromContent(message.content as string | ContentBlock[])),
            role: message.role,
            sessionId: session.sessionId,
            sessionTitle: session.title,
            projectDir: session.projectDir,
            timestamp: message.timestamp.toISOString(),
        }));

        const taskResults: ISearchTaskResponse[] = tasks.map((t) => ({
            _type: 'task' as const,
            taskInternalId: String(t._id),
            snippet: makeSnippet(t.description),
            subject: t.subject,
            status: t.status,
            sessionId: session.sessionId,
            sessionTitle: session.title,
            projectDir: session.projectDir,
        }));

        return {messages, sessions: [], tasks: taskResults, memories: []};
    }

    private static async searchProject(q: string, projectDir: string, limit: number, skip: number): Promise<ISearchResponse> {
        const projectSessions = await SessionModel.find({projectDir}, 'sessionId title projectDir').lean();
        const sessionOids: Types.ObjectId[] = projectSessions.map((s) => s._id as Types.ObjectId);
        const sessionIdStrings: string[] = projectSessions.map((s) => s.sessionId);
        const sessionMap = new Map(projectSessions.map((s) => [s.sessionId, s]));
        const oidToSession = new Map(projectSessions.map((s) => [String(s._id), s]));

        const [msgs, sessionDocs, tasks, memories] = await Promise.all([
            sessionOids.length > 0
                ? MessageModel.find(
                    {$text: {$search: q}, sessionInternalId: {$in: sessionOids}},
                    {score: {$meta: 'textScore'}},
                ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean()
                : Promise.resolve([]),
            SessionModel.find(
                {$text: {$search: q}, projectDir},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
            sessionIdStrings.length > 0
                ? TaskModel.find(
                    {$text: {$search: q}, sessionId: {$in: sessionIdStrings}},
                    {score: {$meta: 'textScore'}},
                ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean()
                : Promise.resolve([]),
            MemoryModel.find(
                {$text: {$search: q}, projectDir},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
        ]);

        const messages: ISearchMessageResponse[] = msgs.map((message) => {
            const s = oidToSession.get(String(message.sessionInternalId));
            return {
                _type: 'message' as const,
                messageId: String(message._id),
                uuid: message.uuid,
                snippet: makeSnippet(extractTextFromContent(message.content as string | ContentBlock[])),
                role: message.role,
                sessionId: s?.sessionId ?? '',
                sessionTitle: s?.title ?? '',
                projectDir,
                timestamp: message.timestamp.toISOString(),
            };
        });

        const sessions: ISearchSessionResponse[] = sessionDocs.map((s) => ({
            _type: 'session' as const,
            sessionId: s.sessionId,
            snippet: makeSnippet(s.description ?? s.title),
            title: s.title,
            description: s.description,
            projectDir: s.projectDir,
            updatedAt: s.updatedAt.toISOString(),
        }));

        const taskResults: ISearchTaskResponse[] = tasks.map((t) => {
            const s = sessionMap.get(t.sessionId);
            return {
                _type: 'task' as const,
                taskInternalId: String(t._id),
                snippet: makeSnippet(t.description),
                subject: t.subject,
                status: t.status,
                sessionId: t.sessionId,
                sessionTitle: s?.title ?? '',
                projectDir: s?.projectDir ?? projectDir,
            };
        });

        const memoryResults: ISearchMemoryResponse[] = memories.map((mem) => ({
            _type: 'memory' as const,
            memoryId: String(mem._id),
            snippet: makeSnippet(mem.content),
            filePath: mem.filePath,
            projectDir: mem.projectDir,
        }));

        return {messages, sessions, tasks: taskResults, memories: memoryResults};
    }

    private static async searchGlobal(q: string, limit: number, skip: number): Promise<ISearchResponse> {
        const [msgs, sessionDocs, tasks, memories] = await Promise.all([
            MessageModel.find(
                {$text: {$search: q}},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit)
                .populate<{sessionInternalId: {_id: Types.ObjectId; sessionId: string; title: string; projectDir: string}}>('sessionInternalId', 'sessionId title projectDir')
                .lean(),
            SessionModel.find(
                {$text: {$search: q}},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
            TaskModel.find(
                {$text: {$search: q}},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
            MemoryModel.find(
                {$text: {$search: q}},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
        ]);

        const taskSessionIds = [...new Set(tasks.map((t) => t.sessionId))];
        const taskSessions = taskSessionIds.length > 0
            ? await SessionModel.find({sessionId: {$in: taskSessionIds}}, 'sessionId title projectDir').lean()
            : [];
        const taskSessionMap = new Map(taskSessions.map((s) => [s.sessionId, s]));

        const messages: ISearchMessageResponse[] = msgs.map((message) => {
            const s = message.sessionInternalId as unknown as {sessionId: string; title: string; projectDir: string} | null;
            return {
                _type: 'message' as const,
                messageId: String(message._id),
                uuid: message.uuid,
                snippet: makeSnippet(extractTextFromContent(message.content as string | ContentBlock[])),
                role: message.role,
                sessionId: s?.sessionId ?? '',
                sessionTitle: s?.title ?? '',
                projectDir: s?.projectDir ?? '',
                timestamp: message.timestamp.toISOString(),
            };
        });

        const sessions: ISearchSessionResponse[] = sessionDocs.map((s) => ({
            _type: 'session' as const,
            sessionId: s.sessionId,
            snippet: makeSnippet(s.description ?? s.title),
            title: s.title,
            description: s.description,
            projectDir: s.projectDir,
            updatedAt: s.updatedAt.toISOString(),
        }));

        const taskResults: ISearchTaskResponse[] = tasks.map((t) => {
            const s = taskSessionMap.get(t.sessionId);
            return {
                _type: 'task' as const,
                taskInternalId: String(t._id),
                snippet: makeSnippet(t.description),
                subject: t.subject,
                status: t.status,
                sessionId: t.sessionId,
                sessionTitle: s?.title ?? '',
                projectDir: s?.projectDir ?? '',
            };
        });

        const memoryResults: ISearchMemoryResponse[] = memories.map((mem) => ({
            _type: 'memory' as const,
            memoryId: String(mem._id),
            snippet: makeSnippet(mem.content),
            filePath: mem.filePath,
            projectDir: mem.projectDir,
        }));

        return {messages, sessions, tasks: taskResults, memories: memoryResults};
    }

    private static empty(): ISearchResponse {
        return {
            messages: [],
            sessions: [],
            tasks: [],
            memories: [],
        };
    }
}

export default SearchService;
