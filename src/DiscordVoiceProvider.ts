import { Client, GatewayIntentBits } from 'discord.js';
import { DiscordCall } from './DiscordCall.js';
import { CallProvider, CallParams, CallSession, PluginContext } from './types.js';

export class DiscordVoiceProvider implements CallProvider {
  public id = 'discord-voice';
  private client: Client;
  private calls: Map<string, DiscordCall> = new Map();
  private ready = false;

  constructor(private context: PluginContext) {
    const token = context.config.get('discord_token');
    
    // Initialize Discord Client
    // NOTE: In a real environment, you might share one client across multiple plugins 
    // or use a dedicated bot token for voice.
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
        this.context.logger.error('Discord Client Error', err);
    });

    if (token) {
        this.client.login(token).catch(err => {
            this.context.logger.error('Failed to login to Discord', err);
        });
    } else {
        this.context.logger.warn('No discord_token found in config. Voice provider will not work until configured.');
    }
  }

  async startCall(params: CallParams): Promise<CallSession> {
    if (!this.ready) {
       // Attempt to wait or throw? Throwing is safer.
       // User should ensure bot is ready.
       if (!this.client.token) {
           throw new Error('Discord token not configured');
       }
       throw new Error('Discord client not connected yet');
    }
    
    const call = new DiscordCall(this.client, params, this.context);
    this.calls.set(call.id, call);
    
    // Clean up when call ends
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
}
