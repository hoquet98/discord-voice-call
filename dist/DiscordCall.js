"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiscordCall = void 0;
const voice_1 = require("@discordjs/voice");
const prism = __importStar(require("prism-media"));
const stream_1 = require("stream");
const events_1 = require("events");
const VoiceConversation_js_1 = require("./VoiceConversation.js");
class DiscordCall extends events_1.EventEmitter {
    client;
    params;
    id;
    status = 'connecting';
    connection = null;
    audioPlayer;
    logger;
    subscriptions = new Map(); // Track audio subscriptions
    aggregators = new Map();
    audioQueue = [];
    processingQueue = [];
    processing = false;
    openAI = null;
    conversationConfig = null;
    conversationHistory = new Map();
    reconnectAttempts = 0;
    constructor(client, params, context) {
        super();
        this.client = client;
        this.params = params;
        this.id = `${params.guildId}-${params.channelId}-${Date.now()}`;
        this.logger = context.logger;
        const openaiKey = context.config.get('openai_api_key');
        if (openaiKey) {
            this.conversationConfig = {
                openai: {
                    apiKey: openaiKey,
                    chatModel: context.config.get('openai_chat_model') ?? 'gpt-4o-mini',
                    whisperModel: context.config.get('openai_whisper_model') ?? 'whisper-1',
                    ttsModel: context.config.get('openai_tts_model') ?? 'gpt-4o-mini-tts',
                    ttsVoice: context.config.get('openai_tts_voice') ?? 'alloy',
                    systemPrompt: context.config.get('assistant_prompt') ?? 'You are a helpful assistant in a Discord voice chat.',
                },
                energyThreshold: context.config.get('speech_energy_threshold') ?? 0.02,
                silenceMs: context.config.get('speech_silence_ms') ?? 800,
                maxUtteranceMs: context.config.get('speech_max_utterance_ms') ?? 15000,
                preRollMs: context.config.get('speech_preroll_ms') ?? 300,
                language: context.config.get('speech_language') ?? undefined,
            };
            this.openAI = new VoiceConversation_js_1.OpenAIClient(this.conversationConfig.openai, this.logger);
        }
        else {
            this.logger.warn('openai_api_key not configured; voice conversation pipeline disabled.');
        }
        // Create audio player with behavior to continue even if no one listens (prevents pausing)
        this.audioPlayer = (0, voice_1.createAudioPlayer)({
            behaviors: {
                noSubscriber: voice_1.NoSubscriberBehavior.Play,
            },
        });
        this.audioPlayer.on('error', error => {
            this.logger.error(`Audio player error: ${error.message}`);
        });
        this.audioPlayer.on(voice_1.AudioPlayerStatus.Idle, () => {
            this.playNextInQueue();
        });
        this.initialize();
    }
    async initialize() {
        try {
            this.logger.info(`Joining voice channel ${this.params.channelId} in guild ${this.params.guildId}`);
            const guild = await this.client.guilds.fetch(this.params.guildId);
            const voiceChannel = await guild.channels.fetch(this.params.channelId);
            if (!voiceChannel || !voiceChannel.isVoiceBased()) {
                throw new Error(`Channel ${this.params.channelId} is not a voice channel`);
            }
            this.connection = (0, voice_1.joinVoiceChannel)({
                channelId: this.params.channelId,
                guildId: this.params.guildId,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: this.params.selfDeaf ?? false,
                selfMute: this.params.selfMute ?? false,
            });
            this.connection.on(voice_1.VoiceConnectionStatus.Ready, () => {
                this.status = 'connected';
                this.emit('status', 'connected');
                this.logger.info(`Connection ready for call ${this.id}`);
                // Subscribe the connection to the audio player
                this.connection?.subscribe(this.audioPlayer);
                // Setup listening
                if (this.connection) {
                    this.setupReceiver(this.connection.receiver);
                }
            });
            this.connection.on(voice_1.VoiceConnectionStatus.Disconnected, async () => {
                try {
                    await Promise.race([
                        (0, voice_1.entersState)(this.connection, voice_1.VoiceConnectionStatus.Signalling, 5_000),
                        (0, voice_1.entersState)(this.connection, voice_1.VoiceConnectionStatus.Connecting, 5_000),
                    ]);
                    // Reconnecting...
                }
                catch (error) {
                    this.logger.warn(`Connection disconnected for call ${this.id}`);
                    await this.attemptReconnect();
                }
            });
            this.connection.on('stateChange', (oldState, newState) => {
                this.logger.debug(`Connection state change: ${oldState.status} -> ${newState.status}`);
            });
        }
        catch (error) {
            this.logger.error(`Failed to initialize call ${this.id}`, error);
            this.status = 'error';
            this.emit('error', error);
            this.end();
        }
    }
    setupReceiver(receiver) {
        // Listen to speaking events
        receiver.speaking.on('start', (userId) => {
            this.subscribeToUser(userId);
        });
        // We don't necessarily unsubscribe on 'end' to avoid destroying the stream prematurely
        // receiver.speaking.on('end', (userId) => {});
    }
    subscribeToUser(userId) {
        if (this.subscriptions.has(userId))
            return;
        // receiver.subscribe returns an AudioReceiveStream (Readable)
        const opusStream = this.connection?.receiver.subscribe(userId, {
            end: {
                behavior: voice_1.EndBehaviorType.AfterSilence,
                duration: 100, // wait 100ms of silence
            }
        });
        if (!opusStream)
            return;
        // Decode Opus to PCM
        // Discord sends stereo Opus at 48kHz.
        // We decode to PCM 16-bit signed, 48kHz, stereo.
        const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        // Pipe opus -> decoder
        const pipeline = opusStream.pipe(decoder);
        this.subscriptions.set(userId, pipeline);
        if (!this.aggregators.has(userId) && this.conversationConfig) {
            const aggregator = new VoiceConversation_js_1.SpeechAggregator(this.conversationConfig, this.logger, userId);
            aggregator.on('utterance', (utt) => {
                this.enqueueUtterance(utt.userId, utt.pcm, utt.timestamp);
            });
            this.aggregators.set(userId, aggregator);
        }
        pipeline.on('data', (chunk) => {
            // Emit generic audio event for the plugin system
            this.emit('audio', {
                userId,
                buffer: chunk,
                timestamp: Date.now()
            });
            const aggregator = this.aggregators.get(userId);
            if (aggregator)
                aggregator.push(chunk);
        });
        pipeline.on('end', () => {
            this.subscriptions.delete(userId);
            this.aggregators.delete(userId);
        });
        pipeline.on('error', (err) => {
            this.logger.error(`Audio pipeline error for user ${userId}`, err);
            this.subscriptions.delete(userId);
            this.aggregators.delete(userId);
        });
    }
    enqueueUtterance(userId, pcm, timestamp) {
        this.processingQueue.push({ userId, pcm, timestamp });
        if (!this.processing) {
            this.processNextUtterance();
        }
    }
    async attemptReconnect() {
        if (this.reconnectAttempts >= 3) {
            this.logger.warn(`Reconnect attempts exhausted for call ${this.id}`);
            await this.end();
            return;
        }
        this.reconnectAttempts += 1;
        const delay = 1000 * this.reconnectAttempts;
        await new Promise(resolve => setTimeout(resolve, delay));
        try {
            const guild = await this.client.guilds.fetch(this.params.guildId);
            const voiceChannel = await guild.channels.fetch(this.params.channelId);
            if (!voiceChannel || !voiceChannel.isVoiceBased()) {
                throw new Error(`Channel ${this.params.channelId} is not a voice channel`);
            }
            this.connection = (0, voice_1.joinVoiceChannel)({
                channelId: this.params.channelId,
                guildId: this.params.guildId,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: this.params.selfDeaf ?? false,
                selfMute: this.params.selfMute ?? false,
            });
            this.connection.on(voice_1.VoiceConnectionStatus.Ready, () => {
                this.status = 'connected';
                this.emit('status', 'connected');
                this.logger.info(`Reconnected call ${this.id}`);
                this.connection?.subscribe(this.audioPlayer);
                this.setupReceiver(this.connection.receiver);
                this.reconnectAttempts = 0;
            });
        }
        catch (error) {
            this.logger.error('Reconnect failed', error);
            await this.attemptReconnect();
        }
    }
    async processNextUtterance() {
        if (this.processingQueue.length === 0)
            return;
        if (!this.conversationConfig || !this.openAI)
            return;
        const { userId, pcm } = this.processingQueue.shift();
        this.processing = true;
        try {
            const wav16k = await (0, VoiceConversation_js_1.resamplePcmToWav16kMono)(pcm);
            const transcript = await this.openAI.transcribe(wav16k, this.conversationConfig.language);
            const text = transcript.text.trim();
            if (!text) {
                this.processing = false;
                this.processNextUtterance();
                return;
            }
            this.logger.info(`ASR[${userId}]: ${text}`);
            const history = this.conversationHistory.get(userId) ?? [];
            if (history.length === 0 && this.conversationConfig.openai.systemPrompt) {
                history.push({ role: 'system', content: this.conversationConfig.openai.systemPrompt });
            }
            history.push({ role: 'user', content: text });
            const reply = await this.openAI.chat(history);
            if (!reply) {
                this.processing = false;
                this.processNextUtterance();
                return;
            }
            history.push({ role: 'assistant', content: reply });
            this.conversationHistory.set(userId, history.slice(-20)); // keep last 20 messages
            const ttsAudio = await this.openAI.tts(reply);
            const pcm48k = await (0, VoiceConversation_js_1.resampleAudioToPcm48kStereo)(ttsAudio);
            this.sendAudio(pcm48k);
        }
        catch (error) {
            this.logger.error('Failed to process utterance', error);
        }
        finally {
            this.processing = false;
            this.processNextUtterance();
        }
    }
    /**
     * Send generic PCM audio buffer.
     * Assumes 48kHz stereo 16-bit signed PCM (standard for Discord.js PCM input).
     */
    sendAudio(audioData) {
        if (this.status !== 'connected') {
            this.logger.warn(`Attempted to send audio while not connected`);
            return;
        }
        this.audioQueue.push(audioData);
        this.playNextInQueue();
    }
    playNextInQueue() {
        if (this.audioPlayer.state.status !== voice_1.AudioPlayerStatus.Idle)
            return;
        if (this.audioQueue.length === 0)
            return;
        const next = this.audioQueue.shift();
        if (!next)
            return;
        const stream = stream_1.Readable.from(next);
        const audioResource = (0, voice_1.createAudioResource)(stream, {
            inputType: voice_1.StreamType.Raw,
        });
        this.audioPlayer.play(audioResource);
    }
    async end() {
        this.status = 'disconnected';
        if (this.connection) {
            this.connection.destroy();
            this.connection = null;
        }
        this.audioPlayer.stop();
        this.subscriptions.forEach(sub => {
            // Destroy streams if they have a destroy method
            if (typeof sub.destroy === 'function')
                sub.destroy();
        });
        this.subscriptions.clear();
        this.aggregators.clear();
        this.audioQueue = [];
        this.processingQueue = [];
        this.processing = false;
        this.emit('status', 'disconnected');
        this.logger.info(`Call ${this.id} ended`);
    }
}
exports.DiscordCall = DiscordCall;
