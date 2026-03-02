/** ------------- Constants and Type Aliases ------------- */



/** ------------- API response types ------------- */

export interface IDeleteTasksBySessionResponse {
    deletedTasks?: number;
    error?: string;
}


/** ------------- function params ------------- */

export interface IDeleteTasksBySessionParams {
    sessionId: string;
}
