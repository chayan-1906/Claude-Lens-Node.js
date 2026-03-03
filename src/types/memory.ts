import {IMemory} from "../models/Memory";
import {IPagination} from "./session";

/** ------------- Constants and Type Aliases ------------- */



/** ------------- API response types ------------- */

export interface IGetAllMemoriesResponse {
    memories: IMemory[];
    pagination: IPagination;
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
