import {EMessageRole} from "../models/Message";
import {SessionLineType} from "../models/SessionLine";

/** ------------- Constants and Type Aliases ------------- */

export type SyncTarget = 'sessions' | 'tasks' | 'memories';

export const ALL_SYNC_TARGETS: SyncTarget[] = ['sessions', 'tasks', 'memories'];

export interface IParsedMessage {
    uuid: string;
    parentUuid?: string;
    startLineIndex: number;
    role: EMessageRole;
    content: string | Record<string, unknown>[];
    aiModel?: string;
    timestamp: Date;
    tokenUsage?: {
        input: number;
        output: number;
    };
    rawLines?: string[];   // original JSONL line(s) — lossless restore on resume
}

export interface IParsedSessionLine {
    sessionId: string;
    lineIndex: number;
    type: SessionLineType;
    line: string;
}

export interface IParsedFile {
    sessionId: string;
    projectDir: string;   // hashed version of cwd (e.g. -Users-padmanabhadas-my-project)
    rawProjectDir: string; // original cwd as-is (e.g. /Users/padmanabhadas/my-project)
    gitBranch?: string;
    slug?: string;
    aiModel?: string;
    title: string;
    messages: IParsedMessage[];
    sessionLines: IParsedSessionLine[];
    contextTokensUsed?: number;  // total input tokens from the latest result event
}

export interface RawTask {
    id: string;
    subject: string;
    description: string;
    activeForm?: string;
    status: string;
    blocks: string[];
    blockedBy: string[];
}


/** ------------- API response types ------------- */

export interface ISyncResponse {
    sessions?: {
        synced: number;
        newMessages: number;
        skipped: number;
        errors: number;
    };
    tasks?: {
        synced: number;
        updated: number;
    };
    memories?: {
        synced: number;
        updated: number;
    };
}

export interface ISyncTasksResponse {
    synced: number;
    updated: number;
}

export interface ISyncMemoriesResponse {
    synced: number;
    updated: number;
}


/** ------------- function params ------------- */

export interface ISyncParams {
    projectDirs?: string[];
    targets?: SyncTarget[];
}
