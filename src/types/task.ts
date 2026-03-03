import {ITask} from "../models/Task";
import {IPagination} from "./session";

/** ------------- Constants and Type Aliases ------------- */


/** ------------- API response types ------------- */

export interface IGetAllTasksResponse {
    tasks: ITask[];
    pagination: IPagination;
}

export interface IGetTaskResponse {
    task?: ITask;
    error?: string;
}

export interface IDeleteTasksBySessionResponse {
    deletedTasks?: number;
    error?: string;
}


/** ------------- function params ------------- */

export interface IGetAllTasksParams {
    sessionId?: string;
    page?: number;
    limit?: number;
}

export interface IGetTaskParams {
    sessionId?: string;
    taskId?: string;
}

export interface IDeleteTasksBySessionParams {
    sessionId?: string;
}
