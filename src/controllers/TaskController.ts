import "colors";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import TaskService from "../services/TaskService";
import {IDeleteTasksBySessionParams, IGetTaskParams} from "../types/task";
import {generateInvalidCode, generateNotFoundCode} from "../utils/generateErrorCodes";

const getAllTasksController = async (req: Request, res: Response) => {
    console.info('Controller: getAllTasksController started'.bgBlue.white.bold);

    try {
        const {sessionId} = req.query as Record<string, string | undefined>;

        const page: number = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit: number = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
        console.debug('DEBUG: Received query params'.cyan, {sessionId: sessionId ?? 'all', page, limit});

        const {tasks, pagination} = await TaskService.getAllTasks({sessionId, page, limit});

        console.log('SUCCESS: Tasks fetched'.bgGreen.bold, {tasks: tasks.length});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Tasks have been fetched!',
            tasks,
            pagination,
        }));
    } catch (error: any) {
        console.error('Controller Error: getAllTasksController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while retrieving tasks!',
        }));
    }
}

const getTaskController = async (req: Request, res: Response) => {
    console.info('Controller: getTaskController started'.bgBlue.white.bold);

    try {
        const {sessionId, taskId}: Partial<IGetTaskParams> = req.params;
        console.debug('DEBUG: Received params'.cyan, {sessionId, taskId});

        const {task, error} = await TaskService.getTask({sessionId, taskId});
        if (error || !task) {
            console.warn('WARN: TaskService.getTask returned error'.yellow.bold, {error, sessionId, taskId});
            let errorMsg: string = 'Failed to retrieve task!';
            let statusCode: number = 500;

            if (error === generateInvalidCode('sessionId')) {
                statusCode = 400;
                errorMsg = `Invalid sessionId: ${sessionId}!`;
            } else if (error === generateInvalidCode('taskId')) {
                statusCode = 400;
                errorMsg = `Invalid taskId: ${taskId}!`;
            } else if (error === generateNotFoundCode('task')) {
                statusCode = 404;
                errorMsg = `No task found for sessionId: ${sessionId}, taskId: ${taskId}!`;
            }

            res.status(statusCode).send(new ApiResponse({
                success: false,
                errorCode: error,
                errorMsg,
            }));
            return;
        }

        console.log('SUCCESS: Task fetched'.bgGreen.bold, {sessionId, taskId});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Task has been fetched!',
            task,
        }));
    } catch (error: any) {
        console.error('Controller Error: getTaskController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while retrieving the task!',
        }));
    }
}

const deleteTasksBySessionIdController = async (req: Request, res: Response) => {
    console.info('Controller: deleteTasksBySessionIdController started'.bgBlue.white.bold);

    try {
        const {sessionId}: Partial<IDeleteTasksBySessionParams> = req.params;
        console.debug('DEBUG: Received params'.cyan, {sessionId});

        const {deletedTasks, error} = await TaskService.deleteTasksBySessionId({sessionId});
        if (error) {
            console.warn('WARN: TaskService.deleteTasksBySessionId returned error'.yellow.bold, {error, sessionId});
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

export {getAllTasksController, getTaskController, deleteTasksBySessionIdController};
