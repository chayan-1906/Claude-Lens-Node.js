import "colors";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import VoiceService from "../services/VoiceService";
import {generateMissingCode} from "../utils/generateErrorCodes";

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

export {transcribeController};
