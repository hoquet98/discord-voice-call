import { EventEmitter } from 'events';

// Mock OpenClaw interfaces based on typical plugin architecture

export interface PluginContext {
  logger: {
    info(msg: string, meta?: any): void;
    warn(msg: string, meta?: any): void;
    error(msg: string, meta?: any): void;
    debug(msg: string, meta?: any): void;
  };
  config: {
    get(key: string): any;
  };
}

export interface CallProvider {
  id: string;
  startCall(params: CallParams): Promise<CallSession>;
  endCall(callId: string): Promise<void>;
}

export interface CallParams {
  channelId: string;
  guildId: string;
  selfMute?: boolean;
  selfDeaf?: boolean;
}

export interface CallSession extends EventEmitter {
  id: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  sendAudio(audioData: Buffer): void; // Expects PCM or Opus depending on impl
  end(): Promise<void>;
}

export interface AudioPacket {
  userId: string;
  buffer: Buffer; // PCM 16bit LE usually, or Opus
  timestamp: number;
}
