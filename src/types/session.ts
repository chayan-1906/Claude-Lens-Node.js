import {IMessage} from "../models/Message";
import {ISession} from "../models/Session";

/** ------------- Constants and Type Aliases ------------- */

export interface IGetSessionPagination {
    limit: number;
    totalCount: number;
    hasMore: boolean;
    nextCursor: string | null;
}


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
    pagination?: IGetSessionPagination;
    error?: string;
}

export interface IUpdateSessionResponse {
    session?: ISession;
    error?: string;
}

export interface IDeleteSessionResponse {
    deletedSessions?: number;
    deletedTasks?: number;
    deletedMessages?: number;
    deletedAttachments?: number;
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
    limit?: number;
    cursor?: string;
}

export interface IUpdateSessionParams {
    sessionId?: string;
    title?: string;
    description?: string;
}

export interface IDeleteSessionParams {
    sessionId?: string;
    reclaimR2?: boolean;
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
