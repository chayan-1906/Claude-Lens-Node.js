import {Router} from "express";
import {getLocalProjectsController, syncController} from "../controllers/SyncController";

const router: Router = Router();

router.get('/projects', getLocalProjectsController);
router.post('/', syncController);

export default router;
