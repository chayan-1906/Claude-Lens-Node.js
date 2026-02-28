import {Router} from "express";
import {getAllConversationsController, getSessionController} from "../controllers/ConversationController";

const router: Router = Router();

router.get('/', getAllConversationsController);
router.get('/sessions/:sessionId', getSessionController);

export default router;
