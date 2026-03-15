import {Router} from "express";
import {deleteSessionController, getAllSessionsController, getSessionController, stubMessagesController} from "../controllers/SessionController";

const router: Router = Router();

router.get('/', getAllSessionsController);
router.get('/:sessionId', getSessionController);
router.delete('/:sessionId', deleteSessionController);
router.patch('/:sessionId/messages/stub', stubMessagesController);

export default router;
