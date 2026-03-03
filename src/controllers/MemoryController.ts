import "colors";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import MemoryService from "../services/MemoryService";
import {generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";

const deleteMemoryByProjectDirController = async (req: Request, res: Response) => {
    console.info('Controller: deleteMemoryByProjectDirController started'.bgBlue.white.bold);

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

        const {deletedMemories, error} = await MemoryService.deleteMemoryByProjectDir(projectDir);
        if (error) {
            let errorMsg: string = 'Failed to delete memory!';
            let statusCode: number = 500;

            if (error === generateMissingCode('projectDir')) {
                statusCode = 400;
                errorMsg = 'projectDir is required!';
            } else if (error === generateNotFoundCode('memory')) {
                statusCode = 404;
                errorMsg = `No memory found for projectDir: ${projectDir}!`;
            }

            res.status(statusCode).send(new ApiResponse({
                success: false,
                errorCode: error,
                errorMsg,
            }));
            return;
        }

        console.log('SUCCESS: Memory deleted'.bgGreen.bold, {projectDir, deletedMemories});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Memory has been deleted!',
            deletedMemories,
        }));
    } catch (error: any) {
        console.error('Controller Error: deleteMemoryByProjectDirController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while deleting memory!',
        }));
    }
}

const getAllMemoriesController = async (req: Request, res: Response) => {
    console.info('Controller: getAllMemoriesController started'.bgBlue.white.bold);

    try {
        const {projectDir} = req.query as Record<string, string | undefined>;

        const page: number = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit: number = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));

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

export {getAllMemoriesController, deleteMemoryByProjectDirController};
