import {Router} from "express";
import {exportProjectController} from "../controllers/ExportController";

const router: Router = Router();

router.get('/:projectDir', exportProjectController);

export default router;
