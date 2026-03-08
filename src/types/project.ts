/** ------------- Constants and Type Aliases ------------- */


/** ------------- API response types ------------- */

export interface IGetAllProjectsResponse {
    projects: string[];
}

export interface IDeleteProjectResponse {
    deletedSessions?: number;
    deletedMessages?: number;
    deletedTasks?: number;
    deletedMemories?: number;
    error?: string;
}


/** ------------- function params ------------- */

export interface IDeleteProjectParams {
    projectDir?: string;
}
