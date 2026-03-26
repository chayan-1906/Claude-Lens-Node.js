import {Router} from "express";
import {
    activateConfigurationController,
    addConfigurationController,
    createPathMappingController,
    deleteConfigurationController,
    deletePathMappingController,
    editConfigurationController,
    getConfigProjectsController,
    getConfigurationsController,
    getPathMappingsController,
    getSetupStatusController,
    mergePathMappingController,
    testConfigurationController,
    updatePathMappingController,
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

// Path mapping CRUD + merge routes
router.get('/path-mappings', getPathMappingsController);
router.post('/path-mappings', createPathMappingController);
router.put('/path-mappings/:mappingId', updatePathMappingController);
router.delete('/path-mappings/:mappingId', deletePathMappingController);
router.post('/path-mappings/:mappingId/merge', mergePathMappingController);

export default router;
