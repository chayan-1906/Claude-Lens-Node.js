import {ITask} from "../models/Task";
import {IPagination} from "./session";

/** ------------- Constants and Type Aliases ------------- */



/** ------------- API response types ------------- */

export interface IGetAllTasksResponse {
    tasks: ITask[];
    pagination: IPagination;
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

export interface IDeleteTasksBySessionParams {
    sessionId: string;
}
