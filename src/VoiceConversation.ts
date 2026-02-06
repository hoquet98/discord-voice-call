import { EventEmitter } from 'events';
import { spawn } from 'child_process';

export interface OpenAIConfig {
  apiKey: string;
  chatModel: string;
  whisperModel: string;
  ttsModel: string;
  ttsVoice: string;
  systemPrompt?: string;
}

export interface ConversationConfig {
  openai: OpenAIConfig;
  energyThreshold: number; // 0-1 RMS threshold
  silenceMs: number;
  maxUtteranceMs: number;
  preRollMs: number;
  language?: string; // optional ASR language hint
}

export interface Utterance {
  userId: string;
  pcm: Buffer; // 48k stereo s16le
  timestamp: number;
}

export interface TranscriptResult {
  text: string;
}

export interface Logger {
  info(msg: string, meta?: any): void;
  warn(msg: string, meta?: any): void;
  error(msg: string, meta?: any): void;
  debug(msg: string, meta?: any): void;
}

export class SpeechAggregator extends EventEmitter {
  private preRollBuffers: Buffer[] = [];
  private utteranceBuffers: Buffer[] = [];
  private inSpeech = false;
  private lastVoiceAt = 0;
  private lastChunkAt = 0;
  private maxPreRollBytes: number;
  private maxUtteranceBytes: number;

  constructor(
    private config: ConversationConfig,
    private logger: Logger,
    private userId: string
  ) {
    super();
    const bytesPerMs = 48000 * 2 * 2 / 1000; // 48k * 2ch * 2 bytes
    this.maxPreRollBytes = Math.floor(bytesPerMs * config.preRollMs);
    this.maxUtteranceBytes = Math.floor(bytesPerMs * config.maxUtteranceMs);
  }

  public push(chunk: Buffer) {
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

  private trimPreRoll() {
    let total = this.preRollBuffers.reduce((sum, b) => sum + b.length, 0);
    while (total > this.maxPreRollBytes && this.preRollBuffers.length > 0) {
      const removed = this.preRollBuffers.shift();
      if (removed) total -= removed.length;
    }
  }

  private flush(reason: string) {
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

  private reset() {
    this.inSpeech = false;
    this.utteranceBuffers = [];
    this.preRollBuffers = [];
  }
}

function rmsEnergy(chunk: Buffer) {
  if (chunk.length < 2) return 0;
  let sum = 0;
  const samples = Math.floor(chunk.length / 2);
  for (let i = 0; i < samples; i++) {
    const sample = chunk.readInt16LE(i * 2);
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples);
  return rms / 32768;
}

export class OpenAIClient {
  constructor(private config: OpenAIConfig, private logger: Logger) {}

  async transcribe(wavBuffer: Buffer, language?: string): Promise<TranscriptResult> {
    const form = new FormData();
    form.append('model', this.config.whisperModel);
    if (language) form.append('language', language);
    form.append('file', new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' }), 'audio.wav');

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

  async chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) {
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

  async tts(text: string): Promise<Buffer> {
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

export async function resamplePcmToWav16kMono(pcm48kStereo: Buffer): Promise<Buffer> {
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

export async function resampleAudioToPcm48kStereo(inputAudio: Buffer): Promise<Buffer> {
  return await spawnFfmpeg([
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ], inputAudio);
}

async function spawnFfmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];

    ffmpeg.stdout.on('data', (data) => chunks.push(data));
    ffmpeg.stderr.on('data', (data) => errors.push(data));

    ffmpeg.on('error', (err) => reject(err));
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${Buffer.concat(errors).toString('utf8')}`));
      }
    });

    ffmpeg.stdin.write(input);
    ffmpeg.stdin.end();
  });
}
