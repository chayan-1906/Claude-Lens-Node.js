import "colors";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import {ESessionSource} from "../models/Session";
import SessionService from "../services/SessionService";
import {IDeleteSessionParams, IGetSessionParams} from "../types/session";
import {generateInvalidCode, generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";

const VALID_SOURCES: string[] = Object.values(ESessionSource);

const getAllSessionsController = async (req: Request, res: Response) => {
    console.info('Controller: getAllSessionsController started'.bgBlue.white.bold);

    try {
        const {title, source, projectDir} = req.query as Record<string, string | undefined>;

        if (source !== undefined && !VALID_SOURCES.includes(source)) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateInvalidCode('source'),
                errorMsg: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}`,
            }));
            return;
        }

        const page: number = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit: number = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));

        const {sessions, pagination} = await SessionService.getAllSessions({
            title,
            source,
            projectDir,
            page,
            limit,
        });

        console.log('SUCCESS: Sessions fetched'.bgGreen.bold, {sessions: sessions.length});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Sessions have been fetched!',
            sessions,
            pagination,
        }));
    } catch (error: any) {
        console.error('Controller Error: getAllSessionsController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while retrieving sessions!',
        }));
    }
}

const getSessionController = async (req: Request, res: Response) => {
    console.info('Controller: getSessionController started'.bgBlue.white.bold);

    try {
        const {sessionId}: Partial<IGetSessionParams> = req.params;

        const {session, messages, error} = await SessionService.getSessionBySessionId(sessionId || '');
        if (error || !session || !messages) {
            let errorMsg: string = 'Failed to retrieve session!';
            let statusCode: number = 500;

            if (error === generateInvalidCode('sessionId')) {
                statusCode = 400;
                errorMsg = `Invalid sessionId: ${sessionId}`;
            } else if (error === generateNotFoundCode('session')) {
                statusCode = 404;
                errorMsg = `No session found with sessionId: ${sessionId}`;
            }

            res.status(statusCode).send(new ApiResponse({
                success: false,
                errorCode: error,
                errorMsg,
            }));
            return;
        }

        console.log('SUCCESS: Session fetched'.bgGreen.bold, {sessionId});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Session has been fetched!',
            session,
            messages,
        }));
    } catch (error: any) {
        console.error('Controller Error: getSessionController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while retrieving the session!',
        }));
    }
}

const getProjectsController = async (req: Request, res: Response) => {
    console.info('Controller: getProjectsController started'.bgBlue.white.bold);

    try {
        const {projects} = await SessionService.getProjects();

        console.log('SUCCESS: Projects fetched'.bgGreen.bold, {projects: projects.length});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Projects have been fetched!',
            projects,
        }));
    } catch (error: any) {
        console.error('Controller Error: getProjectsController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while retrieving projects!',
        }));
    }
}

const deleteSessionController = async (req: Request, res: Response) => {
    console.info('Controller: deleteSessionController started'.bgBlue.white.bold);

    try {
        const {sessionId}: Partial<IDeleteSessionParams> = req.params;

        const {deletedSessions, deletedMessages, error} = await SessionService.deleteSession(sessionId || '');
        if (error) {
            let errorMsg: string = 'Failed to delete session!';
            let statusCode: number = 500;

            if (error === generateInvalidCode('sessionId')) {
                statusCode = 400;
                errorMsg = `Invalid sessionId: ${sessionId}!`;
            } else if (error === generateNotFoundCode('session')) {
                statusCode = 404;
                errorMsg = `No session found with sessionId: ${sessionId}!`;
            }

            res.status(statusCode).send(new ApiResponse({
                success: false,
                errorCode: error,
                errorMsg,
            }));
            return;
        }

        console.log('SUCCESS: Session deleted'.bgGreen.bold, {sessionId, deletedSessions, deletedMessages});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Session has been deleted!',
            deletedSessions,
            deletedMessages,
        }));
    } catch (error: any) {
        console.error('Controller Error: deleteSessionController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while deleting the session!',
        }));
    }
}

const deleteProjectController = async (req: Request, res: Response) => {
    console.info('Controller: deleteProjectController started'.bgBlue.white.bold);

    try {
        const {projectDir} = req.query as Record<string, string | undefined>;

        if (!projectDir) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('projectDir'),
                errorMsg: 'projectDir query parameter is required!',
            }));
            return;
        }

        const {deletedSessions, deletedMessages, deletedTasks, deletedMemories, error} = await SessionService.deleteProject(projectDir);
        if (error) {
            let errorMsg: string = 'Failed to delete project!';
            let statusCode: number = 500;

            if (error === generateMissingCode('projectDir')) {
                statusCode = 400;
                errorMsg = 'projectDir is required!';
            } else if (error === generateNotFoundCode('project')) {
                statusCode = 404;
                errorMsg = `No data found for projectDir: ${projectDir}!`;
            }

            res.status(statusCode).send(new ApiResponse({
                success: false,
                errorCode: error,
                errorMsg,
            }));
            return;
        }

        console.log('SUCCESS: Project deleted'.bgGreen.bold, {projectDir, deletedSessions, deletedMessages, deletedTasks, deletedMemories});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Project has been deleted!',
            deletedSessions,
            deletedMessages,
            deletedTasks,
            deletedMemories,
        }));
    } catch (error: any) {
        console.error('Controller Error: deleteProjectController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while deleting the project!',
        }));
    }
}

export {getAllSessionsController, getSessionController, getProjectsController, deleteSessionController, deleteProjectController};
