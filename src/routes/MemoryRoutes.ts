import {Router} from "express";
import {getAllMemoriesController, getMemoryController, deleteMemoryByProjectDirController} from "../controllers/MemoryController";

const router: Router = Router();

router.get('/', getAllMemoriesController);
router.get('/:projectDir', getMemoryController);
router.delete('/:projectDir', deleteMemoryByProjectDirController);

export default router;
