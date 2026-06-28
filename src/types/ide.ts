/** ------------- Constants and Type Aliases ------------- */

/**
 * Raw JSON content of a JetBrains IDE lock file.
 * Port is NOT included — it is encoded in the filename (e.g., "51735.lock").
 */
export interface IIdeLockFileJson {
    authToken: string;
    ideName: string;
    workspaceFolders?: string[];
    pid?: number;
    transport?: string;
    runningInWindows?: boolean;
}

/** Assembled lock file info — port extracted from filename, rest from JSON content */
export interface IIdeLockFile {
    port: number;
    authToken: string;
    ideName: string;
}

/** Pending RPC call waiting for a response */
export interface IPendingCall {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

export type IdeEventCallback = (event: Record<string, unknown>) => void;
