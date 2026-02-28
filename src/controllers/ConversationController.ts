import "colors";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import {IGetSessionParams} from "../types/conversation";
import {EConversationSource} from "../models/Conversation";
import ConversationService from "../services/ConversationService";
import {generateInvalidCode, generateNotFoundCode} from "../utils/generateErrorCodes";

const VALID_SOURCES: string[] = Object.values(EConversationSource);

const getAllConversationsController = async (req: Request, res: Response) => {
    console.info('Controller: getAllConversationsController started'.bgBlue.white.bold);

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

        const {conversations, pagination} = await ConversationService.getAllConversations({
            title,
            source,
            projectDir,
            page,
            limit,
        });

        console.log('SUCCESS: Conversations fetched'.bgGreen.bold, {conversations: conversations.length});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Conversations have been fetched!',
            conversations,
            pagination,
        }));
    } catch (error: any) {
        console.error('Controller Error: getAllConversationsController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while retrieving conversations!',
        }));
    }
}

const getSessionController = async (req: Request, res: Response) => {
    console.info('Controller: getSessionController started'.bgBlue.white.bold);

    try {
        const {sessionId}: Partial<IGetSessionParams> = req.params;

        const {conversation, messages, error} = await ConversationService.getSessionBySessionId(sessionId || '');
        if (error || !conversation || !messages) {
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
            conversation,
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

export {getAllConversationsController, getSessionController};
