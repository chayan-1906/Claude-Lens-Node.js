import {Router} from "express";
import {getAllSessionsController, getProjectsController, getSessionController, deleteSessionController, deleteProjectController} from "../controllers/SessionController";

const router: Router = Router();

router.get('/', getAllSessionsController);
router.get('/:sessionId', getSessionController);
router.get('/projects', getProjectsController);
router.delete('/:sessionId', deleteSessionController);
router.delete('/projects', deleteProjectController);

export default router;
