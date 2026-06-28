import "colors";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import ProjectService from "../services/ProjectService";
import {IDeleteProjectParams, IRenameProjectParams} from "../types/project";
import {generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";

const getAllProjectsController = async (req: Request, res: Response) => {
    console.info('Controller: getAllProjectsController started'.bgBlue.white.bold);

    try {
        const {projects} = await ProjectService.getAllProjects();

        console.log('SUCCESS: Projects fetched'.bgGreen.bold, {projects: projects.length});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Projects have been fetched!',
            projects,
        }));
    } catch (error: any) {
        console.error('Controller Error: getAllProjectsController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while retrieving projects!',
        }));
    }
}

const deleteProjectController = async (req: Request, res: Response) => {
    console.info('Controller: deleteProjectController started'.bgBlue.white.bold);

    try {
        const {projectDir}: Partial<IDeleteProjectParams> = req.params;
        const {reclaimR2}: Partial<IDeleteProjectParams> = req.body ?? {};
        console.debug('DEBUG: Received params'.cyan, {projectDir, reclaimR2});

        const {deletedSessions, deletedMessages, deletedTasks, deletedMemories, deletedAttachments, error} = await ProjectService.deleteProject({projectDir, reclaimR2});
        if (error) {
            console.error('Failed to delete project:'.red.bold, error);
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

        console.log('SUCCESS: Project deleted'.bgGreen.bold, {projectDir, deletedSessions, deletedMessages, deletedTasks, deletedMemories, deletedAttachments});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Project has been deleted!',
            deletedSessions,
            deletedMessages,
            deletedTasks,
            deletedMemories,
            deletedAttachments,
        }));
    } catch (error: any) {
        console.error('Controller Error: deleteProjectController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while deleting the project!',
        }));
    }
}

const renameProjectController = async (req: Request, res: Response) => {
    console.info('Controller: renameProjectController started'.bgBlue.white.bold);

    try {
        const {projectDir}: Partial<IRenameProjectParams> = req.params;
        const {customName, description}: Partial<IRenameProjectParams> = req.body;
        console.debug('DEBUG: Received params'.cyan, {projectDir, customName, description});

        if (!projectDir) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorMsg: 'projectDir is required!',
            }));
            return;
        }
        if (!customName || customName.trim().length === 0) {
            res.status(400).send(new ApiResponse({
                success: false, 
                errorMsg: 'customName must be a non-empty string!',
            }));
            return;
        }
        if (customName.trim().length > 100) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorMsg: 'customName must be 100 characters or fewer!',
            }));
            return;
        }

        const {project, error} = await ProjectService.renameProject({projectDir, customName: customName.trim(), description});
        if (error) {
            console.error('Failed to rename project:'.red.bold, error);
            const statusCode: number = error === generateNotFoundCode('project') ? 404 : 500;
            const errorMsg: string = error === generateNotFoundCode('project')
                ? `No project found for projectDir: ${projectDir}!`
                : 'Failed to rename project!';
            res.status(statusCode).send(new ApiResponse({
                success: false,
                errorCode: error,
                errorMsg,
            }));
            return;
        }

        console.log('SUCCESS: Project renamed'.bgGreen.bold, {projectDir, customName});
        res.status(200).send(new ApiResponse({
            success: true, 
            message: 'Project has been renamed!',
            project,
        }));
    } catch (error: any) {
        console.error('Controller Error: renameProjectController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while renaming the project!',
        }));
    }
}

export {getAllProjectsController, deleteProjectController, renameProjectController};
