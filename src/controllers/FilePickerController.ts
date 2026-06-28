import "colors";
import {execSync} from "child_process";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";

/**
 * GET /api/v1/file-picker/folder
 * Opens the native macOS Finder folder picker via osascript and returns
 * the selected absolute path. execSync blocks the event loop while the
 * dialog is open — acceptable since the backend is single-user and local.
 */
const getFolderPathController = (req: Request, res: Response) => {
    console.info('Controller: getFolderPathController started'.bgBlue.white.bold);

    try {
        const folderPath: string = execSync(
            `osascript -e 'POSIX path of (choose folder with prompt "Select project directory")'`,
            {encoding: 'utf-8', timeout: 60000},
        ).trim();

        console.log('SUCCESS: Folder selected'.bgGreen.bold, {path: folderPath});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Folder selected!',
            path: folderPath,
        }));
    } catch (error: any) {
        // User cancelled the dialog or osascript failed
        console.log('Controller: getFolderPathController — cancelled or failed'.yellow, error);
        res.status(200).send(new ApiResponse({
            success: false,
            errorCode: null,
            errorMsg: 'User cancelled folder selection',
        }));
    }
}

export {getFolderPathController};
