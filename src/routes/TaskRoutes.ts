import {Router} from "express";
import {deleteTasksBySessionIdController} from "../controllers/TaskController";

const router: Router = Router();

router.delete('/:sessionId', deleteTasksBySessionIdController);

export default router;
