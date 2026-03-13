import "colors";
import {IPagination} from "../types/session";
import MemoryModel, {IMemory} from "../models/Memory";
import {NON_ALPHANUMERIC_REGEX} from "../utils/constants";
import {generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {IDeleteMemoryByProjectResponse, IGetAllMemoriesParams, IGetAllMemoriesResponse, IGetMemoriesParams, IGetMemoriesResponse} from "../types/memory";

class MemoryService {
    static async getAllMemories({projectDir, page = 1, limit = 20}: IGetAllMemoriesParams): Promise<IGetAllMemoriesResponse> {
        console.log('Service: MemoryService.getAllMemories called'.cyan.italic, {projectDir, page, limit});

        const filter: Record<string, unknown> = {};
        if (projectDir) {
            filter.projectDir = projectDir.replace(NON_ALPHANUMERIC_REGEX, '-');
        }

        const skip: number = (page - 1) * limit;

        console.debug('Service: filter:'.cyan, filter);
        const [memories, total]: [IMemory[], number] = await Promise.all([
            MemoryModel.find(filter)
                .sort({updatedAt: -1})
                .skip(skip)
                .limit(limit),
            MemoryModel.countDocuments(filter),
        ]);

        console.log('Database: Memories fetched'.cyan, memories.length);

        const pagination: IPagination = {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        };

        return {memories, pagination};
    }

    static async getMemories({projectDir}: IGetMemoriesParams): Promise<IGetMemoriesResponse> {
        console.log('Service: MemoryService.getMemories called'.cyan.italic, {projectDir});

        if (!projectDir) {
            return {error: generateMissingCode('projectDir')};
        }

        projectDir = projectDir.replace(NON_ALPHANUMERIC_REGEX, '-');
        const memories: IMemory[] = await MemoryModel.find({projectDir}).sort({updatedAt: -1});
        if (memories.length === 0) {
            return {error: generateNotFoundCode('memories')};
        }

        console.log('Database: Memories fetched'.cyan, memories.length);

        return {memories};
    }

    static async deleteMemoriesByProjectDir(projectDir: string): Promise<IDeleteMemoryByProjectResponse> {
        console.log('Service: MemoryService.deleteMemoriesByProjectDir called'.cyan.italic, projectDir);

        if (!projectDir) {
            return {error: generateMissingCode('projectDir')};
        }

        const {deletedCount} = await MemoryModel.deleteMany({projectDir});
        if (deletedCount === 0) {
            return {error: generateNotFoundCode('memories')};
        }

        console.log('Database: Memories deleted'.cyan, {projectDir, deletedMemories: deletedCount});

        return {deletedMemories: deletedCount};
    }
}

export default MemoryService;
