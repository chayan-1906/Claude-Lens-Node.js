import "colors";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import {IGetMemoriesParams} from "../types/memory";
import MemoryService from "../services/MemoryService";
import {generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";

const getAllMemoriesController = async (req: Request, res: Response) => {
    console.info('Controller: getAllMemoriesController started'.bgBlue.white.bold);

    try {
        const {projectDir} = req.query as Record<string, string | undefined>;

        const page: number = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit: number = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        console.debug('DEBUG: Received query params'.cyan, {projectDir: projectDir ?? 'all', page, limit});

        const {memories, pagination} = await MemoryService.getAllMemories({projectDir, page, limit});

        console.log('SUCCESS: Memories fetched'.bgGreen.bold, {memories: memories.length});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Memories have been fetched!',
            memories,
            pagination,
        }));
    } catch (error: any) {
        console.error('Controller Error: getAllMemoriesController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while retrieving memories!',
        }));
    }
}

const getMemoriesController = async (req: Request, res: Response) => {
    console.info('Controller: getMemoriesController started'.bgBlue.white.bold);

    try {
        const {projectDir}: Partial<IGetMemoriesParams> = req.params;
        console.debug('DEBUG: Received params'.cyan, {projectDir});

        const {memories, error} = await MemoryService.getMemories({projectDir});
        if (error || !memories) {
            console.warn('WARN: MemoryService.getMemories returned error'.yellow.bold, {error, projectDir});
            let errorMsg: string = 'Failed to retrieve memories!';
            let statusCode: number = 500;

            if (error === generateMissingCode('projectDir')) {
                statusCode = 400;
                errorMsg = 'projectDir is required!';
            } else if (error === generateNotFoundCode('memories')) {
                statusCode = 404;
                errorMsg = `No memories found for projectDir: ${projectDir}!`;
            }

            res.status(statusCode).send(new ApiResponse({
                success: false,
                errorCode: error,
                errorMsg,
            }));
            return;
        }

        console.log('SUCCESS: Memories fetched'.bgGreen.bold, {projectDir, count: memories.length});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Memories have been fetched!',
            memories,
        }));
    } catch (error: any) {
        console.error('Controller Error: getMemoriesController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while retrieving memories!',
        }));
    }
}

const deleteMemoriesByProjectDirController = async (req: Request, res: Response) => {
    console.info('Controller: deleteMemoriesByProjectDirController started'.bgBlue.white.bold);

    try {
        const {projectDir}: Partial<IGetMemoriesParams> = req.params;
        console.debug('DEBUG: Received params'.cyan, {projectDir});

        if (!projectDir) {
            console.warn('WARN: Missing projectDir param'.yellow.bold);
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('projectDir'),
                errorMsg: 'projectDir query parameter is required!',
            }));
            return;
        }

        const {deletedMemories, error} = await MemoryService.deleteMemoriesByProjectDir(projectDir);
        if (error) {
            console.warn('WARN: MemoryService.deleteMemoriesByProjectDir returned error'.yellow.bold, {error, projectDir});
            let errorMsg: string = 'Failed to delete memories!';
            let statusCode: number = 500;

            if (error === generateMissingCode('projectDir')) {
                statusCode = 400;
                errorMsg = 'projectDir is required!';
            } else if (error === generateNotFoundCode('memories')) {
                statusCode = 404;
                errorMsg = `No memories found for projectDir: ${projectDir}!`;
            }

            res.status(statusCode).send(new ApiResponse({
                success: false,
                errorCode: error,
                errorMsg,
            }));
            return;
        }

        console.log('SUCCESS: Memories deleted'.bgGreen.bold, {projectDir, deletedMemories});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Memories have been deleted!',
            deletedMemories,
        }));
    } catch (error: any) {
        console.error('Controller Error: deleteMemoriesByProjectDirController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while deleting memories!',
        }));
    }
}

export {getAllMemoriesController, getMemoriesController, deleteMemoriesByProjectDirController};
