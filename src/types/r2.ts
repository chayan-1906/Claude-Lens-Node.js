/** ------------- Constants and Type Aliases ------------- */



/** ------------- API response types ------------- */

export interface IReclaimR2StorageResponse {
    deletedAttachments?: number;
    error?: string;
}


/** ------------- function params ------------- */

export interface IReclaimR2StorageParams {
    sessionId?: string;
    projectDir?: string;
}
