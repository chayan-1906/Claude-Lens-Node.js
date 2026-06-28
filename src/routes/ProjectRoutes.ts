import {Router} from "express";
import {deleteProjectController, getAllProjectsController, renameProjectController} from "../controllers/ProjectController";

const router: Router = Router();

router.get('/', getAllProjectsController);
router.patch('/:projectDir', renameProjectController);
router.delete('/:projectDir', deleteProjectController);

export default router;
