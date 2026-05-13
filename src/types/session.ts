import {IAttachmentMeta} from "./ws";
import {ISession} from "../models/Session";
import {ContentBlock, IMessage} from "../models/Message";

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

export interface IGeneratePdfParams {
    sessionId?: string;
    includeThinking?: boolean;
    includeTools?: boolean;
}

export interface IGeneratePdfResponse {
    pdfBuffer?: Buffer;
    filename?: string;
    error?: string;
}

export interface IPdfRenderOptions {
    includeThinking: boolean;
    includeTools: boolean;
}

export type TPdfTextBlock = Extract<ContentBlock, {type: 'text'}>;
export type TPdfThinkingBlock = Extract<ContentBlock, {type: 'thinking'}>;
export type TPdfToolUseBlock = Extract<ContentBlock, {type: 'tool_use'}>;
export type TPdfToolResultBlock = Extract<ContentBlock, {type: 'tool_result'}>;

export interface IPdfUserContentExtract {
    bodyText: string;
    derivedAttachments: IAttachmentMeta[];
    toolResultBlocks: TPdfToolResultBlock[];
}
