import "colors";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import VoiceService from "../services/VoiceService";
import {generateMissingCode} from "../utils/generateErrorCodes";
import {getTtsSettings, saveTtsSettings} from "../utils/localConfig";

const transcribeController = async (req: Request, res: Response) => {
    console.info('Controller: transcribeController started'.bgBlue.white.bold);

    try {
        if (!req.file) {
            console.warn('Controller: No audio file in request'.yellow.bold);
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('audio'),
                errorMsg: 'No audio file provided. Send a file with field name "audio"!',
            }));
            return;
        }

        const {buffer, mimetype, originalname, size}: Express.Multer.File = req.file;
        console.log('Controller: Audio file received'.blue, {originalname, mimetype, size});

        const {transcript, rephrased, error} = await VoiceService.transcribeAndRephrase(buffer, originalname);
        if (error) {
            console.warn('Controller: Transcription returned error'.yellow.bold, {error});
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: error,
                errorMsg: 'Transcription produced empty result. Please try again with a longer recording!',
            }));
            return;
        }

        console.log('SUCCESS: Transcription completed'.bgGreen.bold, {transcript, rephrased});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Audio transcribed and rephrased successfully!',
            transcript,
            rephrased,
        }));
    } catch (error: any) {
        console.error('Controller Error: transcribeController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while processing the audio!',
        }));
    }
}

const speakController = async (req: Request, res: Response) => {
    console.info('Controller: speakController started'.bgBlue.white.bold);

    try {
        const text: string = req.body?.text;
        const voice: string = req.body?.voice ?? 'en-US-AriaNeural';
        const rate: number = Number(req.body?.rate ?? 1);

        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            console.warn('Controller: No text in request'.yellow.bold);
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: generateMissingCode('text'),
                errorMsg: 'No text provided for speech synthesis!',
            }));
            return;
        }

        const audioStream = await VoiceService.speak(text.trim(), voice, rate);

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked');

        audioStream.pipe(res);

        audioStream.on('error', (err: Error) => {
            console.error('Controller Error: TTS stream error'.red.bold, err);
            if (!res.headersSent) {
                res.status(500).send(new ApiResponse({
                    success: false,
                    errorMsg: 'Speech synthesis stream failed!',
                }));
            }
        });
    } catch (error: any) {
        console.error('Controller Error: speakController failed'.red.bold, error);
        if (!res.headersSent) {
            res.status(500).send(new ApiResponse({
                success: false,
                errorMsg: error.message || 'Something went wrong during speech synthesis!',
            }));
        }
    }
}

const getTtsSettingsController = (req: Request, res: Response) => {
    console.info('Controller: getTtsSettingsController started'.bgBlue.white.bold);

    try {
        const {voiceId, rate} = getTtsSettings();
        console.log('SUCCESS: TTS settings fetched'.bgGreen.bold, {voiceId, rate});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'TTS settings fetched successfully!',
            voiceId,
            rate,
        }));
    } catch (error: any) {
        console.error('Controller Error: getTtsSettingsController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while fetching TTS settings!',
        }));
    }
}

const saveTtsSettingsController = (req: Request, res: Response) => {
    console.info('Controller: saveTtsSettingsController started'.bgBlue.white.bold);

    try {
        const voiceId: string | undefined = req.body?.voiceId;
        const rate: number | undefined = req.body?.rate !== undefined ? Number(req.body.rate) : undefined;

        saveTtsSettings({voiceId, rate});

        console.log('SUCCESS: TTS settings saved'.bgGreen.bold, {voiceId, rate});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'TTS settings saved successfully!',
        }));
    } catch (error: any) {
        console.error('Controller Error: saveTtsSettingsController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong while saving TTS settings!',
        }));
    }
}

export {transcribeController, speakController, getTtsSettingsController, saveTtsSettingsController};
