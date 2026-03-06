import "colors";
import mongoose, {ClientSession, Types} from "mongoose";
import TaskModel from "../models/Task";
import MemoryModel from "../models/Memory";
import MessageModel from "../models/Message";
import SessionModel, {ISession} from "../models/Session";
import {generateInvalidCode, generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {
    IDeleteProjectParams,
    IDeleteProjectResponse,
    IDeleteSessionParams,
    IDeleteSessionResponse,
    IGetAllProjectsResponse,
    IGetAllSessionsParams,
    IGetAllSessionsResponse,
    IGetSessionResponse,
    IPagination
} from "../types/session";

class SessionService {
    static async getAllSessions({title, source, projectDir, page = 1, limit = 20}: IGetAllSessionsParams): Promise<IGetAllSessionsResponse> {
        console.log('Service: SessionService.getAllSessions called'.cyan.italic);

        const filter: Record<string, unknown> = {};
        if (title) filter.title = {$regex: title, $options: 'i'};
        if (source) filter.source = source;
        if (projectDir) filter.projectDir = projectDir;

        const skip: number = (page - 1) * limit;

        const [sessions, total]: [ISession[], number] = await Promise.all([
            SessionModel.find(filter, {sessionId: 1, title: 1, aiModel: 1, projectDir: 1, source: 1, createdAt: 1, updatedAt: 1})
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
        console.log('Service: SessionService.getSessionBySessionId called'.cyan.italic);

        if (!sessionId) {
            return {error: generateInvalidCode('sessionId')};
        }

        const session: ISession | null = await SessionModel.findOne({sessionId});
        if (!session) {
            return {error: generateNotFoundCode('session')};
        }

        const messages = await MessageModel.find({sessionInternalId: session._id}).sort({timestamp: 1});

        console.log('Database: Session fetched'.cyan, {sessionId, messages: messages.length});

        return {session, messages};
    }

    static async getAllProjects(): Promise<IGetAllProjectsResponse> {
        console.log('Service: SessionService.getAllProjects called'.cyan.italic);

        const projects: string[] = await SessionModel.distinct('projectDir');
        console.log('Database: Projects fetched'.cyan, projects.length);

        return {projects};
    }

    static async deleteProject({projectDir}: IDeleteProjectParams): Promise<IDeleteProjectResponse> {
        console.log('Service: SessionService.deleteProject called'.cyan.italic, projectDir);

        if (!projectDir) {
            return {error: generateMissingCode('projectDir')};
        }

        // Gather sessions for this project to derive related IDs
        const sessions = await SessionModel.find({projectDir}, {_id: 1, sessionId: 1}).lean();
        const memoryCount: number = await MemoryModel.countDocuments({projectDir});
        console.debug(`Service: Sessions found for project ${projectDir}`.cyan, sessions.length);

        if (sessions.length === 0 && memoryCount === 0) {
            return {error: generateNotFoundCode('project')};
        }

        const sessionInternalIds: Types.ObjectId[] = sessions.map((s) => s._id);
        const sessionIds: string[] = sessions.map((s) => s.sessionId);

        const mongoSession: ClientSession = await mongoose.startSession();
        try {
            mongoSession.startTransaction();

            const {deletedCount: deletedMessagesCount} = await MessageModel.deleteMany(
                {sessionInternalId: {$in: sessionInternalIds}},
                {session: mongoSession},
            );
            const {deletedCount: deletedTasksCount} = await TaskModel.deleteMany(
                {sessionId: {$in: sessionIds}},
                {session: mongoSession},
            );
            const {deletedCount: deletedMemoriesCount} = await MemoryModel.deleteMany(
                {projectDir},
                {session: mongoSession},
            );
            const {deletedCount: deletedSessionsCount} = await SessionModel.deleteMany(
                {projectDir},
                {session: mongoSession},
            );

            await mongoSession.commitTransaction();
            console.log('Database: Project deleted'.cyan, {projectDir, deletedSessionsCount, deletedMessagesCount, deletedTasksCount, deletedMemoriesCount});

            return {
                deletedSessions: deletedSessionsCount,
                deletedMessages: deletedMessagesCount,
                deletedTasks: deletedTasksCount,
                deletedMemories: deletedMemoriesCount,
            };
        } catch (error: unknown) {
            console.error('inside catch of deleteProject:'.red.bold, error);
            await mongoSession.abortTransaction();
            throw error;
        } finally {
            await mongoSession.endSession();
        }
    }

    static async deleteSession({sessionId}: IDeleteSessionParams): Promise<IDeleteSessionResponse> {
        console.log('Service: SessionService.deleteSession called'.cyan.italic, sessionId);

        if (!sessionId) {
            return {error: generateInvalidCode('sessionId')};
        }

        const session: ISession | null = await SessionModel.findOne({sessionId});
        if (!session) {
            return {error: generateNotFoundCode('session')};
        }

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
}

export default SessionService;
