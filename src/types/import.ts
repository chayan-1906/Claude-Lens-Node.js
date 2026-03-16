/** ------------- Constants and Type Aliases ------------- */

/** Shape of a single line in an exported .jsonl session file */
export interface IJsonlLine {
    type: 'user' | 'assistant';
    parentUuid: string | null;
    isSidechain: boolean;
    message: {
        role: 'user' | 'assistant';
        content: string | Record<string, unknown>[];
    };
    uuid: string;
    timestamp: string;
    sessionId: string;
    cwd: string;
    gitBranch: string;
    userType: string;
    version?: number;
    tokenUsage?: {
        input: number;
        output: number;
    };
}


/** ------------- API response types ------------- */

/** Summary returned by ImportService after ZIP processing */
export interface IImportResult {
    totalSessions: number;
    totalMessages: number;
    totalMemoryFiles: number;
    totalTasks: number;
}


/** ------------- function params ------------- */

export interface IImportServiceParams {
    zipBuffer: Buffer;
    remappedProjectDir?: string;
}
