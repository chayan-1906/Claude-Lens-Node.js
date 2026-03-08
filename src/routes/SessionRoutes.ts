import {Router} from "express";
import {deleteSessionController, getAllSessionsController, getSessionController} from "../controllers/SessionController";

const router: Router = Router();

router.get('/', getAllSessionsController);
router.get('/:sessionId', getSessionController);
router.delete('/:sessionId', deleteSessionController);

export default router;
