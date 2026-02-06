import { 
  joinVoiceChannel, 
  VoiceConnection, 
  VoiceConnectionStatus, 
  AudioPlayer, 
  createAudioPlayer, 
  createAudioResource, 
  StreamType,
  EndBehaviorType,
  NoSubscriberBehavior,
  VoiceReceiver,
  entersState,
  AudioPlayerStatus,
  DiscordGatewayAdapterCreator
} from '@discordjs/voice';
import { Client } from 'discord.js';
import { CallSession, CallParams, PluginContext } from './types.js';
import * as prism from 'prism-media';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import { ConversationConfig, OpenAIClient, SpeechAggregator, resampleAudioToPcm48kStereo, resamplePcmToWav16kMono } from './VoiceConversation.js';

export class DiscordCall extends EventEmitter implements CallSession {
  public id: string;
  public status: 'connecting' | 'connected' | 'disconnected' | 'error' = 'connecting';
  
  private connection: VoiceConnection | null = null;
  private audioPlayer: AudioPlayer;
  private logger: PluginContext['logger'];
  private subscriptions: Map<string, any> = new Map(); // Track audio subscriptions
  private aggregators: Map<string, SpeechAggregator> = new Map();
  private audioQueue: Buffer[] = [];
  private processingQueue: Array<{ userId: string; pcm: Buffer; timestamp: number }> = [];
  private processing = false;
  private openAI: OpenAIClient | null = null;
  private conversationConfig: ConversationConfig | null = null;
  private conversationHistory: Map<string, Array<{ role: 'system' | 'user' | 'assistant'; content: string }>> = new Map();
  private reconnectAttempts = 0;

  constructor(
    private client: Client,
    private params: CallParams,
    context: PluginContext
  ) {
    super();
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
      this.openAI = new OpenAIClient(this.conversationConfig.openai, this.logger);
    } else {
      this.logger.warn('openai_api_key not configured; voice conversation pipeline disabled.');
    }
    
    // Create audio player with behavior to continue even if no one listens (prevents pausing)
    this.audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });
    
    this.audioPlayer.on('error', error => {
      this.logger.error(`Audio player error: ${error.message}`);
    });

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this.playNextInQueue();
    });

    this.initialize();
  }

  private async initialize() {
    try {
      this.logger.info(`Joining voice channel ${this.params.channelId} in guild ${this.params.guildId}`);
      
      const guild = await this.client.guilds.fetch(this.params.guildId);
      const voiceChannel = await guild.channels.fetch(this.params.channelId);

      if (!voiceChannel || !voiceChannel.isVoiceBased()) {
        throw new Error(`Channel ${this.params.channelId} is not a voice channel`);
      }

      this.connection = joinVoiceChannel({
        channelId: this.params.channelId,
        guildId: this.params.guildId,
        adapterCreator: guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
        selfDeaf: this.params.selfDeaf ?? false,
        selfMute: this.params.selfMute ?? false,
      });

      this.connection.on(VoiceConnectionStatus.Ready, () => {
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

      this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(this.connection!, VoiceConnectionStatus.Signalling, 5_000),
            entersState(this.connection!, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          // Reconnecting...
        } catch (error) {
          this.logger.warn(`Connection disconnected for call ${this.id}`);
          await this.attemptReconnect();
        }
      });

      this.connection.on('stateChange', (oldState, newState) => {
        this.logger.debug(`Connection state change: ${oldState.status} -> ${newState.status}`);
      });

    } catch (error) {
      this.logger.error(`Failed to initialize call ${this.id}`, error);
      this.status = 'error';
      this.emit('error', error);
      this.end();
    }
  }

  private setupReceiver(receiver: VoiceReceiver) {
    // Listen to speaking events
    receiver.speaking.on('start', (userId) => {
      this.subscribeToUser(userId);
    });
    
    // We don't necessarily unsubscribe on 'end' to avoid destroying the stream prematurely
    // receiver.speaking.on('end', (userId) => {});
  }

  private subscribeToUser(userId: string) {
    if (this.subscriptions.has(userId)) return;

    // receiver.subscribe returns an AudioReceiveStream (Readable)
    const opusStream = this.connection?.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 100, // wait 100ms of silence
      }
    });

    if (!opusStream) return;

    // Decode Opus to PCM
    // Discord sends stereo Opus at 48kHz.
    // We decode to PCM 16-bit signed, 48kHz, stereo.
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    
    // Pipe opus -> decoder
    const pipeline = opusStream.pipe(decoder);

    this.subscriptions.set(userId, pipeline);

    if (!this.aggregators.has(userId) && this.conversationConfig) {
      const aggregator = new SpeechAggregator(this.conversationConfig, this.logger, userId);
      aggregator.on('utterance', (utt: { userId: string; pcm: Buffer; timestamp: number; reason: string }) => {
        this.enqueueUtterance(utt.userId, utt.pcm, utt.timestamp);
      });
      this.aggregators.set(userId, aggregator);
    }

    pipeline.on('data', (chunk: Buffer) => {
      // Emit generic audio event for the plugin system
      this.emit('audio', {
        userId,
        buffer: chunk,
        timestamp: Date.now()
      });

      const aggregator = this.aggregators.get(userId);
      if (aggregator) aggregator.push(chunk);
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

  private enqueueUtterance(userId: string, pcm: Buffer, timestamp: number) {
    this.processingQueue.push({ userId, pcm, timestamp });
    if (!this.processing) {
      this.processNextUtterance();
    }
  }

  private async attemptReconnect() {
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

      this.connection = joinVoiceChannel({
        channelId: this.params.channelId,
        guildId: this.params.guildId,
        adapterCreator: guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
        selfDeaf: this.params.selfDeaf ?? false,
        selfMute: this.params.selfMute ?? false,
      });

      this.connection.on(VoiceConnectionStatus.Ready, () => {
        this.status = 'connected';
        this.emit('status', 'connected');
        this.logger.info(`Reconnected call ${this.id}`);
        this.connection?.subscribe(this.audioPlayer);
        this.setupReceiver(this.connection!.receiver);
        this.reconnectAttempts = 0;
      });
    } catch (error) {
      this.logger.error('Reconnect failed', error);
      await this.attemptReconnect();
    }
  }

  private async processNextUtterance() {
    if (this.processingQueue.length === 0) return;
    if (!this.conversationConfig || !this.openAI) return;

    const { userId, pcm } = this.processingQueue.shift()!;
    this.processing = true;

    try {
      const wav16k = await resamplePcmToWav16kMono(pcm);
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
      const pcm48k = await resampleAudioToPcm48kStereo(ttsAudio);
      this.sendAudio(pcm48k);
    } catch (error) {
      this.logger.error('Failed to process utterance', error);
    } finally {
      this.processing = false;
      this.processNextUtterance();
    }
  }

  /**
   * Send generic PCM audio buffer.
   * Assumes 48kHz stereo 16-bit signed PCM (standard for Discord.js PCM input).
   */
  public sendAudio(audioData: Buffer) {
    if (this.status !== 'connected') {
      this.logger.warn(`Attempted to send audio while not connected`);
      return;
    }

    this.audioQueue.push(audioData);
    this.playNextInQueue();
  }

  private playNextInQueue() {
    if (this.audioPlayer.state.status !== AudioPlayerStatus.Idle) return;
    if (this.audioQueue.length === 0) return;

    const next = this.audioQueue.shift();
    if (!next) return;

    const stream = Readable.from(next);
    const audioResource = createAudioResource(stream, {
      inputType: StreamType.Raw,
    });

    this.audioPlayer.play(audioResource);
  }

  public async end() {
    this.status = 'disconnected';
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
    this.audioPlayer.stop();
    this.subscriptions.forEach(sub => {
        // Destroy streams if they have a destroy method
        if (typeof sub.destroy === 'function') sub.destroy();
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
