import {Router} from "express";
import {getAllMemoriesController, getMemoriesController, deleteMemoriesByProjectDirController} from "../controllers/MemoryController";

const router: Router = Router();

router.get('/', getAllMemoriesController);
router.get('/:projectDir', getMemoriesController);
router.delete('/:projectDir', deleteMemoriesByProjectDirController);

export default router;
