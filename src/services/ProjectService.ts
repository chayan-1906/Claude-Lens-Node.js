import "colors";
import mongoose, {ClientSession, Types} from "mongoose";
import TaskModel from "../models/Task";
import MemoryModel from "../models/Memory";
import MessageModel from "../models/Message";
import SessionModel from "../models/Session";
import {reclaimCollectionStorage} from "../utils/reclaimStorage";
import {generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {IDeleteProjectParams, IDeleteProjectResponse, IGetAllProjectsResponse} from "../types/project";

class ProjectService {
    static async getAllProjects(): Promise<IGetAllProjectsResponse> {
        console.log('Service: ProjectService.getAllProjects called'.cyan.italic);

        const projects: string[] = await SessionModel.distinct('projectDir');
        console.log('Database: Projects fetched'.cyan, projects.length);

        return {projects};
    }

    static async deleteProject({projectDir}: IDeleteProjectParams): Promise<IDeleteProjectResponse> {
        console.log('Service: ProjectService.deleteProject called'.cyan.italic, projectDir);

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

            // Reclaim fragmented storage — fire-and-forget (non-blocking)
            reclaimCollectionStorage('messages').catch(() => {});

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
}

export default ProjectService;
