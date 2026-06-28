import "colors";
import path from "path";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import SyncService from "../services/SyncService";
import {ALL_SYNC_TARGETS, ISyncParams} from "../types/sync";
import {generateInvalidCode} from "../utils/generateErrorCodes";

const getLocalProjectsController = async (req: Request, res: Response) => {
    console.info('Controller: getLocalProjectsController started'.bgBlue.white.bold);

    try {
        const fullPaths: string[] = SyncService.getAllProjectDirs();

        console.log('SUCCESS: Local projects fetched'.bgGreen.bold, {projects: fullPaths.length});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Local projects have been fetched!',
            projects: fullPaths,
        }));
    } catch (error: any) {
        console.error('Controller Error: getLocalProjectsController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while retrieving local projects!',
        }));
    }
}

const syncController = async (req: Request, res: Response) => {
    console.info('Controller: syncController started'.bgBlue.white.bold);

    try {
        const {projectDirs, targets}: ISyncParams = req.body;
        console.debug('DEBUG: Received body'.cyan, {projectDirsCount: projectDirs?.length ?? 'all', targets: targets ?? 'all'});

        if (targets && targets.length > 0) {
            const invalid: string[] = targets.filter((t) => !ALL_SYNC_TARGETS.includes(t));
            if (invalid.length > 0) {
                console.warn('WARN: Invalid sync targets'.yellow.bold, {invalid, validTargets: ALL_SYNC_TARGETS});
                res.status(400).send(new ApiResponse({
                    success: false,
                    errorCode: generateInvalidCode('targets'),
                    errorMsg: `Invalid sync target(s): ${invalid.join(', ')}. Must be one of: ${ALL_SYNC_TARGETS.join(', ')}`,
                }));
                return;
            }
        }

        console.debug('DEBUG: Delegating to SyncService'.cyan);
        const {sessions, tasks, memories} = await SyncService.sync({projectDirs, targets});

        console.log('SUCCESS: Sync complete'.bgGreen.bold, {sessions, tasks, memories});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Sync complete!',
            sessions,
            tasks,
            memories,
        }));
    } catch (error: any) {
        console.error('Controller Error: syncController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong during sync!',
        }));
    }
}

export {getLocalProjectsController, syncController};
