# Discord Voice Call Plugin for OpenClaw

This plugin adapts the OpenClaw `voice-call` interface to work with Discord voice channels using `@discordjs/voice`. It allows OpenClaw agents to join voice channels, listen to users (receiving Opus/PCM), and speak (sending PCM/Opus).

## Features

- **Join/Leave**: Connect to any Discord voice channel the bot has access to.
- **Listen**: Receive audio streams from individual users (demuxed).
- **ASR → LLM → TTS loop**: Buffers speech, transcribes, generates a reply, and speaks back.
- **Speak**: Send audio buffers (TTS output) to the channel.
- **Silence Keep-alive**: Maintains connection stability.

## Prerequisites

### System Dependencies
The underlying Discord voice libraries require:
- **FFmpeg**: Must be installed on the system path or provided via `ffmpeg-static`.
- **Python/C++ Build Tools**: Required for `libsodium-wrappers` and `opus` native compilation if prebuilds fail.

### Bot Token
You need a Discord Bot Token with the following intents enabled in the [Discord Developer Portal](https://discord.com/developers/applications):
- `GUILDS`
- `GUILD_VOICE_STATES`
- `GUILD_MESSAGES` (optional, for context)

## Installation

1. Clone this folder into your OpenClaw plugins directory:
   ```bash
   cd workspace/plugins
   # (Folder should be named discord-voice-call)
   ```

2. Install dependencies:
   ```bash
   cd discord-voice-call
   npm install
   ```

3. Build the plugin:
   ```bash
   npm run build
   ```

## Configuration

Add the `discord_token` and OpenAI settings to your OpenClaw configuration (e.g., `config/default.json` or environment variables):

```json
{
  "plugins": {
    "discord-voice-call": {
      "discord_token": "YOUR_DISCORD_BOT_TOKEN_HERE",
      "openai_api_key": "YOUR_OPENAI_API_KEY",
      "openai_chat_model": "gpt-4o-mini",
      "openai_whisper_model": "whisper-1",
      "openai_tts_model": "gpt-4o-mini-tts",
      "openai_tts_voice": "alloy",
      "assistant_prompt": "You are a helpful assistant in a Discord voice chat.",
      "speech_energy_threshold": 0.02,
      "speech_silence_ms": 800,
      "speech_max_utterance_ms": 15000,
      "speech_preroll_ms": 300,
      "speech_language": "ko"
    }
  }
}
```

## Usage

This plugin provides a `CallProvider` with the ID `discord-voice`.

### Starting a Call

When requesting a call via the OpenClaw Agent, specify the context:

```typescript
const callSession = await provider.startCall({
  guildId: "123456789012345678",
  channelId: "987654321098765432",
  selfMute: false,
  selfDeaf: false
});
```

### Events

- `status`: 'connecting' | 'connected' | 'disconnected'
- `audio`: Emitted when a user speaks.
  ```ts
  callSession.on('audio', (packet) => {
    console.log(`Received ${packet.buffer.length} bytes from user ${packet.userId}`);
  });
  ```

## Troubleshooting

- **No Audio?** Check if `ffmpeg` is installed.
- **No replies?** Ensure `openai_api_key` is configured. Without it, the ASR/LLM/TTS pipeline is disabled.
- **Disconnects immediately?** Ensure the bot has `Connect` and `Speak` permissions in the target channel.
- **"Opus engine not found"?** Reinstall `@discordjs/opus` or `opusscript`.
