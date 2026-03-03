import {Router} from "express";
import {getAllTasksController, deleteTasksBySessionIdController} from "../controllers/TaskController";

const router: Router = Router();

router.get('/', getAllTasksController);
router.delete('/:sessionId', deleteTasksBySessionIdController);

export default router;
