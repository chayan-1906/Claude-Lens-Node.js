import {Router} from "express";
import {
    activateConfigurationController,
    addConfigurationController,
    deleteConfigurationController,
    editConfigurationController,
    getConfigProjectsController,
    getConfigurationsController,
    getSetupStatusController,
    testConfigurationController,
} from "../controllers/SetupController";

const router: Router = Router();

router.get('/status', getSetupStatusController);

// Configuration CRUD routes
router.get('/configurations', getConfigurationsController);
router.post('/configurations', addConfigurationController);
router.put('/configurations/:configId', editConfigurationController);
router.delete('/configurations/:configId', deleteConfigurationController);
router.post('/configurations/:configId/test', testConfigurationController);
router.post('/configurations/:configId/activate', activateConfigurationController);
router.get('/configurations/:configId/projects', getConfigProjectsController);

export default router;
