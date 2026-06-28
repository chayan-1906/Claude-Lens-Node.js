import {IPagination} from "./session";
import {IMemory} from "../models/Memory";

/** ------------- Constants and Type Aliases ------------- */



/** ------------- API response types ------------- */

export interface IGetAllMemoriesResponse {
    memories: IMemory[];
    pagination: IPagination;
}

export interface IGetMemoriesResponse {
    memories?: IMemory[];
    error?: string;
}

export interface IDeleteMemoryByProjectResponse {
    deletedMemories?: number;
    error?: string;
}


/** ------------- function params ------------- */

export interface IGetAllMemoriesParams {
    projectDir?: string;
    page?: number;
    limit?: number;
}

export interface IGetMemoriesParams {
    projectDir?: string;
}
