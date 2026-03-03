import "colors";
import {IPagination} from "../types/session";
import TaskModel, {ITask} from "../models/Task";
import {generateInvalidCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {IDeleteTasksBySessionResponse, IGetAllTasksParams, IGetAllTasksResponse} from "../types/task";

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

    static async deleteTasksBySessionId(sessionId: string): Promise<IDeleteTasksBySessionResponse> {
        console.log('Service: TaskService.deleteTasksBySessionId called'.cyan.italic, sessionId);

        if (!sessionId) {
            return {error: generateInvalidCode('sessionId')};
        }

        const {deletedCount} = await TaskModel.deleteMany({sessionId});
        if (deletedCount === 0) {
            return {error: generateNotFoundCode('tasks')};
        }

        console.log('Database: Tasks deleted'.cyan, {sessionId, deletedTasks: deletedCount});

        return {deletedTasks: deletedCount};
    }
}

export default TaskService;
