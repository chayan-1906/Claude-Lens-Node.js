import "colors";
import mongoose, {ClientSession} from "mongoose";
import TaskModel from "../models/Task";
import MessageModel from "../models/Message";
import SessionModel, {ISession} from "../models/Session";
import {generateInvalidCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {IDeleteSessionParams, IDeleteSessionResponse, IGetAllSessionsParams, IGetAllSessionsResponse, IGetSessionResponse, IPagination} from "../types/session";

class SessionService {
    static async getAllSessions({title, source, projectDir, page = 1, limit = 20}: IGetAllSessionsParams): Promise<IGetAllSessionsResponse> {
        console.log('Service: SessionService.getAllSessions called'.cyan.italic);

        const filter: Record<string, unknown> = {};
        if (title) filter.title = {$regex: title, $options: 'i'};
        if (source) filter.source = source;
        if (projectDir) filter.projectDir = projectDir;

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
