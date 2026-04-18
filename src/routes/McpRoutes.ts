import {Router} from "express";
import {getMcpServersController} from "../controllers/McpController";

const router: Router = Router();

router.get('/servers', getMcpServersController);

export default router;
