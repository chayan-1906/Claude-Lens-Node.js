/** ------------- Constants and Type Aliases ------------- */

export interface IProject {
    rawProjectDir: string;
    projectDir: string;
    customName?: string;
    description?: string;
}

export interface IRenameProjectParams {
    projectDir: string;
    customName: string;
    description?: string;
}

export interface IRenameProjectResponse {
    project?: IProject;
    error?: string;
}


/** ------------- API response types ------------- */

export interface IGetAllProjectsResponse {
    projects: IProject[];
}

export interface IDeleteProjectResponse {
    deletedSessions?: number;
    deletedMessages?: number;
    deletedTasks?: number;
    deletedMemories?: number;
    deletedAttachments?: number;
    error?: string;
}


/** ------------- function params ------------- */

export interface IDeleteProjectParams {
    projectDir?: string;
    reclaimR2?: boolean;
}
