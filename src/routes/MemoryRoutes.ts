import {Router} from "express";
import {getAllMemoriesController, deleteMemoryByProjectDirController} from "../controllers/MemoryController";

const router: Router = Router();

router.get('/', getAllMemoriesController);
router.delete('/', deleteMemoryByProjectDirController);

export default router;
