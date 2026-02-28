import {Router} from "express";
import {getAllConversationsController, getSessionController, getProjectsController} from "../controllers/ConversationController";

const router: Router = Router();

router.get('/', getAllConversationsController);
router.get('/sessions/:sessionId', getSessionController);
router.get('/projects', getProjectsController);

export default router;
