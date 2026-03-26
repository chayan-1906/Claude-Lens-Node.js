import "colors";
import fs from "fs";
import path from "path";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import {ESessionSource} from "../models/Session";
import SessionService from "../services/SessionService";
import {resolveLocalPath, toProjectDirHash} from "../utils/resolveProjectDir";
import {generateInvalidCode, generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {IDeleteSessionParams, IGetSessionParams, IStubMessagesParams, IUpdateSessionParams} from "../types/session";

const VALID_SOURCES: string[] = Object.values(ESessionSource);

const getAllSessionsController = async (req: Request, res: Response) => {
    console.info('Controller: getAllSessionsController started'.bgBlue.white.bold);

    try {
        const {title, source, projectDir} = req.query as Record<string, string | undefined>;
        const page: number = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit: number = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        console.debug('DEBUG: Received query params'.cyan, {title, source, projectDir, page, limit});

        if (source !== undefined && !VALID_SOURCES.includes(source)) {
            console.warn('WARN: Invalid source filter'.yellow.bold, {source, validSources: VALID_SOURCES});
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateInvalidCode('source'),
                errorMsg: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}`,
            }));
            return;
        }

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
        console.debug('DEBUG: Received params'.cyan, {sessionId});

        const {session, messages, error} = await SessionService.getSessionBySessionId(sessionId || '');
        if (error || !session || !messages) {
            console.warn('WARN: SessionService.getSessionBySessionId returned error'.yellow.bold, {error, sessionId});
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

        // Check if the local JSONL file exists on disk for this session
        const localRawProjectDir: string = resolveLocalPath(session.rawProjectDir);
        const localProjectDirHash: string = toProjectDirHash(localRawProjectDir);
        const jsonlPath: string = path.join(process.env.HOME || '~', '.claude', 'projects', localProjectDirHash, `${session.sessionId}.jsonl`);
        const localJsonlAvailable: boolean = fs.existsSync(jsonlPath);

        console.log('SUCCESS: Session fetched'.bgGreen.bold, {sessionId, localJsonlAvailable});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Session has been fetched!',
            session,
            messages,
            localJsonlAvailable,
        }));
    } catch (error: any) {
        console.error('Controller Error: getSessionController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while retrieving the session!',
        }));
    }
}

const updateSessionController = async (req: Request, res: Response) => {
    console.info('Controller: updateSessionController started'.bgBlue.white.bold);

    try {
        const {sessionId}: Partial<IUpdateSessionParams> = req.params;
        const {title, description}: Partial<IUpdateSessionParams> = req.body;
        console.debug('DEBUG: Received params'.cyan, {sessionId, title, description});

        const {session, error} = await SessionService.updateSession({sessionId, title, description});
        if (error || !session) {
            console.warn('WARN: SessionService.updateSession returned error'.yellow.bold, {error, sessionId});
            let errorMsg: string = 'Failed to update session!';
            let statusCode: number = 500;

            if (error === generateInvalidCode('sessionId')) {
                statusCode = 400;
                errorMsg = `Invalid sessionId: ${sessionId}!`;
            } else if (error === generateInvalidCode('title')) {
                statusCode = 400;
                errorMsg = 'Title must be non-empty and at most 100 characters!';
            } else if (error === generateInvalidCode('description')) {
                statusCode = 400;
                errorMsg = 'Description must be at most 500 characters!';
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

        console.log('SUCCESS: Session updated'.bgGreen.bold, {sessionId});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Session has been updated!',
            session,
        }));
    } catch (error: any) {
        console.error('Controller Error: updateSessionController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while updating the session!',
        }));
    }
}

const deleteSessionController = async (req: Request, res: Response) => {
    console.info('Controller: deleteSessionController started'.bgBlue.white.bold);

    try {
        const {sessionId}: Partial<IDeleteSessionParams> = req.params;
        console.debug('DEBUG: Received params'.cyan, {sessionId});

        const {deletedSessions, deletedMessages, deletedAttachments, error} = await SessionService.deleteSession({sessionId});
        if (error) {
            console.warn('WARN: SessionService.deleteSession returned error'.yellow.bold, {error, sessionId});
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

        console.log('SUCCESS: Session deleted'.bgGreen.bold, {sessionId, deletedSessions, deletedMessages, deletedAttachments});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Session has been deleted!',
            deletedSessions,
            deletedMessages,
            deletedAttachments,
        }));
    } catch (error: any) {
        console.error('Controller Error: deleteSessionController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while deleting the session!',
        }));
    }
}

const stubMessagesController = async (req: Request, res: Response) => {
    console.info('Controller: stubMessagesController started'.bgBlue.white.bold);

    try {
        const {sessionId}: Partial<IStubMessagesParams> = req.params;
        const {messageIds}: Partial<IStubMessagesParams> = req.body;
        console.debug('DEBUG: Received params'.cyan, {sessionId, messageIdsCount: messageIds?.length ?? 0});

        const {stubbedCount, diskUpdated, error} = await SessionService.stubMessages({sessionId, messageIds: messageIds ?? []});
        if (error) {
            console.warn('WARN: SessionService.stubMessages returned error'.yellow.bold, {error, sessionId});
            let errorMsg: string = 'Failed to stub messages!';
            let statusCode: number = 500;

            if (error === generateInvalidCode('sessionId')) {
                statusCode = 400;
                errorMsg = `Invalid sessionId: ${sessionId}!`;
            } else if (error === generateMissingCode('messageIds')) {
                statusCode = 400;
                errorMsg = 'messageIds array is required!';
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

        console.log('SUCCESS: Messages stubbed'.bgGreen.bold, {sessionId, stubbedCount, diskUpdated});
        res.status(200).send(new ApiResponse({
            success: true,
            message: `${stubbedCount} message(s) stubbed successfully!`,
            stubbedCount,
            diskUpdated,
        }));
    } catch (error: any) {
        console.error('Controller Error: stubMessagesController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while stubbing messages!',
        }));
    }
}

export {getAllSessionsController, getSessionController, deleteSessionController, updateSessionController, stubMessagesController};
