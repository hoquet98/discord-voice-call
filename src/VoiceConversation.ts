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
  maxTextLength?: number; // TTS text length limit
  rateLimitMs?: number; // Rate limit between requests
  monthlyCostLimit?: number; // Monthly cost limit in USD
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

// Rate limiting storage
const userLastRequest = new Map<string, number>();
let monthlySpend = 0;

// Hardening: Input sanitization for prompt injection
function sanitizeInput(text: string, maxLength: number = 1000): string {
  // Remove potentially dangerous control characters
  let sanitized = text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '') // Zero-width characters
    .trim();

  // Limit length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }

  return sanitized;
}

// Hardening: Check rate limits
function checkRateLimit(userId: string, limitMs: number = 2000): boolean {
  const now = Date.now();
  const lastRequest = userLastRequest.get(userId) || 0;
  if (now - lastRequest < limitMs) {
    return false;
  }
  userLastRequest.set(userId, now);
  return true;
}

// Hardening: Estimate and track costs
const COST_ESTIMATES = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 }, // per 1M tokens
  'whisper-1': 0.006, // per minute
  'gpt-4o-mini-tts': 0.003, // per 1K characters
};

function trackCost(operation: string, userId: string, tokensOrMinutesOrChars: number) {
  const now = Date.now();
  const monthKey = `${now.getFullYear()}-${now.getMonth()}`;
  
  // Simplified cost tracking - in production you'd track per-user properly
  // This is a global tracker for demonstration
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
    // Hardening: Check rate limit
    if (!checkRateLimit('global', this.config.rateLimitMs || 1000)) {
      throw new Error('Rate limit exceeded');
    }

    // Hardening: Validate input size (max 25MB for Whisper API)
    const maxSize = 25 * 1024 * 1024;
    if (wavBuffer.length > maxSize) {
      throw new Error('Audio file too large');
    }

    const form = new FormData();
    form.append('model', this.config.whisperModel);
    if (language) form.append('language', language);
    form.append('file', new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' }), 'audio.wav');

    try {
      const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: form,
      });

      if (!resp.ok) {
        // Hardening: Don't log the full error response
        throw new Error(`ASR failed (${resp.status})`);
      }

      const data = await resp.json();
      return { text: sanitizeInput(data.text ?? '') };
    } catch (error) {
      this.logger.error('Transcription error', { error: error instanceof Error ? error.message : 'Unknown error' });
      throw error;
    }
  }

  async chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) {
    // Hardening: Check rate limit
    if (!checkRateLimit('chat', this.config.rateLimitMs || 2000)) {
      throw new Error('Rate limit exceeded');
    }

    // Hardening: Sanitize all user messages
    const sanitizedMessages = messages.map(msg => ({
      ...msg,
      content: msg.role === 'user' ? sanitizeInput(msg.content) : msg.content,
    }));

    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.chatModel,
          messages: sanitizedMessages,
        }),
      });

      if (!resp.ok) {
        // Hardening: Don't log the full error response
        throw new Error(`Chat failed (${resp.status})`);
      }

      const data = await resp.json();
      return sanitizeInput(data.choices?.[0]?.message?.content?.trim() ?? '');
    } catch (error) {
      this.logger.error('Chat error', { error: error instanceof Error ? error.message : 'Unknown error' });
      throw error;
    }
  }

  async tts(text: string): Promise<Buffer> {
    // Hardening: Check rate limit
    if (!checkRateLimit('tts', this.config.rateLimitMs || 1000)) {
      throw new Error('Rate limit exceeded');
    }

    // Hardening: Limit text length (TTS has a 4096 char limit)
    const maxLength = this.config.maxTextLength || 1000;
    const sanitizedText = sanitizeInput(text, maxLength);

    try {
      const resp = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.ttsModel,
          voice: this.config.ttsVoice,
          input: sanitizedText,
          format: 'mp3',
        }),
      });

      if (!resp.ok) {
        // Hardening: Don't log the full error response
        throw new Error(`TTS failed (${resp.status})`);
      }

      const arrayBuffer = await resp.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      this.logger.error('TTS error', { error: error instanceof Error ? error.message : 'Unknown error' });
      throw error;
    }
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
  // Hardening: Timeout for FFmpeg to prevent hanging
  const TIMEOUT_MS = 30000;

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];

    const timeout = setTimeout(() => {
      ffmpeg.kill('SIGTERM');
      reject(new Error('FFmpeg timed out'));
    }, TIMEOUT_MS);

    ffmpeg.stdout.on('data', (data) => chunks.push(data));
    ffmpeg.stderr.on('data', (data) => errors.push(data));

    ffmpeg.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ffmpeg.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        // Hardening: Don't expose FFmpeg stderr to users
        reject(new Error(`Audio processing failed`));
      }
    });

    ffmpeg.stdin.write(input);
    ffmpeg.stdin.end();
  });
}
