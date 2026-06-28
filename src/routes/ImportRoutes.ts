import {Router} from "express";
import {importProjectController, uploadZip} from "../controllers/ImportController";

const router: Router = Router();

router.post('/', uploadZip, importProjectController);

export default router;
