/** An inclusive-start, exclusive-end segment on the source timeline. */
export type PlaybackRange = readonly [start: number, end: number];

const RANGE_EPSILON = 0.0005;

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
  private activePlaybackRange: PlaybackRange | null = null;
  private mediaRangeAnimationFrame: number | null = null;

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
   * Sets the section used by subsequent playback. Passing `null` restores
   * normal full-file playback. Bounds are clamped to the source duration and
   * returned in their normalized form so callers can keep their UI in sync.
   */
  setPlaybackRange(range: PlaybackRange | null): PlaybackRange | null {
    const nextRange = this.normalizePlaybackRange(range);
    const previousRange = this.activePlaybackRange;
    const changed = previousRange?.[0] !== nextRange?.[0] || previousRange?.[1] !== nextRange?.[1];
    this.activePlaybackRange = nextRange;

    if (!changed || !this.playing) return this.playbackRange;

    if (this.media) {
      const current = this.currentTime;
      if (nextRange && (current < nextRange[0] || current >= nextRange[1] - RANGE_EPSILON)) {
        this.media.currentTime = nextRange[0];
      }
      this.ended = false;
      this.startMediaRangeMonitor();
      return this.playbackRange;
    }

    const current = this.currentTime;
    this.offset = current;
    this.stopSource();
    this.ended = false;
    this.startBufferSource();
    return this.playbackRange;
  }

  get playbackRange(): PlaybackRange | null {
    return this.activePlaybackRange ? [this.activePlaybackRange[0], this.activePlaybackRange[1]] : null;
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
    if (this.offset >= this.bufferPlaybackEnd - RANGE_EPSILON) {
      this.finishBufferPlayback();
      return;
    }
    if (this.offset < this.availableBufferPlaybackEnd) {
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
      this.finishMediaPlayback();
    };
    media.ontimeupdate = () => this.checkMediaRangeEnd(media);
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
    this.activePlaybackRange = null;
    this.stopMediaRangeMonitor();
  }

  /**
   * Starts playback, optionally replacing the active playback segment first.
   * A fresh ranged play always begins at that range's start, and ends by
   * invoking `onEnded` exactly like normal end-of-file playback.
   */
  async play(range?: PlaybackRange | null): Promise<void> {
    if (range !== undefined) this.setPlaybackRange(range);

    if (this.media) {
      if (this.playing) return;
      const media = this.media;
      const playbackRange = this.activePlaybackRange;
      if (playbackRange) {
        media.currentTime = playbackRange[0];
        this.ended = false;
      } else if (this.ended || this.currentTime >= this.mediaDuration - RANGE_EPSILON) {
        media.currentTime = 0;
        this.ended = false;
      }
      await media.play();
      if (this.media !== media) return;
      this.playing = true;
      this.startMediaRangeMonitor();
      return;
    }
    if (!this.buffer || this.playing) return;
    const context = this.getContext();
    await context.resume();

    const playbackRange = this.activePlaybackRange;
    if (playbackRange) {
      this.offset = playbackRange[0];
      this.ended = false;
    } else if (this.ended || this.offset >= this.buffer.duration - RANGE_EPSILON) {
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
      this.stopMediaRangeMonitor();
      return;
    }
    this.offset = this.currentTime;
    this.playing = false;
    this.waitingForBuffer = false;
    this.stopSource();
  }

  toggle(range?: PlaybackRange | null): Promise<void> | void {
    if (this.playing) this.pause();
    else return this.play(range);
  }

  /**
   * Moves the playhead. Passing a range also makes it the active range and
   * clamps this seek to it; omit the second argument for an ordinary timeline
   * seek without changing the current selection.
   */
  seek(time: number, range?: PlaybackRange | null): number {
    if (range !== undefined) this.setPlaybackRange(range);
    const requestedRange = range === undefined ? null : this.activePlaybackRange;
    const duration = this.media ? this.mediaDuration : this.playableBufferDuration;
    const lowerBound = requestedRange?.[0] ?? 0;
    const upperBound = requestedRange?.[1] ?? duration;
    const next = Math.max(lowerBound, Math.min(upperBound, Number.isFinite(time) ? time : 0));
    if (this.media) {
      this.ended = upperBound > 0 && next >= upperBound - RANGE_EPSILON;
      this.media.currentTime = next;
      if (this.playing) this.startMediaRangeMonitor();
      return next;
    }
    const wasPlaying = this.playing;
    this.playing = false;
    this.waitingForBuffer = false;
    this.stopSource();
    this.offset = next;
    const playbackEnd = this.bufferPlaybackEnd;
    this.ended = this.bufferComplete && playbackEnd > 0 && next >= playbackEnd - RANGE_EPSILON;
    if (wasPlaying) {
      this.playing = true;
      this.ended = false;
      this.startBufferSource();
    }
    return next;
  }

  get currentTime(): number {
    if (this.ended) return this.playbackEnd;
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
    this.activePlaybackRange = null;
  }

  private startBufferSource(): void {
    const buffer = this.buffer;
    if (!buffer || !this.playing) return;

    const playbackRange = this.activePlaybackRange;
    const rangeStart = playbackRange?.[0] ?? 0;
    const rangeEnd = this.bufferPlaybackEnd;
    if (this.offset < rangeStart) this.offset = rangeStart;

    const playableEnd = this.availableBufferPlaybackEnd;
    if (this.offset >= rangeEnd - RANGE_EPSILON) {
      this.offset = rangeEnd;
      this.sourceEndOffset = rangeEnd;
      this.finishBufferPlayback();
      return;
    }
    if (this.offset >= playableEnd) {
      this.sourceEndOffset = this.offset;
      if (this.bufferComplete) this.finishBufferPlayback();
      else this.waitingForBuffer = true;
      return;
    }

    const context = this.getContext();
    const source = context.createBufferSource();
    const startOffset = Math.max(rangeStart, Math.min(playableEnd, this.offset));
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
      source.disconnect();
      if (this.offset >= this.bufferPlaybackEnd - RANGE_EPSILON) {
        this.finishBufferPlayback();
      } else if (this.offset < this.availableBufferPlaybackEnd) {
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
    this.offset = this.bufferPlaybackEnd;
    this.sourceEndOffset = this.offset;
    this.ended = true;
    this.onEnded?.();
  }

  private finishMediaPlayback(): void {
    if (!this.playing) return;
    const media = this.media;
    const end = this.playbackEnd;
    this.stopMediaRangeMonitor();
    this.playing = false;
    this.ended = true;
    if (media && this.activePlaybackRange) {
      media.pause();
      if (Math.abs(media.currentTime - end) > RANGE_EPSILON) media.currentTime = end;
    }
    this.onEnded?.();
  }

  private get playableBufferDuration(): number {
    if (!this.buffer) return 0;
    return this.bufferComplete ? this.buffer.duration : this.availableBufferDuration;
  }

  private get bufferPlaybackEnd(): number {
    if (!this.buffer) return 0;
    return this.activePlaybackRange?.[1] ?? this.buffer.duration;
  }

  private get availableBufferPlaybackEnd(): number {
    return Math.min(this.playableBufferDuration, this.bufferPlaybackEnd);
  }

  private get playbackEnd(): number {
    if (this.media) return this.activePlaybackRange?.[1] ?? this.mediaDuration;
    return this.bufferPlaybackEnd;
  }

  private clampBufferTime(time: number): number {
    if (!this.buffer) return 0;
    return Math.max(0, Math.min(this.buffer.duration, Number.isFinite(time) ? time : 0));
  }

  private normalizePlaybackRange(range: PlaybackRange | null): PlaybackRange | null {
    if (!range) return null;
    const duration = this.media ? this.mediaDuration : this.buffer?.duration ?? 0;
    if (duration <= 0 || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) return null;
    const start = Math.max(0, Math.min(duration, range[0]));
    const end = Math.max(0, Math.min(duration, range[1]));
    return end > start ? [start, end] : null;
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
    this.stopMediaRangeMonitor();
    if (this.media) {
      this.media.onended = null;
      this.media.ontimeupdate = null;
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

  private startMediaRangeMonitor(): void {
    this.stopMediaRangeMonitor();
    const media = this.media;
    if (!media || !this.activePlaybackRange || !this.playing) return;

    const check = () => {
      this.mediaRangeAnimationFrame = null;
      if (!this.playing || this.media !== media) return;
      if (this.checkMediaRangeEnd(media)) return;
      this.mediaRangeAnimationFrame = window.requestAnimationFrame(check);
    };
    this.mediaRangeAnimationFrame = window.requestAnimationFrame(check);
  }

  private stopMediaRangeMonitor(): void {
    if (this.mediaRangeAnimationFrame === null) return;
    window.cancelAnimationFrame(this.mediaRangeAnimationFrame);
    this.mediaRangeAnimationFrame = null;
  }

  /** Returns true when this check completed playback. */
  private checkMediaRangeEnd(media: HTMLAudioElement): boolean {
    const playbackRange = this.activePlaybackRange;
    if (!this.playing || this.media !== media || !playbackRange) return false;
    if (media.currentTime < playbackRange[1] - RANGE_EPSILON) return false;
    this.finishMediaPlayback();
    return true;
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
