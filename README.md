# Discord Voice Call Plugin for OpenClaw

This plugin adapts the OpenClaw `voice-call` interface to work with Discord voice channels using `@discordjs/voice`. It allows OpenClaw agents to join voice channels, listen to users (receiving Opus/PCM), and speak (sending PCM/Opus).

## Features

- **Join/Leave**: Connect to any Discord voice channel the bot has access to.
- **Listen**: Receive audio streams from individual users (demuxed).
- **ASR → LLM → TTS loop**: Buffers speech, transcribes, generates a reply, and speaks back.
- **Speak**: Send audio buffers (TTS output) to the channel.
- **Silence Keep-alive**: Maintains connection stability.
- **Security Hardened**: Input sanitization, rate limiting, cost controls, and secure logging.

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
   git clone https://github.com/YOUR_USERNAME/discord-voice-call.git
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

### Environment Variables (Recommended)
Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
# Edit .env with your API keys
```

### OpenClaw Config
You can also add settings to your OpenClaw configuration:

```json
{
  "plugins": {
    "discord-voice-call": {
      "openai_chat_model": "gpt-4o-mini",
      "openai_whisper_model": "whisper-1",
      "openai_tts_model": "gpt-4o-mini-tts",
      "openai_tts_voice": "alloy",
      "assistant_prompt": "You are a helpful assistant in a Discord voice chat.",
      "speech_energy_threshold": 0.02,
      "speech_silence_ms": 800,
      "speech_max_utterance_ms": 15000,
      "speech_preroll_ms": 300,
      "speech_language": "en"
    }
  }
}
```

### Security Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `max_text_length` | 1000 | Max characters for TTS input |
| `rate_limit_ms` | 2000 | Rate limit between API calls |
| `monthly_cost_limit` | 50 | Monthly cost cap in USD |

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

## Security Notes

This plugin includes several security hardening measures:

1. **Input Sanitization**: All user input is sanitized before being sent to the LLM
2. **Rate Limiting**: Prevents API abuse
3. **Cost Controls**: Monthly spending limits to prevent runaway costs
4. **Secure Logging**: Error messages don't expose sensitive data
5. **Prompt Injection Defense**: System instructions include anti-injection guidance
6. **Environment Variable Support**: API keys can be loaded from environment instead of config

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Discord bot token |
| `OPENAI_API_KEY` | OpenAI API key |

## Troubleshooting

- **No Audio?** Check if `ffmpeg` is installed.
- **No replies?** Ensure `openai_api_key` is configured or `OPENAI_API_KEY` env var is set.
- **Disconnects immediately?** Ensure the bot has `Connect` and `Speak` permissions in the target channel.
- **"Opus engine not found"?** Reinstall `@discordjs/opus` or `opusscript`.
- **Rate limited?** Increase `rate_limit_ms` in config.

## License

MIT License
