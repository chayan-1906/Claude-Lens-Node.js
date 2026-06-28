import multer from "multer";
import {Router} from "express";
import {speakController, transcribeController, getTtsSettingsController, saveTtsSettingsController} from "../controllers/VoiceController";

const router: Router = Router();
const upload: multer.Multer = multer({storage: multer.memoryStorage()});

router.post('/transcribe', upload.single('audio'), transcribeController);
router.post('/speak', speakController);
router.get('/tts-settings', getTtsSettingsController);
router.put('/tts-settings', saveTtsSettingsController);

export default router;
