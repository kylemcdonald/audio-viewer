export class AudioEngine {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private playing = false;

  buffer: AudioBuffer | null = null;
  onEnded: (() => void) | null = null;

  private getContext(): AudioContext {
    if (!this.context) {
      const Context = window.AudioContext ?? window.webkitAudioContext;
      this.context = new Context({ latencyHint: 'interactive' });
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
    }
    return this.context;
  }

  async decode(encoded: ArrayBuffer): Promise<AudioBuffer> {
    const context = this.getContext();
    return context.decodeAudioData(encoded.slice(0));
  }

  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    return this.getContext().createBuffer(channels, length, sampleRate);
  }

  setBuffer(buffer: AudioBuffer): void {
    this.playing = false;
    this.stopSource();
    this.buffer = buffer;
    this.offset = 0;
  }

  clear(): void {
    this.playing = false;
    this.stopSource();
    this.buffer = null;
    this.offset = 0;
  }

  async play(): Promise<void> {
    if (!this.buffer || this.playing) return;
    const context = this.getContext();
    await context.resume();

    if (this.offset >= this.buffer.duration - 0.001) this.offset = 0;

    const source = context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain!);
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      if (!this.playing) return;
      this.playing = false;
      this.offset = this.buffer?.duration ?? 0;
      this.onEnded?.();
    };
    this.source = source;
    this.startedAt = context.currentTime;
    this.playing = true;
    source.start(0, this.offset);
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.currentTime;
    this.playing = false;
    this.stopSource();
  }

  toggle(): Promise<void> | void {
    if (this.playing) this.pause();
    else return this.play();
  }

  seek(time: number): void {
    const duration = this.buffer?.duration ?? 0;
    const next = Math.max(0, Math.min(duration, time));
    const wasPlaying = this.playing;
    this.playing = false;
    this.stopSource();
    this.offset = next;
    if (wasPlaying) void this.play();
  }

  get currentTime(): number {
    if (!this.buffer) return 0;
    if (!this.playing || !this.context) return this.offset;
    return Math.min(this.buffer.duration, this.offset + this.context.currentTime - this.startedAt);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  private stopSource(): void {
    if (!this.source) return;
    const source = this.source;
    this.source = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // The source may already have completed naturally.
    }
    source.disconnect();
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
