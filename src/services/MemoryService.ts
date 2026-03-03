import "colors";
import {IPagination} from "../types/session";
import MemoryModel, {IMemory} from "../models/Memory";
import {generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {IDeleteMemoryByProjectResponse, IGetAllMemoriesParams, IGetAllMemoriesResponse} from "../types/memory";

class MemoryService {
    static async getAllMemories({projectDir, page = 1, limit = 20}: IGetAllMemoriesParams): Promise<IGetAllMemoriesResponse> {
        console.log('Service: MemoryService.getAllMemories called'.cyan.italic, {projectDir, page, limit});

        const filter: Record<string, unknown> = {};
        if (projectDir) filter.projectDir = projectDir;

        const skip: number = (page - 1) * limit;

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

    static async deleteMemoryByProjectDir(projectDir: string): Promise<IDeleteMemoryByProjectResponse> {
        console.log('Service: MemoryService.deleteMemoryByProjectDir called'.cyan.italic, projectDir);

        if (!projectDir) {
            return {error: generateMissingCode('projectDir')};
        }

        const {deletedCount} = await MemoryModel.deleteMany({projectDir});
        if (deletedCount === 0) {
            return {error: generateNotFoundCode('memory')};
        }

        console.log('Database: Memory deleted'.cyan, {projectDir, deletedMemories: deletedCount});

        return {deletedMemories: deletedCount};
    }
}

export default MemoryService;
