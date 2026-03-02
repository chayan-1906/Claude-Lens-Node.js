import "colors";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import TaskService from "../services/TaskService";
import {IDeleteTasksBySessionParams} from "../types/task";
import {generateInvalidCode, generateNotFoundCode} from "../utils/generateErrorCodes";

const deleteTasksBySessionIdController = async (req: Request, res: Response) => {
    console.info('Controller: deleteTasksBySessionIdController started'.bgBlue.white.bold);

    try {
        const {sessionId}: Partial<IDeleteTasksBySessionParams> = req.params;

        const {deletedTasks, error} = await TaskService.deleteTasksBySessionId(sessionId || '');
        if (error) {
            let errorMsg: string = 'Failed to delete tasks!';
            let statusCode: number = 500;

            if (error === generateInvalidCode('sessionId')) {
                statusCode = 400;
                errorMsg = `Invalid sessionId: ${sessionId}!`;
            } else if (error === generateNotFoundCode('tasks')) {
                statusCode = 404;
                errorMsg = `No tasks found for sessionId: ${sessionId}!`;
            }

            res.status(statusCode).send(new ApiResponse({
                success: false,
                errorCode: error,
                errorMsg,
            }));
            return;
        }

        console.log('SUCCESS: Tasks deleted'.bgGreen.bold, {sessionId, deletedTasks});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Tasks have been deleted!',
            deletedTasks,
        }));
    } catch (error: any) {
        console.error('Controller Error: deleteTasksBySessionIdController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while deleting tasks!',
        }));
    }
}

export {deleteTasksBySessionIdController};
