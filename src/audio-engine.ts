export class AudioEngine {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private media: HTMLAudioElement | null = null;
  private mediaUrl: string | null = null;
  private mediaDuration = 0;
  private startedAt = 0;
  private offset = 0;
  private sourceEndOffset = 0;
  private playing = false;
  private ended = false;
  private progressiveBuffer = false;
  private bufferComplete = true;
  private availableBufferDuration = 0;
  private waitingForBuffer = false;

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
    this.replaceBuffer(buffer, false, buffer.duration);
  }

  /**
   * Installs a buffer whose tail is still being filled by the decoder.  The
   * AudioBuffer has its final length from the WAV header, but sources are only
   * ever scheduled through `availableDuration`, so the unfilled tail cannot be
   * played as silence.
   */
  setProgressiveBuffer(buffer: AudioBuffer, availableDuration = 0): void {
    this.replaceBuffer(buffer, true, availableDuration);
  }

  /**
   * Extends the contiguous, decoded portion of a progressive buffer. If
   * playback reached the previous frontier, it resumes automatically as soon
   * as there is another sample to schedule.
   */
  updateProgressiveBufferAvailability(availableDuration: number, complete = false): void {
    if (!this.buffer || !this.progressiveBuffer) return;

    const next = this.clampBufferTime(availableDuration);
    this.availableBufferDuration = Math.max(this.availableBufferDuration, next);
    if (complete) {
      this.availableBufferDuration = this.buffer.duration;
      this.bufferComplete = true;
      this.progressiveBuffer = false;
    }

    if (!this.playing || !this.waitingForBuffer) return;
    if (this.offset < this.playableBufferDuration) {
      this.startBufferSource();
      return;
    }
    if (this.bufferComplete) this.finishBufferPlayback();
  }

  completeProgressiveBuffer(): void {
    if (!this.buffer || !this.progressiveBuffer) return;
    this.updateProgressiveBufferAvailability(this.buffer.duration, true);
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
      this.ended = true;
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
    this.sourceEndOffset = 0;
    this.ended = false;
    this.progressiveBuffer = false;
    this.bufferComplete = true;
    this.availableBufferDuration = 0;
    this.waitingForBuffer = false;
  }

  async play(): Promise<void> {
    if (this.media) {
      if (this.playing) return;
      const media = this.media;
      if (this.ended || this.currentTime >= this.mediaDuration - 0.001) {
        media.currentTime = 0;
        this.ended = false;
      }
      await media.play();
      if (this.media !== media) return;
      this.playing = true;
      return;
    }
    if (!this.buffer || this.playing) return;
    const context = this.getContext();
    await context.resume();

    if (this.ended || this.offset >= this.buffer.duration - 0.001) {
      this.offset = 0;
      this.ended = false;
    }
    this.playing = true;
    this.waitingForBuffer = false;
    this.startBufferSource();
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
    this.waitingForBuffer = false;
    this.stopSource();
  }

  toggle(): Promise<void> | void {
    if (this.playing) this.pause();
    else return this.play();
  }

  seek(time: number): number {
    const duration = this.media ? this.mediaDuration : this.playableBufferDuration;
    const next = Math.max(0, Math.min(duration, Number.isFinite(time) ? time : 0));
    if (this.media) {
      this.ended = duration > 0 && next >= duration - 0.0005;
      this.media.currentTime = next;
      return next;
    }
    const wasPlaying = this.playing;
    this.playing = false;
    this.waitingForBuffer = false;
    this.stopSource();
    this.offset = next;
    this.ended = this.bufferComplete && duration > 0 && next >= duration - 0.0005;
    if (wasPlaying) {
      this.playing = true;
      this.ended = false;
      this.startBufferSource();
    }
    return next;
  }

  get currentTime(): number {
    if (this.ended) return this.media ? this.mediaDuration : this.buffer?.duration ?? this.offset;
    if (this.media) return Math.min(this.mediaDuration, Math.max(0, this.media.currentTime || 0));
    if (!this.buffer) return 0;
    if (!this.playing || !this.context || this.waitingForBuffer || !this.source) return this.offset;
    return Math.min(this.sourceEndOffset, this.offset + this.context.currentTime - this.startedAt);
  }

  get isPlaying(): boolean {
    return this.media ? this.playing && !this.media.paused && !this.media.ended : this.playing;
  }

  get hasAudio(): boolean {
    return Boolean(this.media || this.buffer);
  }

  get hasEnded(): boolean {
    return this.ended;
  }

  get availableDuration(): number {
    return this.media ? this.mediaDuration : this.playableBufferDuration;
  }

  private replaceBuffer(buffer: AudioBuffer, progressive: boolean, availableDuration: number): void {
    this.playing = false;
    this.stopSource();
    this.clearMedia();
    this.buffer = buffer;
    this.offset = 0;
    this.sourceEndOffset = 0;
    this.ended = false;
    this.progressiveBuffer = progressive;
    this.bufferComplete = !progressive;
    this.availableBufferDuration = this.clampBufferTime(availableDuration);
    this.waitingForBuffer = false;
  }

  private startBufferSource(): void {
    const buffer = this.buffer;
    if (!buffer || !this.playing) return;

    const playableEnd = this.playableBufferDuration;
    if (this.offset >= playableEnd) {
      this.sourceEndOffset = this.offset;
      if (this.bufferComplete) this.finishBufferPlayback();
      else this.waitingForBuffer = true;
      return;
    }

    const context = this.getContext();
    const source = context.createBufferSource();
    const startOffset = Math.max(0, Math.min(playableEnd, this.offset));
    const duration = playableEnd - startOffset;
    const sourceEnd = Math.min(buffer.duration, startOffset + duration);
    source.buffer = buffer;
    source.connect(this.gain!);
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      if (!this.playing) return;

      this.offset = sourceEnd;
      this.sourceEndOffset = sourceEnd;
      if (this.offset < this.playableBufferDuration) {
        this.waitingForBuffer = false;
        this.startBufferSource();
      } else if (this.bufferComplete) {
        this.finishBufferPlayback();
      } else {
        this.waitingForBuffer = true;
      }
    };
    this.source = source;
    this.sourceEndOffset = sourceEnd;
    this.startedAt = context.currentTime;
    this.waitingForBuffer = false;
    source.start(0, startOffset, duration);
  }

  private finishBufferPlayback(): void {
    if (!this.playing) return;
    this.playing = false;
    this.waitingForBuffer = false;
    this.offset = this.buffer?.duration ?? this.offset;
    this.sourceEndOffset = this.offset;
    this.ended = true;
    this.onEnded?.();
  }

  private get playableBufferDuration(): number {
    if (!this.buffer) return 0;
    return this.bufferComplete ? this.buffer.duration : this.availableBufferDuration;
  }

  private clampBufferTime(time: number): number {
    if (!this.buffer) return 0;
    return Math.max(0, Math.min(this.buffer.duration, Number.isFinite(time) ? time : 0));
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
    this.sourceEndOffset = this.offset;
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
