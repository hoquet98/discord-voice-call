import { Client, GatewayIntentBits } from 'discord.js';
import { DiscordCall } from './DiscordCall.js';
import { CallProvider, CallParams, CallSession, PluginContext } from './types.js';

export class DiscordVoiceProvider implements CallProvider {
  public id = 'discord-voice';
  private client: Client;
  private calls: Map<string, DiscordCall> = new Map();
  private ready = false;

  constructor(private context: PluginContext) {
    // Hardening: Support environment variables for tokens
    const token = process.env.DISCORD_TOKEN || context.config.get('discord_token');

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages
      ]
    });

    this.client.on('ready', () => {
      this.ready = true;
      this.context.logger.info(`Discord Voice Provider ready. Logged in as ${this.client.user?.tag}`);
    });

    this.client.on('error', (err) => {
      this.context.logger.error('Discord Client Error', { error: err.message });
    });

    if (token) {
      this.client.login(token).catch(err => {
        this.context.logger.error('Failed to login to Discord', { error: err.message });
      });
    } else {
      this.context.logger.warn('No discord_token found in config or DISCORD_TOKEN env var. Voice provider will not work until configured.');
    }
  }

  async startCall(params: CallParams): Promise<CallSession> {
    if (!this.ready) {
      if (!this.client.token) {
        throw new Error('Discord token not configured');
      }
      throw new Error('Discord client not connected yet');
    }

    // Hardening: Check for existing call in the same channel
    const existingCall = Array.from(this.calls.values()).find(
      call => call.status === 'connected' &&
        (call as any).params.channelId === params.channelId
    );
    if (existingCall) {
      this.context.logger.info('Call already exists in channel, returning existing');
      return existingCall;
    }

    const call = new DiscordCall(this.client, params, this.context);
    this.calls.set(call.id, call);

    call.on('status', (status) => {
      if (status === 'disconnected') {
        this.calls.delete(call.id);
      }
    });

    return call;
  }

  async endCall(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (call) {
      await call.end();
      this.calls.delete(callId);
    }
  }

  // Hardening: Cleanup all calls on shutdown
  async shutdown(): Promise<void> {
    this.context.logger.info('Shutting down Discord Voice Provider');
    const callIds = Array.from(this.calls.keys());
    for (const callId of callIds) {
      await this.endCall(callId);
    }
    if (this.client) {
      this.client.destroy();
    }
  }
}

export default DiscordVoiceProvider;

export * from './types.js';
export * from './DiscordCall.js';
export * from './VoiceConversation.js';
