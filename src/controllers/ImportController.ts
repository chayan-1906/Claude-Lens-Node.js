import "colors";
import multer from "multer";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import ImportService from "../services/ImportService";

/** Multer configured for in-memory ZIP upload (50 MB limit) */
const upload: multer.Multer = multer({
    storage: multer.memoryStorage(),
    limits: {fileSize: 50 * 1024 * 1024},
    fileFilter: (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
        if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            console.warn('WARN: Rejected non-zip file upload'.yellow.bold, {originalname: file.originalname, mimetype: file.mimetype});
            cb(new Error('Only .zip files are accepted!'));
        }
    },
});

/** Multer middleware for single 'zip' field */
const uploadZip = upload.single('zip');

const importProjectController = async (req: Request, res: Response) => {
    console.info('Controller: importProjectController started'.bgBlue.white.bold);

    try {
        const file: Express.Multer.File | undefined = req.file;
        if (!file) {
            console.warn('WARN: No .zip file in request'.yellow.bold, file);
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: 'ZIP_MISSING',
                errorMsg: 'No .zip file provided!',
            }));
            return;
        }

        console.debug('DEBUG: Received file'.cyan, {originalname: file.originalname, size: file.size, mimetype: file.mimetype});

        const remappedProjectDir: string | undefined = req.body.projectDir as string | undefined;
        console.debug('DEBUG: remappedProjectDir'.cyan, {remappedProjectDir: remappedProjectDir ?? 'none (will use original)'});

        console.debug('DEBUG: Delegating to ImportService'.cyan);
        const {totalSessions, totalMessages, totalMemoryFiles, totalTasks} = await ImportService.importProject({
            zipBuffer: file.buffer,
            remappedProjectDir: remappedProjectDir || undefined,
        });

        console.log('SUCCESS: Import complete'.bgGreen.bold, {totalSessions, totalMessages, totalMemoryFiles, totalTasks});

        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Import completed successfully!',
            totalSessions,
            totalMessages,
            totalMemoryFiles,
            totalTasks,
        }));
    } catch (error: any) {
        console.error('Controller Error: importProjectController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while importing the project!',
        }));
    }
}

export {uploadZip, importProjectController};
