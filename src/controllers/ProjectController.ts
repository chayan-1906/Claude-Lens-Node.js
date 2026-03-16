import "colors";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import {IDeleteProjectParams} from "../types/project";
import ProjectService from "../services/ProjectService";
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
        console.debug('DEBUG: Received params'.cyan, {projectDir});

        const {deletedSessions, deletedMessages, deletedTasks, deletedMemories, error} = await ProjectService.deleteProject({projectDir});
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

export {getAllProjectsController, deleteProjectController};
