import {Router} from "express";
import {deleteProjectController, getAllProjectsController} from "../controllers/ProjectController";

const router: Router = Router();

router.get('/', getAllProjectsController);
router.delete('/:projectDir', deleteProjectController);

export default router;
