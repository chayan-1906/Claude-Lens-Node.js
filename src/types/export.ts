import {Archiver} from "archiver";

/** ------------- Constants and Type Aliases ------------- */

/** Shape of a single session entry inside manifest.json */
export interface IManifestSessionEntry {
    sessionId: string;
    title: string;
    aiModel?: string;
    gitBranch?: string;
    file: string;
}

/** Shape of the manifest.json included at ZIP root */
export interface IExportManifest {
    exportedAt: string;
    claudeLensVersion: string;
    projectDir: string;
    claudeNativeFolderName: string;
    totalSessions: number;
    totalMemoryFiles: number;
    totalTasks: number;
    sessions: IManifestSessionEntry[];
}


/** ------------- API response types ------------- */

/** Summary returned by ExportService after ZIP assembly */
export interface IExportResult {
    totalSessions: number;
    totalMemoryFiles: number;
    totalTasks: number;
    error?: string;
}


/** ------------- function params ------------- */

export interface IExportParams {
    projectDir: string;
    sessionId?: string;
}

export interface IExportServiceParams extends IExportParams {
    archive: Archiver;
    rawProjectDir: string;
}
