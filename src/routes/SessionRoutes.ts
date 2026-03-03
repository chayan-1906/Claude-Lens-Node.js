import {Router} from "express";
import {deleteProjectController, deleteSessionController, getAllProjectsController, getAllSessionsController, getSessionController} from "../controllers/SessionController";

const router: Router = Router();

router.get('/', getAllSessionsController);
router.get('/projects', getAllProjectsController);
router.get('/:sessionId', getSessionController);
router.delete('/:sessionId', deleteSessionController);
router.delete('/projects', deleteProjectController);

export default router;
