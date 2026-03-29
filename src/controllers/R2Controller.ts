import "colors";
import {Request, Response} from "express";
import SessionModel from "../models/Session";
import {ApiResponse} from "../utils/ApiResponse";
import {IReclaimR2StorageParams} from "../types/r2";
import {generateMissingCode} from "../utils/generateErrorCodes";
import {deleteSessionAttachments, isR2Configured} from "../utils/r2";

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

        let deletedAttachments: number = 0;

        if (sessionId) {
            deletedAttachments = await deleteSessionAttachments(sessionId);
        } else if (projectDir) {
            const sessions = await SessionModel.find({projectDir}, {sessionId: 1}).lean();
            for (const session of sessions) {
                deletedAttachments += await deleteSessionAttachments(session.sessionId);
            }
        }

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
