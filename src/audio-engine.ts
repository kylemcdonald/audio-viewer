export class AudioEngine {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private media: HTMLAudioElement | null = null;
  private mediaUrl: string | null = null;
  private mediaDuration = 0;
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
    this.clearMedia();
    this.buffer = buffer;
    this.offset = 0;
  }

  setMediaFile(file: File, duration: number): void {
    this.clear();
    const media = document.createElement('audio');
    const url = URL.createObjectURL(file);
    media.preload = 'auto';
    media.src = url;
    media.onended = () => {
      if (this.media !== media) return;
      this.playing = false;
      this.onEnded?.();
    };
    this.media = media;
    this.mediaUrl = url;
    this.mediaDuration = Math.max(0, duration);
    media.load();
  }

  clear(): void {
    this.playing = false;
    this.stopSource();
    this.clearMedia();
    this.buffer = null;
    this.offset = 0;
  }

  async play(): Promise<void> {
    if (this.media) {
      if (this.playing) return;
      const media = this.media;
      if (this.currentTime >= this.mediaDuration - 0.001) media.currentTime = 0;
      await media.play();
      if (this.media !== media) return;
      this.playing = true;
      return;
    }
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
    if (this.media) {
      this.media.pause();
      this.playing = false;
      return;
    }
    this.offset = this.currentTime;
    this.playing = false;
    this.stopSource();
  }

  toggle(): Promise<void> | void {
    if (this.playing) this.pause();
    else return this.play();
  }

  seek(time: number): void {
    const duration = this.media ? this.mediaDuration : this.buffer?.duration ?? 0;
    const next = Math.max(0, Math.min(duration, time));
    if (this.media) {
      this.media.currentTime = next;
      return;
    }
    const wasPlaying = this.playing;
    this.playing = false;
    this.stopSource();
    this.offset = next;
    if (wasPlaying) void this.play();
  }

  get currentTime(): number {
    if (this.media) return Math.min(this.mediaDuration, Math.max(0, this.media.currentTime || 0));
    if (!this.buffer) return 0;
    if (!this.playing || !this.context) return this.offset;
    return Math.min(this.buffer.duration, this.offset + this.context.currentTime - this.startedAt);
  }

  get isPlaying(): boolean {
    return this.media ? this.playing && !this.media.paused && !this.media.ended : this.playing;
  }

  get hasAudio(): boolean {
    return Boolean(this.media || this.buffer);
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

  private clearMedia(): void {
    if (this.media) {
      this.media.onended = null;
      this.media.pause();
      this.media.removeAttribute('src');
      this.media.load();
      this.media = null;
    }
    if (this.mediaUrl) {
      URL.revokeObjectURL(this.mediaUrl);
      this.mediaUrl = null;
    }
    this.mediaDuration = 0;
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
