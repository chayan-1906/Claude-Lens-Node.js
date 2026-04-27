import {Router} from "express";
import {searchController} from "../controllers/SearchController";

const router: Router = Router();

router.get('/', searchController);

export default router;