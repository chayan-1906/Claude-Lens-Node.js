import "colors";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import {IGetSessionParams} from "../types/session";
import {ESessionSource} from "../models/Session";
import SessionService from "../services/SessionService";
import {generateInvalidCode, generateNotFoundCode} from "../utils/generateErrorCodes";

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

export {getAllSessionsController, getSessionController, getProjectsController};
