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
    getR2ConfigController,
    getSetupStatusController,
    mergePathMappingController,
    saveR2ConfigController,
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

// R2 config routes
router.get('/r2-config', getR2ConfigController);
router.post('/r2-config', saveR2ConfigController);

// Path mapping CRUD + merge routes
router.get('/path-mappings', getPathMappingsController);
router.post('/path-mappings', createPathMappingController);
router.put('/path-mappings/:mappingId', updatePathMappingController);
router.delete('/path-mappings/:mappingId', deletePathMappingController);
router.post('/path-mappings/:mappingId/merge', mergePathMappingController);

export default router;
