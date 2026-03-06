import {Router} from "express";
import {getSetupStatusController, setupController} from "../controllers/SetupController";

const router: Router = Router();

router.get('/status', getSetupStatusController);
router.post('/', setupController);

export default router;