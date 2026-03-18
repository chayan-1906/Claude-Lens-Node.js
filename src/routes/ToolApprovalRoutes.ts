import {Router} from "express";
import {toolApprovalController} from "../controllers/ToolApprovalController";

const router: Router = Router();

router.post('/', toolApprovalController);

export default router;
