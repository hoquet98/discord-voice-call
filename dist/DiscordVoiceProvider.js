"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiscordVoiceProvider = void 0;
const discord_js_1 = require("discord.js");
const DiscordCall_js_1 = require("./DiscordCall.js");
class DiscordVoiceProvider {
    context;
    id = 'discord-voice';
    client;
    calls = new Map();
    ready = false;
    constructor(context) {
        this.context = context;
        const token = context.config.get('discord_token');
        // Initialize Discord Client
        // NOTE: In a real environment, you might share one client across multiple plugins 
        // or use a dedicated bot token for voice.
        this.client = new discord_js_1.Client({
            intents: [
                discord_js_1.GatewayIntentBits.Guilds,
                discord_js_1.GatewayIntentBits.GuildVoiceStates,
                discord_js_1.GatewayIntentBits.GuildMessages
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
        }
        else {
            this.context.logger.warn('No discord_token found in config. Voice provider will not work until configured.');
        }
    }
    async startCall(params) {
        if (!this.ready) {
            // Attempt to wait or throw? Throwing is safer.
            // User should ensure bot is ready.
            if (!this.client.token) {
                throw new Error('Discord token not configured');
            }
            throw new Error('Discord client not connected yet');
        }
        const call = new DiscordCall_js_1.DiscordCall(this.client, params, this.context);
        this.calls.set(call.id, call);
        // Clean up when call ends
        call.on('status', (status) => {
            if (status === 'disconnected') {
                this.calls.delete(call.id);
            }
        });
        return call;
    }
    async endCall(callId) {
        const call = this.calls.get(callId);
        if (call) {
            await call.end();
            this.calls.delete(callId);
        }
    }
}
exports.DiscordVoiceProvider = DiscordVoiceProvider;
