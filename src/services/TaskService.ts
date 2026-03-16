import "colors";
import {IPagination} from "../types/session";
import TaskModel, {ITask} from "../models/Task";
import {generateInvalidCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {IDeleteTasksBySessionParams, IDeleteTasksBySessionResponse, IGetAllTasksParams, IGetAllTasksResponse, IGetTaskParams, IGetTaskResponse} from "../types/task";

class TaskService {
    static async getAllTasks({sessionId, page = 1, limit = 20}: IGetAllTasksParams): Promise<IGetAllTasksResponse> {
        console.log('Service: TaskService.getAllTasks called'.cyan.italic, {sessionId, page, limit});

        const filter: Record<string, unknown> = {};
        if (sessionId) filter.sessionId = sessionId;

        const skip: number = (page - 1) * limit;

        const [tasks, total]: [ITask[], number] = await Promise.all([
            TaskModel.find(filter)
                .sort({updatedAt: -1})
                .skip(skip)
                .limit(limit),
            TaskModel.countDocuments(filter),
        ]);

        console.log('Database: Tasks fetched'.cyan, tasks.length);

        const pagination: IPagination = {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        };

        return {tasks, pagination};
    }

    static async getTask({sessionId, taskId}: IGetTaskParams): Promise<IGetTaskResponse> {
        console.log('Service: TaskService.getTask called'.cyan.italic, {sessionId, taskId});

        if (!sessionId) {
            console.debug('DEBUG: Missing sessionId, returning error'.cyan);
            return {error: generateInvalidCode('sessionId')};
        }
        if (!taskId) {
            console.debug('DEBUG: Missing taskId, returning error'.cyan);
            return {error: generateInvalidCode('taskId')};
        }

        const task: ITask | null = await TaskModel.findOne({sessionId, taskId});
        if (!task) {
            console.debug('DEBUG: Task not found'.cyan, {sessionId, taskId});
            return {error: generateNotFoundCode('task')};
        }

        console.log('Database: Task fetched'.cyan, {sessionId, taskId});

        return {task};
    }

    static async deleteTasksBySessionId({sessionId}: IDeleteTasksBySessionParams): Promise<IDeleteTasksBySessionResponse> {
        console.log('Service: TaskService.deleteTasksBySessionId called'.cyan.italic, {sessionId});

        if (!sessionId) {
            console.debug('DEBUG: Missing sessionId, returning error'.cyan);
            return {error: generateInvalidCode('sessionId')};
        }

        const {deletedCount} = await TaskModel.deleteMany({sessionId});
        if (deletedCount === 0) {
            console.debug('DEBUG: No tasks found to delete'.cyan, {sessionId});
            return {error: generateNotFoundCode('tasks')};
        }

        console.log('Database: Tasks deleted'.cyan, {sessionId, deletedTasks: deletedCount});

        return {deletedTasks: deletedCount};
    }
}

export default TaskService;
