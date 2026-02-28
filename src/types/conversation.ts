import {IMessage} from "../models/Message";
import {IConversation} from "../models/Conversation";

/** ------------- Constants and Type Aliases ------------- */



/** ------------- API response types ------------- */

export interface IPagination {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

export interface IGetAllConversationsResponse {
    conversations: IConversation[];
    pagination: IPagination;
}

export interface IGetSessionResponse {
    conversation?: IConversation;
    messages?: IMessage[];
    error?: string;
}

export interface IGetProjectsResponse {
    projects: string[];
}

/** ------------- function params ------------- */

export interface IGetAllConversationsParams {
    title?: string;
    source?: string;
    projectDir?: string;
    page?: number;
    limit?: number;
}

export interface IGetSessionParams {
    sessionId: string;
}
