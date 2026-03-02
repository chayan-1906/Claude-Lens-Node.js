import "colors";
import TaskModel from "../models/Task";
import {IDeleteTasksBySessionResponse} from "../types/task";
import {generateInvalidCode, generateNotFoundCode} from "../utils/generateErrorCodes";

class TaskService {
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
