import "colors";
import MemoryModel from "../models/Memory";
import {IDeleteMemoryByProjectResponse} from "../types/memory";
import {generateMissingCode, generateNotFoundCode} from "../utils/generateErrorCodes";

class MemoryService {
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
