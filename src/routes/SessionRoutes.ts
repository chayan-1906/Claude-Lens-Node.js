import {Router} from "express";
import {getAllSessionsController, getProjectsController, getSessionController} from "../controllers/SessionController";

const router: Router = Router();

router.get('/', getAllSessionsController);
router.get('/:sessionId', getSessionController);
router.get('/projects', getProjectsController);

export default router;
