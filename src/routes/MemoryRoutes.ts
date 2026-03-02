import {Router} from "express";
import {deleteMemoryByProjectDirController} from "../controllers/MemoryController";

const router: Router = Router();

router.delete('/', deleteMemoryByProjectDirController);

export default router;
