import { DiscordVoiceProvider } from './DiscordVoiceProvider.js';

// Export the provider class. 
// The OpenClaw plugin loader will typically instantiate this or look for a specific export.
export default DiscordVoiceProvider;

export * from './types.js';
export * from './DiscordCall.js';
export * from './DiscordVoiceProvider.js';
export * from './VoiceConversation.js';
