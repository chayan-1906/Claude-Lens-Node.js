import "colors";
import Groq, {toFile} from "groq-sdk";
import {Transcription} from "groq-sdk/resources/audio";
import {GROQ_API_KEY} from "../config/config";
import {ITranscribeServiceResponse} from "../types/voice";
import {generateInvalidCode, generateMissingCode} from "../utils/generateErrorCodes";

const groq: Groq = new Groq({apiKey: GROQ_API_KEY});

const WHISPER_PRIMARY: string = 'whisper-large-v3-turbo';
const WHISPER_FALLBACK: string = 'whisper-large-v3';

/** Minimum buffer size (bytes) to be considered real audio.
 *  A WebM container with no audio data is ~200–500 bytes.
 *  A real recording of even 0.5s is typically 3–5KB. */
const MIN_AUDIO_BUFFER_SIZE: number = 1500;

class VoiceService {
    /** Attempt Whisper transcription with automatic fallback */
    private static async whisperTranscribe(file: File): Promise<{transcription: Transcription; model: string}> {
        try {
            console.log(`Service: Trying primary model (${WHISPER_PRIMARY})...`.cyan);
            const transcription: Transcription = await groq.audio.transcriptions.create({
                file,
                model: WHISPER_PRIMARY,
                temperature: 0,
                language: 'en',
                response_format: 'verbose_json',
            });
            return {transcription, model: WHISPER_PRIMARY};
        } catch (error: any) {
            console.warn(`Service: Primary model (${WHISPER_PRIMARY}) failed — falling back to ${WHISPER_FALLBACK}`.yellow.bold, {error: error.message});
            const transcription: Transcription = await groq.audio.transcriptions.create({
                file,
                model: WHISPER_FALLBACK,
                temperature: 0,
                language: 'en',
                response_format: 'verbose_json',
            });
            return {transcription, model: WHISPER_FALLBACK};
        }
    }

    /** Step 1: Whisper transcription → Step 2: LLaMA rephrase */
    static async transcribeAndRephrase(buffer: Buffer, originalname: string): Promise<ITranscribeServiceResponse> {
        console.log('Service: VoiceService.transcribeAndRephrase called'.cyan.italic, {originalname, bufferSize: buffer.length});

        // Pre-flight: reject near-empty buffers before hitting Whisper
        if (buffer.length < MIN_AUDIO_BUFFER_SIZE) {
            console.warn(`Service: Buffer too small (${buffer.length} bytes) — likely silent/empty recording. Rejecting.`.yellow.bold);
            return {error: generateInvalidCode('audio')};
        }

        // Step 1 — Groq Whisper: audio buffer → raw transcript
        const file: File = await toFile(buffer, originalname);
        console.log('Service: File prepared for upload'.cyan, {fileName: file.name, fileSize: file.size});

        const {transcription, model} = await VoiceService.whisperTranscribe(file);

        const transcript: string = transcription.text;
        console.log(`Service: Whisper transcription complete (${model})`.cyan, {transcript});

        if (!transcript || transcript.trim().length === 0) {
            console.warn('Service: Whisper returned empty transcript'.yellow.bold);
            return {error: generateMissingCode('transcript')};
        }

        // Step 2 — Groq LLaMA: raw transcript → rephrased clean text
        console.log('Service: Sending transcript to Groq LLaMA (llama-3.3-70b-versatile)...'.cyan);
        const rephrase = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
                {
                    role: 'system',
                    content:
                        'The following is raw, informal speech — possibly with filler words, repeated words, misspellings, and broken grammar. ' +
                        'Understand the intent and rewrite it as a clean, simple, conversational message — like how a developer would naturally type to an AI coding assistant. ' +
                        'Keep it casual but clear. Do not make it formal or corporate. ' +
                        'Output only the rephrased message — no explanation, no prefix.',
                },
                {role: 'user', content: transcript},
            ],
        });

        const rephrased: string = rephrase.choices[0]?.message?.content || transcript;
        console.log('Service: LLaMA rephrase complete'.cyan, {transcript, rephrased});

        return {transcript, rephrased};
    }
}

export default VoiceService;
