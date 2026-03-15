import {IMessage} from "../models/Message";
import {ISession} from "../models/Session";

/** ------------- Constants and Type Aliases ------------- */



/** ------------- API response types ------------- */

export interface IPagination {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

export interface IGetAllSessionsResponse {
    sessions: ISession[];
    pagination: IPagination;
}

export interface IGetSessionResponse {
    session?: ISession;
    messages?: IMessage[];
    error?: string;
}

export interface IDeleteSessionResponse {
    deletedSessions?: number;
    deletedTasks?: number;
    deletedMessages?: number;
    error?: string;
}


/** ------------- function params ------------- */

export interface IGetAllSessionsParams {
    title?: string;
    source?: string;
    projectDir?: string;
    page?: number;
    limit?: number;
}

export interface IGetSessionParams {
    sessionId?: string;
}

export interface IDeleteSessionParams {
    sessionId?: string;
}

export interface IStubMessagesParams {
    sessionId?: string;
    messageIds: string[];
}

export interface IStubMessagesResponse {
    stubbedCount?: number;
    diskUpdated?: boolean;
    error?: string;
}
