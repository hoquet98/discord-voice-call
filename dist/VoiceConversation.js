"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIClient = exports.SpeechAggregator = void 0;
exports.resamplePcmToWav16kMono = resamplePcmToWav16kMono;
exports.resampleAudioToPcm48kStereo = resampleAudioToPcm48kStereo;
const events_1 = require("events");
const child_process_1 = require("child_process");
class SpeechAggregator extends events_1.EventEmitter {
    config;
    logger;
    userId;
    preRollBuffers = [];
    utteranceBuffers = [];
    inSpeech = false;
    lastVoiceAt = 0;
    lastChunkAt = 0;
    maxPreRollBytes;
    maxUtteranceBytes;
    constructor(config, logger, userId) {
        super();
        this.config = config;
        this.logger = logger;
        this.userId = userId;
        const bytesPerMs = 48000 * 2 * 2 / 1000; // 48k * 2ch * 2 bytes
        this.maxPreRollBytes = Math.floor(bytesPerMs * config.preRollMs);
        this.maxUtteranceBytes = Math.floor(bytesPerMs * config.maxUtteranceMs);
    }
    push(chunk) {
        const now = Date.now();
        this.lastChunkAt = now;
        const energy = rmsEnergy(chunk);
        const isVoice = energy >= this.config.energyThreshold;
        if (!this.inSpeech) {
            this.preRollBuffers.push(chunk);
            this.trimPreRoll();
            if (isVoice) {
                this.inSpeech = true;
                this.lastVoiceAt = now;
                this.utteranceBuffers = [...this.preRollBuffers, chunk];
                this.preRollBuffers = [];
            }
            return;
        }
        // in speech
        if (isVoice) {
            this.lastVoiceAt = now;
        }
        this.utteranceBuffers.push(chunk);
        const currentBytes = this.utteranceBuffers.reduce((sum, b) => sum + b.length, 0);
        if (currentBytes >= this.maxUtteranceBytes) {
            this.flush('max-utterance');
            return;
        }
        if (!isVoice && now - this.lastVoiceAt >= this.config.silenceMs) {
            this.flush('silence');
        }
    }
    trimPreRoll() {
        let total = this.preRollBuffers.reduce((sum, b) => sum + b.length, 0);
        while (total > this.maxPreRollBytes && this.preRollBuffers.length > 0) {
            const removed = this.preRollBuffers.shift();
            if (removed)
                total -= removed.length;
        }
    }
    flush(reason) {
        if (!this.inSpeech || this.utteranceBuffers.length === 0) {
            this.reset();
            return;
        }
        const pcm = Buffer.concat(this.utteranceBuffers);
        this.emit('utterance', {
            userId: this.userId,
            pcm,
            timestamp: Date.now(),
            reason,
        });
        this.reset();
    }
    reset() {
        this.inSpeech = false;
        this.utteranceBuffers = [];
        this.preRollBuffers = [];
    }
}
exports.SpeechAggregator = SpeechAggregator;
function rmsEnergy(chunk) {
    if (chunk.length < 2)
        return 0;
    let sum = 0;
    const samples = Math.floor(chunk.length / 2);
    for (let i = 0; i < samples; i++) {
        const sample = chunk.readInt16LE(i * 2);
        sum += sample * sample;
    }
    const rms = Math.sqrt(sum / samples);
    return rms / 32768;
}
class OpenAIClient {
    config;
    logger;
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    async transcribe(wavBuffer, language) {
        const form = new FormData();
        form.append('model', this.config.whisperModel);
        if (language)
            form.append('language', language);
        form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
        const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.config.apiKey}`,
            },
            body: form,
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`ASR failed (${resp.status}): ${text}`);
        }
        const data = await resp.json();
        return { text: data.text ?? '' };
    }
    async chat(messages) {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.config.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: this.config.chatModel,
                messages,
            }),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Chat failed (${resp.status}): ${text}`);
        }
        const data = await resp.json();
        return data.choices?.[0]?.message?.content?.trim() ?? '';
    }
    async tts(text) {
        const resp = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.config.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: this.config.ttsModel,
                voice: this.config.ttsVoice,
                input: text,
                format: 'mp3',
            }),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`TTS failed (${resp.status}): ${text}`);
        }
        const arrayBuffer = await resp.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }
}
exports.OpenAIClient = OpenAIClient;
async function resamplePcmToWav16kMono(pcm48kStereo) {
    return await spawnFfmpeg([
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        '-i', 'pipe:0',
        '-ac', '1',
        '-ar', '16000',
        '-f', 'wav',
        'pipe:1',
    ], pcm48kStereo);
}
async function resampleAudioToPcm48kStereo(inputAudio) {
    return await spawnFfmpeg([
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1',
    ], inputAudio);
}
async function spawnFfmpeg(args, input) {
    return new Promise((resolve, reject) => {
        const ffmpeg = (0, child_process_1.spawn)('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks = [];
        const errors = [];
        ffmpeg.stdout.on('data', (data) => chunks.push(data));
        ffmpeg.stderr.on('data', (data) => errors.push(data));
        ffmpeg.on('error', (err) => reject(err));
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve(Buffer.concat(chunks));
            }
            else {
                reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(errors).toString('utf8')}`));
            }
        });
        ffmpeg.stdin.write(input);
        ffmpeg.stdin.end();
    });
}
