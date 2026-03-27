import multer from "multer";
import {Router} from "express";
import {speakController, transcribeController} from "../controllers/VoiceController";

const router: Router = Router();
const upload: multer.Multer = multer({storage: multer.memoryStorage()});

router.post('/transcribe', upload.single('audio'), transcribeController);
router.post('/speak', speakController);

export default router;
