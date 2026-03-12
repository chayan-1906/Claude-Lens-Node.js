import {Router} from "express";
import {getFolderPathController} from "../controllers/FilePickerController";

const router: Router = Router();

router.get('/folder', getFolderPathController);

export default router;
