import "colors";
import mongoose, {ClientSession, Types} from "mongoose";
import TaskModel from "../models/Task";
import {IR2Config} from "../types/setup";
import MemoryModel from "../models/Memory";
import ProjectModel from "../models/Project";
import SessionModel from "../models/Session";
import {getR2Config} from "../utils/localConfig";
import SessionLineModel from "../models/SessionLine";
import {reclaimR2Storage} from "../utils/reclaimR2Storage";
import MessageModel, {EMessageRole} from "../models/Message";
import {deleteAttachmentsByUrls, isR2Configured} from "../utils/r2";
import {generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {IDeleteProjectParams, IDeleteProjectResponse, IGetAllProjectsResponse, IProject, IRenameProjectParams, IRenameProjectResponse} from "../types/project";

class ProjectService {
    static async getAllProjects(): Promise<IGetAllProjectsResponse> {
        console.log('Service: ProjectService.getAllProjects called'.cyan.italic);

        const projects: IProject[] = await SessionModel.aggregate([
            {
                $group: {
                    _id: {
                        rawProjectDir: '$rawProjectDir',
                        projectDir: '$projectDir',
                    },
                },
            },
            {
                $project: {
                    _id: 0,
                    rawProjectDir: '$_id.rawProjectDir',
                    projectDir: '$_id.projectDir',
                },
            },
            {
                $lookup: {
                    from: 'projects',
                    localField: 'rawProjectDir',
                    foreignField: 'rawProjectDir',
                    as: 'projectMeta',
                },
            },
            {
                $addFields: {
                    customName: {$arrayElemAt: ['$projectMeta.customName', 0]},
                    description: {$arrayElemAt: ['$projectMeta.description', 0]},
                },
            },
            {
                $project: {
                    projectMeta: 0,
                },
            },
        ]);

        console.log('Database: Projects fetched'.cyan, projects);

        return {projects};
    }

    static async deleteProject({projectDir, reclaimR2}: IDeleteProjectParams): Promise<IDeleteProjectResponse> {
        console.log('Service: ProjectService.deleteProject called'.cyan.italic, projectDir);

        if (!projectDir) {
            console.debug('DEBUG: Missing projectDir, returning error'.cyan);
            return {error: generateMissingCode('projectDir')};
        }

        // Gather sessions for this project to derive related IDs
        const sessions = await SessionModel.find({projectDir}, {_id: 1, sessionId: 1}).lean();
        const memoryCount: number = await MemoryModel.countDocuments({projectDir});
        console.debug(`Service: Sessions found for project ${projectDir}`.cyan, sessions.length);

        if (sessions.length === 0 && memoryCount === 0) {
            console.debug('DEBUG: No sessions or memories found for project'.cyan, {projectDir});
            return {error: generateNotFoundCode('project')};
        }

        const sessionInternalIds: Types.ObjectId[] = sessions.map((s) => s._id);
        const sessionIds: string[] = sessions.map((s) => s.sessionId);

        // Collect R2 URLs BEFORE deleting from MongoDB — must happen while data still exists.
        // Extract from content blocks (image/document source.url, text file references) — this covers
        // both session-ID-prefixed attachments and first-message temp-UUID-prefixed orphan dirs.
        const r2UrlsToDelete: string[] = [];
        if (reclaimR2 && isR2Configured()) {
            const config: IR2Config = getR2Config()!;
            const userMessages = await MessageModel.find(
                {sessionInternalId: {$in: sessionInternalIds}, role: EMessageRole.USER},
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
            // JSONL backups are stored separately — not in message content
            sessions.forEach(s => r2UrlsToDelete.push(`${config.publicUrl}/${s.sessionId}/${s.sessionId}.jsonl`));
            console.debug('DEBUG: Collected R2 URLs for deletion'.cyan, {count: r2UrlsToDelete.length});
        }

        console.debug('DEBUG: Starting delete transaction'.cyan, {sessionCount: sessions.length, memoryCount, sessionIds});
        const mongoSession: ClientSession = await mongoose.startSession();
        let deletedMessagesCount: number = 0;
        let deletedSessionLinesCount: number = 0;
        let deletedTasksCount: number = 0;
        let deletedMemoriesCount: number = 0;
        let deletedSessionsCount: number = 0;
        try {
            mongoSession.startTransaction();

            ({deletedCount: deletedMessagesCount} = await MessageModel.deleteMany(
                {sessionInternalId: {$in: sessionInternalIds}},
                {session: mongoSession},
            ));
            ({deletedCount: deletedTasksCount} = await TaskModel.deleteMany(
                {sessionId: {$in: sessionIds}},
                {session: mongoSession},
            ));
            ({deletedCount: deletedSessionLinesCount} = await SessionLineModel.deleteMany(
                {sessionId: {$in: sessionIds}},
                {session: mongoSession},
            ));
            ({deletedCount: deletedMemoriesCount} = await MemoryModel.deleteMany(
                {projectDir},
                {session: mongoSession},
            ));
            ({deletedCount: deletedSessionsCount} = await SessionModel.deleteMany(
                {projectDir},
                {session: mongoSession},
            ));
            await ProjectModel.deleteOne(
                {projectDir},
                {session: mongoSession},
            );

            await mongoSession.commitTransaction();
            console.log('Database: Project deleted'.cyan, {projectDir, deletedSessionsCount, deletedMessagesCount, deletedSessionLinesCount, deletedTasksCount, deletedMemoriesCount});
        } catch (error: unknown) {
            console.error('inside catch of deleteProject:'.red.bold, error);
            await mongoSession.abortTransaction();
            throw error;
        } finally {
            await mongoSession.endSession();
        }

        // After commit: parallel cleanup — MongoDB fragmentation reclaim + R2 object deletion
        const [, deletedAttachments] = await Promise.all([
            Promise.all([
                reclaimR2Storage('messages'),
                reclaimR2Storage('sessionlines'),
            ]).catch(() => {}),
            r2UrlsToDelete.length ? deleteAttachmentsByUrls(r2UrlsToDelete).catch(() => 0) : Promise.resolve(0),
        ]);

        return {
            deletedSessions: deletedSessionsCount,
            deletedMessages: deletedMessagesCount,
            deletedTasks: deletedTasksCount,
            deletedMemories: deletedMemoriesCount,
            deletedAttachments: (deletedAttachments as number) ?? 0,
        };
    }

    static async renameProject({projectDir, customName, description}: IRenameProjectParams): Promise<IRenameProjectResponse> {
        console.log('Service: ProjectService.renameProject called'.cyan.italic, {projectDir, customName});

        // Verify the project exists and retrieve rawProjectDir for upsert
        const session = await SessionModel.findOne({projectDir}, {rawProjectDir: 1}).lean();
        if (!session?.rawProjectDir) {
            return {error: generateNotFoundCode('project')};
        }

        const updated = await ProjectModel.findOneAndUpdate(
            {projectDir},
            {
                $set: {customName, lastSessionAt: new Date(), ...(description !== undefined ? {description} : {})},
                $setOnInsert: {rawProjectDir: session.rawProjectDir},
            },
            {upsert: true, returnDocument: 'after'},
        ).lean();

        const project: IProject = {
            rawProjectDir: updated!.rawProjectDir,
            projectDir: updated!.projectDir,
            customName: updated!.customName,
            description: updated!.description,
        };

        console.log('Database: Project renamed'.cyan, project);
        return {project};
    }
}

export default ProjectService;
