import {Router} from "express";
import {getAllTasksController, getTaskController, deleteTasksBySessionIdController} from "../controllers/TaskController";

const router: Router = Router();

router.get('/', getAllTasksController);
router.get('/:sessionId/:taskId', getTaskController);
router.delete('/:sessionId', deleteTasksBySessionIdController);

export default router;
