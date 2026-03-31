import "colors";
import {Request, Response} from "express";
import {IR2Config} from "../types/setup";
import MessageModel from "../models/Message";
import SessionModel from "../models/Session";
import {ApiResponse} from "../utils/ApiResponse";
import {getR2Config} from "../utils/localConfig";
import {IReclaimR2StorageParams} from "../types/r2";
import {generateMissingCode} from "../utils/generateErrorCodes";
import {deleteAttachmentsByUrls, isR2Configured} from "../utils/r2";

const reclaimR2StorageController = async (req: Request, res: Response) => {
    console.info('Controller: reclaimR2StorageController started'.bgBlue.white.bold);

    try {
        const {sessionId, projectDir}: Partial<IReclaimR2StorageParams> = req.body;
        console.debug('DEBUG: Received params'.cyan, {sessionId, projectDir});

        if (!sessionId && !projectDir) {
            console.warn('WARN: Neither sessionId nor projectDir provided'.yellow.bold);
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('sessionId or projectDir'),
                errorMsg: 'Either sessionId or projectDir is required!',
            }));
            return;
        }

        if (!isR2Configured()) {
            console.warn('WARN: R2 is not configured'.yellow.bold);
            res.status(400).send(new ApiResponse({
                success: false,
                errorMsg: 'R2 storage is not configured!',
            }));
            return;
        }

        const config: IR2Config = getR2Config()!;
        const urlsToDelete: string[] = [];

        if (sessionId) {
            const session = await SessionModel.findOne({sessionId}, {_id: 1}).lean();
            if (session) {
                const userMessages = await MessageModel.find(
                    {sessionInternalId: session._id, role: 'user'},
                    {content: 1},
                ).lean();
                for (const msg of userMessages) {
                    if (!Array.isArray(msg.content)) continue;
                    for (const block of msg.content as Record<string, unknown>[]) {
                        if ((block.type === 'image' || block.type === 'document') &&
                            (block.source as Record<string, unknown>)?.type === 'url') {
                            const url: unknown = (block.source as Record<string, unknown>).url;
                            if (typeof url === 'string') urlsToDelete.push(url);
                        } else if (block.type === 'text' && typeof block.text === 'string') {
                            // Text/code file references: "File attached: <name> — <url>"
                            const parts: string[] = block.text.split(' — ');
                            if (parts.length >= 2 && parts[0].startsWith('File attached:')) {
                                urlsToDelete.push(parts[parts.length - 1]);
                            }
                        }
                    }
                }
            }
            // JSONL backup stored at a deterministic key — include for full storage reclaim
            urlsToDelete.push(`${config.publicUrl}/${sessionId}/${sessionId}.jsonl`);
        } else if (projectDir) {
            // Collect attachment URLs from all sessions in this project
            const sessions = await SessionModel.find({projectDir}, {_id: 1, sessionId: 1}).lean();
            if (sessions.length) {
                const sessionInternalIds = sessions.map(session => session._id);
                const userMessages = await MessageModel.find(
                    {sessionInternalId: {$in: sessionInternalIds}, role: 'user'},
                    {content: 1},
                ).lean();
                for (const msg of userMessages) {
                    if (!Array.isArray(msg.content)) continue;
                    for (const block of msg.content as Record<string, unknown>[]) {
                        if ((block.type === 'image' || block.type === 'document') &&
                            (block.source as Record<string, unknown>)?.type === 'url') {
                            const url: unknown = (block.source as Record<string, unknown>).url;
                            if (typeof url === 'string') urlsToDelete.push(url);
                        } else if (block.type === 'text' && typeof block.text === 'string') {
                            // Text/code file references: "File attached: <name> — <url>"
                            const parts: string[] = block.text.split(' — ');
                            if (parts.length >= 2 && parts[0].startsWith('File attached:')) {
                                urlsToDelete.push(parts[parts.length - 1]);
                            }
                        }
                    }
                }
                // JSONL backups for all sessions in this project
                sessions.forEach(session => urlsToDelete.push(`${config.publicUrl}/${session.sessionId}/${session.sessionId}.jsonl`));
            }
        }

        const deletedAttachments: number = await deleteAttachmentsByUrls(urlsToDelete);

        console.log('SUCCESS: R2 storage reclaimed'.bgGreen.bold, {sessionId, projectDir, deletedAttachments});
        res.status(200).send(new ApiResponse({
            success: true,
            message: `Deleted ${deletedAttachments} attachment(s) from R2!`,
            deletedAttachments,
        }));
    } catch (error: any) {
        console.error('Controller Error: reclaimR2StorageController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while reclaiming R2 storage!',
        }));
    }
}

export {reclaimR2StorageController};
