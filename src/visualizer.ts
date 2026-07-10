import FFT from 'fft.js';
import { createPaletteLut, type PaletteName } from './palettes';
import type { SpectrogramData } from './types';

const AXIS_WIDTH = 38;
const AXIS_LABEL_INSET = 6;
const SPECTRAL_RULER = 25;
const UNLOADED_SPECTROGRAM_COLOR = 0xff000000;

export type PlaybackFollowMode = 'center' | 'right' | 'page';
export type SpectrumDrawStyle = 'outline' | 'filled' | 'bars' | 'lines' | 'points';
export type SpectrumInterpolation = 'nearest' | 'linear';
export type ThemeMode = 'dark' | 'light';

type PeakLevel = {
  blockSize: number;
  min: Float32Array;
  max: Float32Array;
};

type PointerPoint = { x: number; y: number; type: string };

type PinchGesture = {
  distance: number;
  anchorTime: number;
  startDuration: number;
};

type RulerLock = {
  step: number;
  width: number;
  duration: number;
  positions: number[];
};

type CanvasSurface = {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  scaleX: number;
  scaleY: number;
};

type SpectrumHover = {
  x: number;
  y: number;
};

type SpectrumHoverReadout = {
  bin: number;
  frequency: number;
  db: number;
  x: number;
  y: number;
};

type TextBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type SpectrumAxisLabel = {
  label: string;
  x: number;
  y: number;
  align: CanvasTextAlign;
  baseline: CanvasTextBaseline;
  font: string;
  bounds: TextBounds;
};

export type VisualizerOptions = {
  editor: HTMLElement;
  waveCanvas: HTMLCanvasElement;
  spectralCanvas: HTMLCanvasElement;
  spectrumCanvas: HTMLCanvasElement;
  playhead: HTMLElement;
  onSeek: (time: number) => void;
  onViewChange: (start: number, duration: number) => void;
};

class PeakPyramid {
  private levels: PeakLevel[] = [];

  constructor(private readonly samples: Float32Array, initialize = true) {
    if (!samples.length) return;
    this.allocate();
    if (initialize) this.update(0, samples.length);
  }

  update(start: number, end: number): void {
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(this.samples.length, Math.ceil(end));
    if (to <= from) return;

    for (let levelIndex = 0; levelIndex < this.levels.length; levelIndex += 1) {
      const level = this.levels[levelIndex];
      const firstBlock = Math.floor(from / level.blockSize);
      const lastBlock = Math.min(level.min.length, Math.ceil(to / level.blockSize));
      const previous = levelIndex > 0 ? this.levels[levelIndex - 1] : null;

      for (let block = firstBlock; block < lastBlock; block += 1) {
        let low = 1;
        let high = -1;
        if (!previous) {
          const sampleEnd = Math.min(this.samples.length, (block + 1) * level.blockSize);
          for (let index = block * level.blockSize; index < sampleEnd; index += 1) {
            const value = this.samples[index];
            if (value < low) low = value;
            if (value > high) high = value;
          }
        } else {
          const previousStart = block * 4;
          const previousEnd = Math.min(previous.min.length, previousStart + 4);
          for (let index = previousStart; index < previousEnd; index += 1) {
            if (previous.min[index] < low) low = previous.min[index];
            if (previous.max[index] > high) high = previous.max[index];
          }
        }
        level.min[block] = low <= high ? low : 0;
        level.max[block] = low <= high ? high : 0;
      }
    }
  }

  range(start: number, end: number): [number, number] {
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(this.samples.length, Math.max(from + 1, Math.ceil(end)));
    const span = to - from;
    let selected: PeakLevel | null = null;

    for (const level of this.levels) {
      if (level.blockSize <= span / 2) selected = level;
      else break;
    }

    let min = 1;
    let max = -1;
    if (!selected) {
      for (let i = from; i < to; i += 1) {
        const value = this.samples[i];
        if (value < min) min = value;
        if (value > max) max = value;
      }
      return min <= max ? [min, max] : [0, 0];
    }

    const first = Math.floor(from / selected.blockSize);
    const last = Math.min(selected.min.length, Math.ceil(to / selected.blockSize));
    for (let i = first; i < last; i += 1) {
      if (selected.min[i] < min) min = selected.min[i];
      if (selected.max[i] > max) max = selected.max[i];
    }
    return min <= max ? [min, max] : [0, 0];
  }

  private allocate(): void {
    let blockSize = 32;
    let count = Math.ceil(this.samples.length / blockSize);
    this.levels.push({ blockSize, min: new Float32Array(count), max: new Float32Array(count) });

    while (count > 4) {
      blockSize *= 4;
      count = Math.ceil(count / 4);
      this.levels.push({ blockSize, min: new Float32Array(count), max: new Float32Array(count) });
    }
  }
}

export class AudioVisualizer {
  private readonly editor: HTMLElement;
  private readonly waveCanvas: HTMLCanvasElement;
  private readonly spectralCanvas: HTMLCanvasElement;
  private readonly spectrumCanvas: HTMLCanvasElement;
  private readonly playhead: HTMLElement;
  private readonly onSeek: (time: number) => void;
  private readonly onViewChange: (start: number, duration: number) => void;
  private readonly pointers = new Map<number, PointerPoint>();
  private colorLut = createPaletteLut('viridis');
  private resizeObserver: ResizeObserver;
  private samples: Float32Array | null = null;
  private availableSamples = 0;
  private peaks: PeakPyramid | null = null;
  private spectrogram: SpectrogramData | null = null;
  private sampleRate = 48000;
  private duration = 0;
  private viewStart = 0;
  private viewDuration = 1;
  private scaleBlend = 1;
  private spectralRangeDb = 120;
  private renderFrame = 0;
  private analyzerFrame = 0;
  private cursorTime = 0;
  private spectrumAnalyzerOpen = false;
  private spectrumFftSize = 2048;
  private spectrumDrawStyle: SpectrumDrawStyle = 'filled';
  private spectrumInterpolation: SpectrumInterpolation = 'linear';
  private spectrumHover: SpectrumHover | null = null;
  private theme: ThemeMode = 'dark';
  private realtimeFft: FFT | null = null;
  private realtimeInput = new Float64Array(0);
  private realtimeWindow = new Float64Array(0);
  private realtimeComplex: number[] = [];
  private realtimeDb = new Float32Array(0);
  private pinch: PinchGesture | null = null;
  private scrubbingPointer: number | null = null;
  private touchSeekTimer = 0;
  private wasPinching = false;
  private playbackActive = false;
  private playbackFollowMode: PlaybackFollowMode = 'page';
  private rulerLock: RulerLock | null = null;

  constructor(options: VisualizerOptions) {
    this.editor = options.editor;
    this.waveCanvas = options.waveCanvas;
    this.spectralCanvas = options.spectralCanvas;
    this.spectrumCanvas = options.spectrumCanvas;
    this.playhead = options.playhead;
    this.onSeek = options.onSeek;
    this.onViewChange = options.onViewChange;

    this.resizeObserver = new ResizeObserver(() => {
      this.requestRender();
      this.requestAnalyzerRender();
    });
    this.resizeObserver.observe(this.waveCanvas);
    this.resizeObserver.observe(this.spectralCanvas);
    this.resizeObserver.observe(this.spectrumCanvas);
    this.bindInteractions();
    this.spectrumCanvas.addEventListener('pointermove', (event) => this.updateSpectrumHover(event));
    this.spectrumCanvas.addEventListener('pointerleave', () => this.setSpectrumHover(null));
    this.requestRender();
  }

  setAudio(samples: Float32Array, sampleRate: number, duration: number): void {
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.duration = duration;
    this.peaks = new PeakPyramid(samples);
    this.availableSamples = samples.length;
    this.viewStart = 0;
    this.viewDuration = Math.max(duration, 0.01);
    this.emitView();
    this.requestRender();
  }

  clearAudio(): void {
    this.samples = null;
    this.peaks = null;
    this.spectrogram = null;
    this.duration = 0;
    this.viewStart = 0;
    this.viewDuration = 1;
    this.availableSamples = 0;
    this.requestRender();
  }

  beginProgressiveAudio(samples: Float32Array, sampleRate: number, duration: number): void {
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.duration = duration;
    this.peaks = new PeakPyramid(samples, false);
    this.availableSamples = 0;
    this.viewStart = 0;
    this.viewDuration = Math.max(duration, 0.01);
    this.emitView();
    this.requestRender();
  }

  updateProgressiveAudio(start: number, end: number): void {
    this.peaks?.update(start, end);
    this.availableSamples = Math.max(this.availableSamples, Math.min(this.samples?.length ?? 0, end));
    this.requestRender();
  }

  setSpectrogram(data: SpectrogramData | null): void {
    this.spectrogram = data;
    this.requestRender();
    this.requestAnalyzerRender();
  }

  setSpectralRange(value: number): void {
    this.spectralRangeDb = Math.max(60, Math.min(140, value));
    this.requestRender();
    this.requestAnalyzerRender();
  }

  setColorPalette(palette: PaletteName): void {
    this.colorLut = createPaletteLut(palette);
    this.requestRender();
  }

  setScaleBlend(value: number): void {
    this.scaleBlend = Math.max(0, Math.min(1, value));
    this.requestRender();
    this.requestAnalyzerRender();
  }

  setSpectrumAnalyzerOpen(open: boolean): void {
    this.spectrumAnalyzerOpen = open;
    if (!open) this.setSpectrumHover(null);
    this.requestAnalyzerRender();
  }

  setSpectrumFftSize(fftSize: number): void {
    const next = Math.max(2, Math.round(fftSize));
    if (next === this.spectrumFftSize) return;
    this.spectrumFftSize = next;
    this.realtimeFft = null;
    this.requestAnalyzerRender();
  }

  setSpectrumDrawStyle(style: SpectrumDrawStyle): void {
    if (style === this.spectrumDrawStyle) return;
    this.spectrumDrawStyle = style;
    this.requestAnalyzerRender();
  }

  setSpectrumInterpolation(interpolation: SpectrumInterpolation): void {
    if (interpolation === this.spectrumInterpolation) return;
    this.spectrumInterpolation = interpolation;
    this.requestAnalyzerRender();
  }

  setTheme(theme: ThemeMode): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.requestRender();
    this.requestAnalyzerRender();
  }

  setPlaybackState(active: boolean, mode: PlaybackFollowMode): void {
    if (this.playbackActive === active && this.playbackFollowMode === mode) return;
    this.playbackActive = active;
    this.playbackFollowMode = mode;
    this.rulerLock = null;
    this.showPlayhead(this.cursorTime);
    this.requestRender();
    this.requestAnalyzerRender();
  }

  frequencyAtClientY(clientY: number): number {
    const rect = this.spectralCanvas.getBoundingClientRect();
    const plotHeight = Math.max(1, rect.height - SPECTRAL_RULER);
    const scaled = Math.max(0, Math.min(1, 1 - (clientY - rect.top - SPECTRAL_RULER) / plotHeight));
    const maxFrequency = this.sampleRate / 2;
    const minFrequency = this.minimumFrequency;
    return invertFrequencyScale(scaled, this.scaleBlend, maxFrequency, minFrequency) * maxFrequency;
  }

  scaleBlendForFrequencyAtClientY(frequency: number, clientY: number): number {
    const rect = this.spectralCanvas.getBoundingClientRect();
    const plotHeight = Math.max(1, rect.height - SPECTRAL_RULER);
    const target = Math.max(0, Math.min(1, 1 - (clientY - rect.top - SPECTRAL_RULER) / plotHeight));
    const maxFrequency = this.sampleRate / 2;
    const minFrequency = this.minimumFrequency;
    const normalized = Math.max(minFrequency / maxFrequency, Math.min(1, frequency / maxFrequency));
    const linearPosition = scaleFrequency(normalized, 0, maxFrequency, minFrequency);
    const logarithmicPosition = scaleFrequency(normalized, 1, maxFrequency, minFrequency);
    if (Math.abs(logarithmicPosition - linearPosition) < 1e-8) return this.scaleBlend;
    if (target <= linearPosition) return 0;
    if (target >= logarithmicPosition) return 1;

    let low = 0;
    let high = 1;
    for (let i = 0; i < 18; i += 1) {
      const middle = (low + high) / 2;
      if (scaleFrequency(normalized, middle, maxFrequency, minFrequency) < target) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  }

  resetView(): void {
    if (!this.duration) return;
    this.viewStart = 0;
    this.viewDuration = this.duration;
    this.emitView();
    this.requestRender();
  }

  moveViewportToStart(): void {
    if (!this.duration) return;
    this.setView(0, this.viewDuration);
  }

  showPlayhead(time: number): void {
    const changed = Math.abs(time - this.cursorTime) > 1e-9;
    this.cursorTime = time;
    if (this.playbackActive || changed) this.requestAnalyzerRender();
    if (!this.duration) {
      this.playhead.classList.remove('is-visible');
      return;
    }
    if (this.playbackActive && this.viewDuration < 1) {
      this.playhead.classList.remove('is-visible');
      return;
    }
    const width = this.timelinePlotWidth;
    const ratio = (time - this.viewStart) / this.viewDuration;
    if (ratio < 0 || ratio > 1) {
      this.playhead.classList.remove('is-visible');
      return;
    }
    const x = ratio * width;
    this.playhead.style.transform = `translate3d(${x}px, 0, 0)`;
    this.playhead.classList.add('is-visible');
  }

  follow(time: number): void {
    if (this.viewDuration >= this.duration * 0.999) return;
    if (this.playbackFollowMode === 'center') {
      this.setView(time - this.viewDuration * 0.5, this.viewDuration);
      return;
    }
    if (this.playbackFollowMode === 'right') {
      this.setView(time - this.viewDuration * 0.88, this.viewDuration);
      return;
    }
    if (time > this.viewStart + this.viewDuration * 0.94) {
      this.setView(time - this.viewDuration * 0.08, this.viewDuration);
    }
  }

  get zoomRatio(): number {
    return this.duration ? this.duration / this.viewDuration : 1;
  }

  get analysisColumnCount(): number {
    const dpr = window.devicePixelRatio || 1;
    return Math.max(1, Math.round(this.timelinePlotWidth * dpr));
  }

  private get timelinePlotWidth(): number {
    return Math.max(1, this.waveCanvas.getBoundingClientRect().width - AXIS_WIDTH);
  }

  private get minimumFrequency(): number {
    return 0;
  }

  private get isLightTheme(): boolean {
    return this.theme === 'light';
  }

  private get signalColor(): string {
    return this.isLightTheme ? '#177b57' : '#63efb4';
  }

  private get pointColor(): string {
    return this.isLightTheme ? '#000' : '#fff';
  }

  private bindInteractions(): void {
    this.editor.addEventListener('pointerdown', (event) => this.pointerDown(event));
    this.editor.addEventListener('pointermove', (event) => this.pointerMove(event));
    this.editor.addEventListener('pointerup', (event) => this.pointerUp(event));
    this.editor.addEventListener('pointercancel', (event) => this.pointerUp(event));
    this.editor.addEventListener('wheel', (event) => this.wheel(event), { passive: false });
    this.editor.addEventListener('dblclick', (event) => {
      if (!this.isTimelineEvent(event)) return;
      this.resetView();
    });
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.duration || event.button > 0 || !this.isTimelineEvent(event)) return;
    const point = this.eventPoint(event);
    this.pointers.set(event.pointerId, point);
    this.editor.setPointerCapture(event.pointerId);

    if (this.pointers.size === 2) {
      window.clearTimeout(this.touchSeekTimer);
      this.scrubbingPointer = null;
      this.wasPinching = true;
      const [a, b] = [...this.pointers.values()];
      const centerX = (a.x + b.x) / 2;
      this.pinch = {
        distance: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
        anchorTime: this.timeAtX(centerX),
        startDuration: this.viewDuration,
      };
      return;
    }

    this.wasPinching = false;
    if (event.pointerType === 'touch') {
      this.touchSeekTimer = window.setTimeout(() => {
        if (this.pointers.size !== 1) return;
        this.scrubbingPointer = event.pointerId;
        this.seekAtX(this.pointers.get(event.pointerId)?.x ?? point.x);
      }, 110);
    } else {
      this.scrubbingPointer = event.pointerId;
      this.seekAtX(point.x);
    }
  }

  private pointerMove(event: PointerEvent): void {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, this.eventPoint(event));

    if (this.pointers.size >= 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const centerX = (a.x + b.x) / 2;
      const distance = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const nextDuration = this.pinch.startDuration * (this.pinch.distance / distance);
      const clampedDuration = this.clampDuration(nextDuration);
      const plotWidth = this.timelinePlotWidth;
      const relativeX = centerX / plotWidth;
      this.setView(this.pinch.anchorTime - relativeX * clampedDuration, clampedDuration);
      return;
    }

    if (this.scrubbingPointer === event.pointerId && !this.wasPinching) {
      this.seekAtX(this.pointers.get(event.pointerId)!.x);
    }
  }

  private pointerUp(event: PointerEvent): void {
    const hadTwo = this.pointers.size >= 2;
    this.pointers.delete(event.pointerId);
    if (this.scrubbingPointer === event.pointerId) this.scrubbingPointer = null;
    window.clearTimeout(this.touchSeekTimer);

    if (hadTwo) {
      this.pinch = null;
      this.wasPinching = true;
    }
    if (this.pointers.size === 0) this.wasPinching = false;
  }

  private updateSpectrumHover(event: PointerEvent): void {
    if (!this.spectrumAnalyzerOpen) return;
    const rect = this.spectrumCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || x > rect.width || y < SPECTRAL_RULER || y > rect.height) {
      this.setSpectrumHover(null);
      return;
    }
    const previous = this.spectrumHover;
    if (previous && Math.abs(previous.y - y) < 0.25) return;
    this.spectrumHover = { x, y };
    this.requestAnalyzerRender();
  }

  private setSpectrumHover(hover: SpectrumHover | null): void {
    if (
      this.spectrumHover === hover ||
      (!this.spectrumHover && !hover)
    ) return;
    this.spectrumHover = hover;
    this.requestAnalyzerRender();
  }

  private wheel(event: WheelEvent): void {
    if (!this.duration || !this.isTimelineEvent(event)) return;
    event.preventDefault();
    const rect = this.editor.getBoundingClientRect();
    const x = event.clientX - rect.left;

    if (event.ctrlKey || event.metaKey) {
      const anchor = this.timeAtX(x);
      const nextDuration = this.clampDuration(this.viewDuration * Math.exp(event.deltaY * 0.008));
      const plotWidth = this.timelinePlotWidth;
      const ratio = x / plotWidth;
      this.setView(anchor - ratio * nextDuration, nextDuration);
      return;
    }

    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const plotWidth = this.timelinePlotWidth;
    this.setView(this.viewStart + (delta / plotWidth) * this.viewDuration, this.viewDuration);
  }

  private seekAtX(x: number): void {
    this.onSeek(this.timeAtX(x));
  }

  private timeAtX(x: number): number {
    const plotWidth = this.timelinePlotWidth;
    const ratio = Math.max(0, Math.min(1, x / plotWidth));
    return this.viewStart + ratio * this.viewDuration;
  }

  private eventPoint(event: PointerEvent): PointerPoint {
    const rect = this.editor.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, type: event.pointerType };
  }

  private isTimelineEvent(event: Event): boolean {
    return !(event.target instanceof Element && event.target.closest('[data-timeline-exempt]'));
  }

  private clampDuration(duration: number): number {
    return Math.max(Math.min(0.04, this.duration), Math.min(this.duration, duration));
  }

  private setView(start: number, duration: number): void {
    const nextDuration = this.clampDuration(duration);
    const nextStart = Math.max(0, Math.min(Math.max(0, this.duration - nextDuration), start));
    if (
      Math.abs(nextStart - this.viewStart) < 1e-7 &&
      Math.abs(nextDuration - this.viewDuration) < 1e-7
    ) return;
    this.viewStart = nextStart;
    this.viewDuration = nextDuration;
    this.emitView();
    this.requestRender();
  }

  private emitView(): void {
    this.onViewChange(this.viewStart, this.viewDuration);
  }

  private requestRender(): void {
    if (this.renderFrame) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = 0;
      this.drawWaveform();
      this.drawSpectrogram();
      this.requestAnalyzerRender();
    });
  }

  private requestAnalyzerRender(): void {
    if (!this.spectrumAnalyzerOpen || this.analyzerFrame) return;
    this.analyzerFrame = requestAnimationFrame(() => {
      this.analyzerFrame = 0;
      this.drawSpectrumAnalyzer();
    });
  }

  private prepareCanvas(canvas: HTMLCanvasElement): CanvasSurface {
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext('2d', { alpha: false })!;
    const scaleX = pixelWidth / width;
    const scaleY = pixelHeight / height;
    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    context.imageSmoothingEnabled = false;
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.filter = 'none';
    return { context, width, height, pixelWidth, pixelHeight, scaleX, scaleY };
  }

  private drawWaveform(): void {
    const canvas = this.waveCanvas;
    const surface = this.prepareCanvas(canvas);
    const {
      context,
      width,
      height,
      pixelHeight: physicalHeight,
      scaleX,
      scaleY,
    } = surface;
    const plotRight = width - AXIS_WIDTH;
    const plotWidth = Math.max(1, plotRight);
    const mid = height / 2;
    const waveHalfHeight = height / 2;
    const light = this.isLightTheme;
    context.fillStyle = light ? '#fff' : '#000';
    context.fillRect(0, 0, width, height);
    context.fillStyle = light ? '#fff' : '#000';
    context.fillRect(plotRight, 0, AXIS_WIDTH, height);

    this.drawTimeGrid(context, plotRight, height, 0, height, false, scaleX);

    const dbTicks = selectWaveformDbTicks(waveHalfHeight);
    context.font = '10px "Chivo Mono", ui-monospace, monospace';
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    for (const db of dbTicks) {
      const amplitude = 10 ** (db / 20);
      for (const sign of [-1, 1]) {
        const y = mid + sign * amplitude * waveHalfHeight;
        context.strokeStyle = db === 0
          ? (light ? 'rgba(56, 67, 75, .26)' : 'rgba(158, 181, 196, .14)')
          : (light ? 'rgba(56, 67, 75, .13)' : 'rgba(158, 181, 196, .08)');
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(0, snap(y, scaleY));
        context.lineTo(plotRight, snap(y, scaleY));
        context.stroke();
        if (sign < 0 || db !== 0) {
          context.fillStyle = db === 0
            ? (light ? '#56616a' : '#9aa6b2')
            : (light ? '#76818a' : '#687581');
          const labelY = Math.max(7, Math.min(height - 7, y));
          context.fillText(db === 0 ? '0 dB' : `${db}`, plotRight + AXIS_LABEL_INSET, labelY);
        }
      }
    }

    context.strokeStyle = light ? 'rgba(49, 59, 67, .3)' : 'rgba(188, 210, 222, .22)';
    context.beginPath();
    context.moveTo(0, snap(mid, scaleY));
    context.lineTo(plotRight, snap(mid, scaleY));
    context.stroke();
    context.fillStyle = light ? '#65717a' : '#5d6974';
    context.fillText('-∞', plotRight + AXIS_LABEL_INSET, mid);

    if (this.peaks && this.samples) {
      const physicalWidth = Math.max(1, Math.round(plotWidth * scaleX));
      const physicalMid = physicalHeight / 2;
      const physicalHalfHeight = physicalHeight / 2;
      const sampleStart = this.viewStart * this.sampleRate;
      const samplesPerPhysicalPixel = (this.viewDuration * this.sampleRate) / physicalWidth;
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.imageSmoothingEnabled = false;
      context.globalAlpha = 1;
      context.fillStyle = this.signalColor;
      for (let pixel = 0; pixel < physicalWidth; pixel += 1) {
        const from = sampleStart + pixel * samplesPerPhysicalPixel;
        if (from >= this.availableSamples) continue;
        const [min, max] = this.peaks.range(
          from,
          Math.min(this.availableSamples, from + samplesPerPhysicalPixel),
        );
        const top = Math.max(0, Math.min(physicalHeight - 1, Math.round(physicalMid - max * physicalHalfHeight)));
        const bottom = Math.max(top, Math.min(physicalHeight - 1, Math.round(physicalMid - min * physicalHalfHeight)));
        context.fillRect(pixel, top, 1, Math.max(1, bottom - top + 1));
      }
      context.restore();
    }

    this.drawWaveformBorder(surface, plotRight);
    context.fillStyle = light ? '#68747d' : '#74818d';
    context.font = '600 9px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'left';
    context.fillText('L+R', 9, 14);
  }

  private drawSpectrogram(): void {
    const canvas = this.spectralCanvas;
    const surface = this.prepareCanvas(canvas);
    const { context, width, height, scaleX, scaleY } = surface;
    const plotRight = width - AXIS_WIDTH;
    const plotBottom = height;
    const plotWidth = Math.max(1, plotRight);
    const plotHeight = Math.max(1, plotBottom - SPECTRAL_RULER);
    const isStreaming = Boolean(this.samples && this.availableSamples < this.samples.length);
    context.fillStyle = isStreaming ? '#000' : (this.isLightTheme ? '#fff' : '#000');
    context.fillRect(0, 0, width, height);

    if (this.spectrogram) {
      const pixelWidth = Math.max(1, Math.round(plotWidth * scaleX));
      const pixelHeight = Math.max(1, Math.round(plotHeight * scaleY));
      const image = context.createImageData(pixelWidth, pixelHeight);
      const packed = new Uint32Array(image.data.buffer);
      const { columns, rows, values, startTime, secondsPerColumn } = this.spectrogram;
      const maxFrequency = this.sampleRate / 2;
      const minFrequency = this.minimumFrequency;
      const minNormalized = minFrequency / maxFrequency;
      const rowMap = new Uint16Array(pixelHeight);
      const columnMap = new Int32Array(pixelWidth);
      const availableTime = this.availableSamples / this.sampleRate;

      for (let y = 0; y < pixelHeight; y += 1) {
        const scaled = 1 - y / Math.max(1, pixelHeight - 1);
        const frequency = invertFrequencyScale(scaled, this.scaleBlend, maxFrequency, minFrequency);
        const row = (frequency - minNormalized) / Math.max(1e-9, 1 - minNormalized);
        rowMap[y] = Math.min(rows - 1, Math.max(0, Math.round(row * (rows - 1))));
      }

      for (let x = 0; x < pixelWidth; x += 1) {
        const time = this.viewStart + (x / Math.max(1, pixelWidth - 1)) * this.viewDuration;
        if (isStreaming && time > availableTime) {
          columnMap[x] = -1;
          continue;
        }
        const columnFloat = (time - startTime) / secondsPerColumn;
        columnMap[x] = Math.max(0, Math.min(columns - 1, Math.round(columnFloat)));
      }

      for (let y = 0; y < pixelHeight; y += 1) {
        const row = rowMap[y];
        const offset = y * pixelWidth;
        for (let x = 0; x < pixelWidth; x += 1) {
          const column = columnMap[x];
          if (column < 0) {
            packed[offset + x] = UNLOADED_SPECTROGRAM_COLOR;
            continue;
          }
          const db = values[column * rows + row] / 10;
          const normalized = Math.max(0, Math.min(1, (db + this.spectralRangeDb) / this.spectralRangeDb));
          const paletteIndex = Math.round(normalized * 255);
          packed[offset + x] = this.colorLut[this.isLightTheme ? 255 - paletteIndex : paletteIndex];
        }
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.putImageData(image, 0, Math.round(SPECTRAL_RULER * scaleY));
      context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    }

    context.fillStyle = this.isLightTheme ? '#fff' : '#000';
    context.fillRect(plotRight, 0, AXIS_WIDTH, height);
    context.fillStyle = this.isLightTheme ? '#fff' : '#000';
    context.fillRect(0, 0, plotWidth, SPECTRAL_RULER);

    this.drawTimeGrid(context, plotRight, height, SPECTRAL_RULER, plotBottom, true, scaleX);
    this.drawFrequencyGrid(context, plotRight, plotBottom, plotHeight, scaleY);
  }

  private drawSpectrumAnalyzer(): void {
    if (!this.spectrumAnalyzerOpen) return;
    const canvas = this.spectrumCanvas;
    const surface = this.prepareCanvas(canvas);
    const { context, width, height, pixelWidth: physicalWidth, pixelHeight: physicalHeight, scaleX, scaleY } = surface;
    context.imageSmoothingEnabled = false;
    const light = this.isLightTheme;
    context.fillStyle = light ? '#fff' : '#000';
    context.fillRect(0, 0, width, height);
    context.fillStyle = light ? '#fff' : '#000';
    context.fillRect(0, 0, width, SPECTRAL_RULER);

    const plotTop = Math.min(physicalHeight - 1, Math.round(SPECTRAL_RULER * scaleY));
    const plotHeight = Math.max(1, physicalHeight - plotTop);
    const spectrum = this.computeRealtimeSpectrum();
    const hover = spectrum
      ? this.spectrumHoverReadout(spectrum, physicalWidth, plotTop, plotHeight, scaleY)
      : null;
    const amplitudeTicks = this.spectrumAmplitudeTicks(width);
    const hoverLabels = hover
      ? this.spectrumHoverAxisLabels(context, hover, width, height, scaleX, scaleY)
      : [];
    this.drawSpectrumAnalyzerGrid(context, width, height, amplitudeTicks, scaleX, scaleY);

    context.strokeStyle = light ? 'rgba(48, 59, 67, .23)' : 'rgba(196, 216, 230, .15)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, SPECTRAL_RULER - 0.5);
    context.lineTo(width, SPECTRAL_RULER - 0.5);
    context.stroke();

    this.drawSpectrumAmplitudeLabels(context, amplitudeTicks, hoverLabels);

    if (!spectrum || width <= 0 || height <= SPECTRAL_RULER) return;
    const trace = this.spectrumDrawStyle === 'filled' || this.spectrumDrawStyle === 'outline'
      ? this.spectrumTrace(spectrum, physicalWidth, plotHeight)
      : null;

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = false;
    context.globalAlpha = 1;
    if (this.spectrumDrawStyle === 'filled') {
      context.fillStyle = this.signalColor;
      for (let row = 0; row < trace!.length; row += 1) {
        context.fillRect(0, plotTop + row, trace![row] + 1, 1);
      }
    } else if (
      this.spectrumDrawStyle === 'bars' ||
      this.spectrumDrawStyle === 'lines' ||
      this.spectrumDrawStyle === 'points'
    ) {
      context.fillStyle = this.spectrumDrawStyle === 'points' ? this.pointColor : this.signalColor;
      this.drawSpectrumBins(
        context,
        spectrum,
        physicalWidth,
        plotTop,
        plotHeight,
        this.spectrumDrawStyle,
      );
    } else {
      context.fillStyle = this.signalColor;
      this.drawSpectrumOutline(context, spectrum, trace!, physicalWidth, plotTop, plotHeight);
    }
    context.restore();

    if (hover) this.drawSpectrumHoverGuides(context, hover, plotTop);
    this.drawSpectrumHoverLabels(context, hoverLabels);
  }

  private spectrumHoverReadout(
    spectrum: Float32Array,
    physicalWidth: number,
    plotTop: number,
    plotHeight: number,
    scaleY: number,
  ): SpectrumHoverReadout | null {
    const hover = this.spectrumHover;
    if (!hover || !spectrum.length) return null;

    const hoverY = hover.y * scaleY;
    if (hoverY < plotTop || hoverY > plotTop + plotHeight - 1) return null;

    const maxFrequency = this.sampleRate / 2;
    const minFrequency = this.minimumFrequency;
    const minNormalized = minFrequency / maxFrequency;
    const scaled = Math.max(0, Math.min(1, 1 - (hoverY - plotTop) / Math.max(1, plotHeight - 1)));
    const normalizedFrequency = invertFrequencyScale(
      scaled,
      this.scaleBlend,
      maxFrequency,
      minFrequency,
    );
    const binPosition = ((normalizedFrequency - minNormalized) / Math.max(1e-9, 1 - minNormalized))
      * Math.max(0, spectrum.length - 1);
    const bin = Math.max(0, Math.min(spectrum.length - 1, Math.round(binPosition)));
    const normalizedBin = bin / Math.max(1, spectrum.length - 1);
    const binScaled = scaleFrequency(normalizedBin, this.scaleBlend, maxFrequency, minFrequency);
    const y = plotTop + plotHeight - 1 - Math.round(binScaled * Math.max(1, plotHeight - 1));
    const db = spectrum[bin];

    return {
      bin,
      // The display uses the existing scaled-bin geometry; the readout itself reports
      // the true real-FFT bin center frequency.
      frequency: (bin * this.sampleRate) / this.spectrumFftSize,
      db,
      x: spectrumPhysicalX(db, this.spectralRangeDb, physicalWidth),
      y,
    };
  }

  private spectrumHoverAxisLabels(
    context: CanvasRenderingContext2D,
    hover: SpectrumHoverReadout,
    width: number,
    height: number,
    scaleX: number,
    scaleY: number,
  ): SpectrumAxisLabel[] {
    const dbX = hover.x / scaleX;
    const dbLabelX = dbX < 24 ? 5 : dbX > width - 24 ? width - 5 : dbX;
    const dbLabel: SpectrumAxisLabel = {
      label: formatSpectrumDb(hover.db),
      x: dbLabelX,
      y: SPECTRAL_RULER / 2 + 0.5,
      align: dbX < 24 ? 'left' : dbX > width - 24 ? 'right' : 'center',
      baseline: 'middle',
      font: '9px "Chivo Mono", ui-monospace, monospace',
      bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    context.font = dbLabel.font;
    dbLabel.bounds = labelBounds(context, dbLabel);

    const frequencyY = hover.y / scaleY;
    const frequencyLabel: SpectrumAxisLabel = {
      label: formatFrequency(hover.frequency),
      x: 5,
      y: frequencyY,
      align: 'left',
      baseline: frequencyY <= SPECTRAL_RULER + 5
        ? 'top'
        : frequencyY >= height - 5
          ? 'bottom'
          : 'middle',
      font: '10px "Chivo Mono", ui-monospace, monospace',
      bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    };
    context.font = frequencyLabel.font;
    frequencyLabel.bounds = labelBounds(context, frequencyLabel);

    return [dbLabel, frequencyLabel];
  }

  private drawSpectrumAmplitudeLabels(
    context: CanvasRenderingContext2D,
    amplitudeTicks: Array<{ x: number; align: CanvasTextAlign; label: string }>,
    hoverLabels: SpectrumAxisLabel[],
  ): void {
    context.fillStyle = '#65727d';
    context.font = '9px "Chivo Mono", ui-monospace, monospace';
    context.textBaseline = 'middle';
    for (const tick of amplitudeTicks) {
      const label: SpectrumAxisLabel = {
        label: tick.label,
        x: tick.x,
        y: SPECTRAL_RULER / 2 + 0.5,
        align: tick.align,
        baseline: 'middle',
        font: context.font,
        bounds: { left: 0, top: 0, right: 0, bottom: 0 },
      };
      label.bounds = labelBounds(context, label);
      if (hoverLabels.some((hoverLabel) => labelsIntersect(label.bounds, hoverLabel.bounds))) continue;
      context.textAlign = tick.align;
      context.fillText(tick.label, tick.x, label.y);
    }
  }

  private drawSpectrumHoverGuides(
    context: CanvasRenderingContext2D,
    hover: SpectrumHoverReadout,
    plotTop: number,
  ): void {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = false;
    context.fillStyle = this.isLightTheme ? '#53636c' : '#a7b6bf';
    // Both guides terminate at the rendered FFT-bin point rather than at the raw pointer.
    context.fillRect(0, hover.y, hover.x + 1, 1);
    context.fillRect(hover.x, plotTop, 1, hover.y - plotTop + 1);
    context.restore();
  }

  private drawSpectrumHoverLabels(
    context: CanvasRenderingContext2D,
    labels: SpectrumAxisLabel[],
  ): void {
    if (!labels.length) return;
    context.fillStyle = '#65727d';
    for (const label of labels) {
      context.font = label.font;
      context.textAlign = label.align;
      context.textBaseline = label.baseline;
      context.fillText(label.label, label.x, label.y);
    }
  }

  private drawSpectrumBins(
    context: CanvasRenderingContext2D,
    spectrum: Float32Array,
    physicalWidth: number,
    plotTop: number,
    plotHeight: number,
    style: 'bars' | 'lines' | 'points',
  ): void {
    const maxFrequency = this.sampleRate / 2;
    const minFrequency = this.minimumFrequency;
    context.beginPath();
    for (let bin = 0; bin < spectrum.length; bin += 1) {
      const normalized = bin / Math.max(1, spectrum.length - 1);
      const scaled = scaleFrequency(normalized, this.scaleBlend, maxFrequency, minFrequency);
      const x = spectrumPhysicalX(spectrum[bin], this.spectralRangeDb, physicalWidth);
      const y = plotTop + plotHeight - 1 - Math.round(scaled * Math.max(1, plotHeight - 1));
      if (style === 'lines') {
        context.rect(0, y, x + 1, 1);
      } else if (style === 'points') {
        context.rect(x, y, 1, 1);
      } else {
        const lowerBoundary = Math.max(0, (bin - 0.5) / Math.max(1, spectrum.length - 1));
        const upperBoundary = Math.min(1, (bin + 0.5) / Math.max(1, spectrum.length - 1));
        const lowerY = this.spectrumBinBoundaryY(lowerBoundary, plotTop, plotHeight);
        const upperY = this.spectrumBinBoundaryY(upperBoundary, plotTop, plotHeight);
        const top = Math.min(lowerY, upperY);
        const height = Math.abs(lowerY - upperY);
        context.rect(0, top, x + 1, Math.max(1, height - 1));
      }
    }
    context.fill();
  }

  private spectrumBinBoundaryY(normalized: number, plotTop: number, plotHeight: number): number {
    const scaled = scaleFrequency(
      normalized,
      this.scaleBlend,
      this.sampleRate / 2,
      this.minimumFrequency,
    );
    return plotTop + plotHeight - Math.round(scaled * plotHeight);
  }

  private drawSpectrumAnalyzerGrid(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    amplitudeTicks: Array<{ gridX: number }>,
    scaleX: number,
    scaleY: number,
  ): void {
    if (width <= 0 || height <= SPECTRAL_RULER) return;
    context.save();
    context.lineWidth = 1;
    context.strokeStyle = this.isLightTheme
      ? 'rgba(48, 59, 67, .16)'
      : 'rgba(190, 211, 225, .11)';
    context.beginPath();
    for (const tick of amplitudeTicks) {
      const x = tick.gridX <= 0 ? 0.5 : tick.gridX >= width ? width - 0.5 : tick.gridX;
      context.moveTo(snap(x, scaleX), SPECTRAL_RULER);
      context.lineTo(snap(x, scaleX), height);
    }

    const maxFrequency = this.sampleRate / 2;
    const minFrequency = this.minimumFrequency;
    const plotHeight = height - SPECTRAL_RULER;
    const candidates = frequencyTicks(maxFrequency, this.scaleBlend, minFrequency);
    let lastY = Number.POSITIVE_INFINITY;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const frequency = candidates[index];
      const scaled = scaleFrequency(frequency / maxFrequency, this.scaleBlend, maxFrequency, minFrequency);
      const y = height - scaled * plotHeight;
      if (frequency !== minFrequency && Math.abs(y - height) < 21) continue;
      if (Math.abs(y - lastY) < 21 && frequency !== minFrequency && frequency !== maxFrequency) continue;
      lastY = y;
      const snappedY = Math.max(
        SPECTRAL_RULER + 0.5,
        Math.min(height - 0.5, snap(y, scaleY)),
      );
      context.moveTo(0, snappedY);
      context.lineTo(width, snappedY);
    }
    context.stroke();
    context.restore();
  }

  private spectrumAmplitudeTicks(width: number): Array<{
    gridX: number;
    x: number;
    align: CanvasTextAlign;
    label: string;
  }> {
    const range = this.spectralRangeDb;
    const maximumLabels = Math.max(3, Math.floor(width / 78) + 1);
    const candidates = [3, 6, 10, 12, 15, 20, 30, 40, 60];
    const step = candidates.find((candidate) => Math.ceil(range / candidate) + 1 <= maximumLabels) ?? range;
    const values = [-range];
    for (let db = -range + step; db < -1e-6; db += step) values.push(db);
    if (values[values.length - 1] !== 0) values.push(0);

    return values.map((db) => {
      const gridX = ((db + range) / range) * width;
      const atMinimum = db <= -range + 1e-6;
      const atMaximum = db >= -1e-6;
      return {
        gridX,
        x: atMinimum ? 5 : atMaximum ? width - 5 : gridX,
        align: atMinimum ? 'left' : atMaximum ? 'right' : 'center',
        label: formatSpectrumDb(db),
      };
    });
  }

  private spectrumTrace(
    spectrum: Float32Array,
    physicalWidth: number,
    plotHeight: number,
  ): Int32Array {
    const trace = new Int32Array(plotHeight);
    const maxFrequency = this.sampleRate / 2;
    const minFrequency = this.minimumFrequency;
    const minNormalized = minFrequency / maxFrequency;
    for (let row = 0; row < plotHeight; row += 1) {
      const scaled = 1 - row / Math.max(1, plotHeight - 1);
      const frequency = invertFrequencyScale(scaled, this.scaleBlend, maxFrequency, minFrequency);
      const normalizedBin = (frequency - minNormalized) / Math.max(1e-9, 1 - minNormalized);
      const binPosition = Math.max(0, Math.min(spectrum.length - 1, normalizedBin * (spectrum.length - 1)));
      let db: number;
      if (this.spectrumInterpolation === 'linear') {
        const lowBin = Math.floor(binPosition);
        const highBin = Math.min(spectrum.length - 1, lowBin + 1);
        const mix = binPosition - lowBin;
        db = spectrum[lowBin] + (spectrum[highBin] - spectrum[lowBin]) * mix;
      } else {
        db = spectrum[Math.round(binPosition)];
      }
      trace[row] = spectrumPhysicalX(db, this.spectralRangeDb, physicalWidth);
    }
    return trace;
  }

  private drawSpectrumOutline(
    context: CanvasRenderingContext2D,
    spectrum: Float32Array,
    trace: Int32Array,
    physicalWidth: number,
    plotTop: number,
    plotHeight: number,
  ): void {
    if (this.spectrumInterpolation === 'nearest') {
      let previousX = trace[0];
      let previousY = plotTop;
      context.fillRect(previousX, previousY, 1, 1);
      for (let row = 1; row < trace.length; row += 1) {
        const x = trace[row];
        const y = plotTop + row;
        drawPixelLine(context, previousX, previousY, x, y);
        previousX = x;
        previousY = y;
      }
      return;
    }

    const maxFrequency = this.sampleRate / 2;
    const minFrequency = this.minimumFrequency;
    let previousX = spectrumPhysicalX(spectrum[0], this.spectralRangeDb, physicalWidth);
    let previousY = plotTop + plotHeight - 1;
    context.fillRect(previousX, previousY, 1, 1);
    for (let bin = 1; bin < spectrum.length; bin += 1) {
      const normalized = bin / Math.max(1, spectrum.length - 1);
      const scaled = scaleFrequency(normalized, this.scaleBlend, maxFrequency, minFrequency);
      const x = spectrumPhysicalX(spectrum[bin], this.spectralRangeDb, physicalWidth);
      const y = plotTop + plotHeight - 1 - Math.round(scaled * Math.max(1, plotHeight - 1));
      drawPixelLine(context, previousX, previousY, x, y);
      previousX = x;
      previousY = y;
    }
  }

  private computeRealtimeSpectrum(): Float32Array | null {
    if (!this.samples || this.availableSamples <= 0 || this.cursorTime < 0 || this.cursorTime > this.duration) {
      return null;
    }
    this.prepareRealtimeFft();
    const fft = this.realtimeFft!;
    const center = Math.round(this.cursorTime * this.sampleRate);
    const start = center - Math.floor(this.spectrumFftSize / 2);
    if (center >= this.availableSamples + this.spectrumFftSize / 2) return null;

    for (let index = 0; index < this.spectrumFftSize; index += 1) {
      const source = start + index;
      const sample = source >= 0 && source < this.availableSamples ? this.samples[source] : 0;
      this.realtimeInput[index] = sample * this.realtimeWindow[index];
    }
    fft.realTransform(this.realtimeComplex, this.realtimeInput);
    for (let bin = 0; bin < this.realtimeDb.length; bin += 1) {
      const real = this.realtimeComplex[bin * 2];
      const imaginary = this.realtimeComplex[bin * 2 + 1];
      const magnitude = Math.sqrt(real * real + imaginary * imaginary) * (4 / this.spectrumFftSize);
      this.realtimeDb[bin] = 20 * Math.log10(Math.max(magnitude, 1e-10));
    }
    return this.realtimeDb;
  }

  private prepareRealtimeFft(): void {
    if (this.realtimeFft?.size === this.spectrumFftSize) return;
    this.realtimeFft = new FFT(this.spectrumFftSize);
    this.realtimeInput = new Float64Array(this.spectrumFftSize);
    this.realtimeWindow = new Float64Array(this.spectrumFftSize);
    this.realtimeComplex = this.realtimeFft.createComplexArray();
    this.realtimeDb = new Float32Array(this.spectrumFftSize / 2);
    for (let index = 0; index < this.spectrumFftSize; index += 1) {
      this.realtimeWindow[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (this.spectrumFftSize - 1));
    }
  }

  private drawTimeGrid(
    context: CanvasRenderingContext2D,
    plotRight: number,
    height: number,
    plotTop: number,
    plotBottom: number,
    withLabels: boolean,
    scaleX: number,
  ): void {
    if (!this.duration) return;
    const plotWidth = plotRight;
    const step = niceStep(this.viewDuration / Math.max(2, plotWidth / 105));
    const ticks = this.timeTicks(plotWidth, step);
    context.font = '10px "Chivo Mono", ui-monospace, monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    for (const tick of ticks) {
      const { time, x } = tick;
      if (x < -1 || x > plotRight + 1) continue;
      context.strokeStyle = withLabels
        ? (this.isLightTheme ? 'rgba(49, 59, 67, .2)' : 'rgba(183, 202, 219, .13)')
        : (this.isLightTheme ? 'rgba(49, 59, 67, .13)' : 'rgba(183, 202, 219, .07)');
      context.lineWidth = 1;
      context.beginPath();
      if (withLabels) {
        context.moveTo(snap(x, scaleX), SPECTRAL_RULER - 4);
        context.lineTo(snap(x, scaleX), SPECTRAL_RULER);
      } else {
        context.moveTo(snap(x, scaleX), plotTop);
        context.lineTo(snap(x, scaleX), plotBottom);
      }
      context.stroke();
      if (withLabels) {
        context.fillStyle = this.isLightTheme ? '#68747d' : '#83909c';
        context.textAlign = x < 24 ? 'left' : x > plotRight - 24 ? 'right' : 'center';
        context.fillText(formatRuler(time, step), x, SPECTRAL_RULER / 2 + 0.5);
      }
    }

    if (withLabels) {
      context.strokeStyle = this.isLightTheme
        ? 'rgba(49, 59, 67, .24)'
        : 'rgba(196, 216, 230, .15)';
      context.beginPath();
      context.moveTo(0, SPECTRAL_RULER - 0.5);
      context.lineTo(plotRight, SPECTRAL_RULER - 0.5);
      context.stroke();
    }
    void height;
  }

  private timeTicks(plotWidth: number, step: number): Array<{ time: number; x: number }> {
    const lockPositions = this.playbackActive && step <= 0.1;
    if (!lockPositions) {
      this.rulerLock = null;
      const firstIndex = Math.ceil((this.viewStart - step * 1e-6) / step);
      const lastIndex = Math.floor((this.viewStart + this.viewDuration + step * 1e-6) / step);
      const ticks: Array<{ time: number; x: number }> = [];
      for (let index = firstIndex; index <= lastIndex; index += 1) {
        const time = index * step;
        ticks.push({ time, x: ((time - this.viewStart) / this.viewDuration) * plotWidth });
      }
      return ticks;
    }

    if (
      !this.rulerLock ||
      this.rulerLock.step !== step ||
      this.rulerLock.width !== plotWidth ||
      Math.abs(this.rulerLock.duration - this.viewDuration) > 1e-9
    ) {
      const firstIndex = Math.ceil((this.viewStart - step * 1e-6) / step);
      const lastIndex = Math.floor((this.viewStart + this.viewDuration + step * 1e-6) / step);
      const positions: number[] = [];
      for (let index = firstIndex; index <= lastIndex; index += 1) {
        const time = index * step;
        positions.push(((time - this.viewStart) / this.viewDuration) * plotWidth);
      }
      this.rulerLock = { step, width: plotWidth, duration: this.viewDuration, positions };
    }

    return this.rulerLock.positions.map((x) => ({
      x,
      time: this.viewStart + (x / Math.max(1, plotWidth)) * this.viewDuration,
    }));
  }

  private drawFrequencyGrid(
    context: CanvasRenderingContext2D,
    plotRight: number,
    plotBottom: number,
    plotHeight: number,
    scaleY: number,
  ): void {
    const maxFrequency = this.sampleRate / 2;
    const minFrequency = this.minimumFrequency;
    const candidates = frequencyTicks(maxFrequency, this.scaleBlend, minFrequency);
    context.font = '10px "Chivo Mono", ui-monospace, monospace';
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    let lastY = Number.POSITIVE_INFINITY;

    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const frequency = candidates[i];
      const scaled = scaleFrequency(frequency / maxFrequency, this.scaleBlend, maxFrequency, minFrequency);
      const y = plotBottom - scaled * plotHeight;
      if (frequency !== minFrequency && Math.abs(y - plotBottom) < 21) continue;
      if (
        Math.abs(y - lastY) < 21 &&
        frequency !== minFrequency &&
        frequency !== maxFrequency
      ) continue;
      lastY = y;
      context.strokeStyle = this.isLightTheme
        ? 'rgba(49, 59, 67, .24)'
        : 'rgba(190, 211, 225, .16)';
      context.beginPath();
      context.moveTo(plotRight, snap(y, scaleY));
      context.lineTo(plotRight + 4, snap(y, scaleY));
      context.stroke();
      context.fillStyle = this.isLightTheme ? '#68747d' : '#75828e';
      context.textBaseline = frequency === maxFrequency
        ? 'top'
        : frequency === minFrequency
          ? 'bottom'
          : 'middle';
      context.fillText(formatFrequency(frequency), plotRight + AXIS_LABEL_INSET, y);
    }
  }

  private drawWaveformBorder(surface: CanvasSurface, plotRight: number): void {
    const { context, pixelHeight, scaleX, scaleY } = surface;
    const right = Math.max(1, Math.round(plotRight * scaleX));
    const borderX = Math.max(1, Math.round(scaleX));
    const borderY = Math.max(1, Math.round(scaleY));
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = this.isLightTheme
      ? 'rgba(49, 59, 67, .32)'
      : 'rgba(190, 210, 224, .16)';
    context.fillRect(0, 0, right, borderY);
    context.fillRect(0, Math.max(0, pixelHeight - borderY), right, borderY);
    context.fillRect(0, 0, borderX, pixelHeight);
    context.fillRect(Math.max(0, right - borderX), 0, borderX, pixelHeight);
    context.restore();
  }
}

function rawFrequencyScale(normalized: number, blend: number, maxFrequency: number): number {
  const ratio = maxFrequency / 20;
  const logarithmic = Math.log1p(normalized * ratio) / Math.log1p(ratio);
  return normalized * (1 - blend) + logarithmic * blend;
}

function scaleFrequency(
  normalized: number,
  blend: number,
  maxFrequency: number,
  minFrequency: number,
): number {
  const floor = rawFrequencyScale(minFrequency / maxFrequency, blend, maxFrequency);
  return (rawFrequencyScale(normalized, blend, maxFrequency) - floor) / Math.max(1e-9, 1 - floor);
}

function invertFrequencyScale(
  scaled: number,
  blend: number,
  maxFrequency: number,
  minFrequency: number,
): number {
  let low = minFrequency / maxFrequency;
  let high = 1;
  for (let i = 0; i < 15; i += 1) {
    const middle = (low + high) / 2;
    if (scaleFrequency(middle, blend, maxFrequency, minFrequency) < scaled) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function frequencyTicks(maxFrequency: number, blend: number, minFrequency: number): number[] {
  const logarithmic = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 20000];
  const linearStep = niceStep(maxFrequency / 6);
  const linear: number[] = [];
  for (let value = linearStep; value <= maxFrequency; value += linearStep) linear.push(value);
  const source = blend < 0.32 ? linear : blend > 0.7 ? logarithmic : [...linear, ...logarithmic];
  source.push(minFrequency, maxFrequency);
  return [...new Set(source.filter((value) => value >= minFrequency && value <= maxFrequency))].sort((a, b) => a - b);
}

function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

function formatFrequency(frequency: number): string {
  if (frequency >= 1000) {
    const value = frequency / 1000;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k`;
  }
  if (!Number.isInteger(frequency)) return frequency.toFixed(frequency < 100 ? 1 : 0);
  return `${Math.round(frequency)}`;
}

function formatSpectrumDb(value: number): string {
  const rounded = Math.round(value);
  return rounded === 0 ? '0' : `${rounded}`;
}

function labelBounds(context: CanvasRenderingContext2D, label: SpectrumAxisLabel): TextBounds {
  const metrics = context.measureText(label.label);
  const width = metrics.width;
  const ascent = metrics.actualBoundingBoxAscent || fontPixelSize(label.font) * 0.72;
  const descent = metrics.actualBoundingBoxDescent || fontPixelSize(label.font) * 0.28;
  let left = label.x;
  if (label.align === 'center') left -= width / 2;
  else if (label.align === 'right' || label.align === 'end') left -= width;
  const right = left + width;

  let top = label.y - ascent;
  let bottom = label.y + descent;
  if (label.baseline === 'top' || label.baseline === 'hanging') {
    top = label.y;
    bottom = top + ascent + descent;
  } else if (label.baseline === 'bottom' || label.baseline === 'ideographic') {
    bottom = label.y;
    top = bottom - ascent - descent;
  } else if (label.baseline === 'middle') {
    top = label.y - (ascent + descent) / 2;
    bottom = label.y + (ascent + descent) / 2;
  }
  return { left, top, right, bottom };
}

function labelsIntersect(a: TextBounds, b: TextBounds): boolean {
  const inset = 1;
  return a.left - inset < b.right && a.right + inset > b.left && a.top - inset < b.bottom && a.bottom + inset > b.top;
}

function fontPixelSize(font: string): number {
  const match = /([0-9.]+)px/.exec(font);
  return match ? Number(match[1]) : 10;
}

function selectWaveformDbTicks(halfHeight: number): number[] {
  const minimumSpacing = 13;
  const selected: Array<{ db: number; position: number }> = [
    { db: Number.NEGATIVE_INFINITY, position: halfHeight },
  ];
  const priority = [
    0, -6, -12, -18, -24, -30, -36, -48,
    -3, -9, -15, -21, -27, -33, -39, -45,
  ];

  for (const db of priority) {
    const position = halfHeight * (1 - 10 ** (db / 20));
    if (db === 0 || selected.every((tick) => Math.abs(tick.position - position) >= minimumSpacing)) {
      selected.push({ db, position });
    }
  }

  return selected
    .filter((tick) => Number.isFinite(tick.db))
    .sort((a, b) => a.position - b.position)
    .map((tick) => tick.db);
}

function formatRuler(time: number, step: number): string {
  const precision = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const factor = 10 ** precision;
  const rounded = Math.round(Math.max(0, time) * factor) / factor;
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded - minutes * 60;
  const width = precision > 0 ? precision + 3 : 2;
  return `${minutes}:${seconds.toFixed(precision).padStart(width, '0')}`;
}

export function formatClock(time: number, precise = true): string {
  const safe = Math.max(0, time);
  const minutes = Math.floor(safe / 60);
  const seconds = Math.floor(safe % 60);
  const milliseconds = Math.floor((safe % 1) * 1000);
  return precise
    ? `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`
    : `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function drawPixelLine(
  context: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): void {
  let x = startX;
  let y = startY;
  const deltaX = Math.abs(endX - startX);
  const deltaY = Math.abs(endY - startY);
  const stepX = startX < endX ? 1 : -1;
  const stepY = startY < endY ? 1 : -1;
  let error = deltaX - deltaY;

  while (true) {
    context.fillRect(x, y, 1, 1);
    if (x === endX && y === endY) break;
    const doubled = error * 2;
    if (doubled > -deltaY) {
      error -= deltaY;
      x += stepX;
    }
    if (doubled < deltaX) {
      error += deltaX;
      y += stepY;
    }
  }
}

function spectrumPhysicalX(db: number, rangeDb: number, physicalWidth: number): number {
  const normalized = Math.max(0, Math.min(1, (db + rangeDb) / rangeDb));
  return Math.round(normalized * Math.max(0, physicalWidth - 1));
}

function snap(value: number, scale = window.devicePixelRatio || 1): number {
  const physicalWidth = Math.max(1, scale);
  return (Math.round(value * scale - physicalWidth / 2) + physicalWidth / 2) / scale;
}
