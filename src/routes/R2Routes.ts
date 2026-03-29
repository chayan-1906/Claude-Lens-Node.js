import {Router} from "express";
import {reclaimR2StorageController} from "../controllers/R2Controller";

const router: Router = Router();

router.post('/reclaim', reclaimR2StorageController);

export default router;
