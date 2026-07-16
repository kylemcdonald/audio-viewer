import FFT from 'fft.js';
import { buildCqtPlan, cqtColumnFromSpectrum, type CqtPlan } from './cqt';
import { createPaletteLut, type PaletteName } from './palettes';
import type { AnalysisMode, SpectrogramData } from './types';

const AXIS_WIDTH = 38;
const AXIS_LABEL_INSET = 6;
const SPECTRAL_RULER = 25;
const RENDER_WAVEFORM = 1 << 0;
const RENDER_WAVEFORM_OVERLAY = 1 << 1;
const RENDER_SPECTROGRAM = 1 << 2;
const RENDER_SPECTROGRAM_OVERLAY = 1 << 3;
const RENDER_TIMELINE =
  RENDER_WAVEFORM |
  RENDER_WAVEFORM_OVERLAY |
  RENDER_SPECTROGRAM |
  RENDER_SPECTROGRAM_OVERLAY;

export type PlaybackFollowMode = 'center' | 'right' | 'page';
export type SpectrumDrawStyle = 'outline' | 'filled' | 'bars' | 'lines' | 'points';
export type SpectrumInterpolation = 'nearest' | 'linear';
export type ThemeMode = 'dark' | 'light';
export type SelectionRange = {
  start: number;
  end: number;
};

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
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  scaleX: number;
  scaleY: number;
};

type SpectrogramRaster = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  data: SpectrogramData;
  colorLut: Uint32Array;
  height: number;
  scaleBlend: number;
  spectralRangeDb: number;
  theme: ThemeMode;
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

type FrequencyAxisTick = {
  frequency: number;
  y: number;
  baseline: CanvasTextBaseline;
};

type SelectionDrag = {
  pointerId: number;
  kind: 'range' | 'start' | 'end';
  anchor: number;
  startX: number;
  moved: boolean;
};

export type VisualizerOptions = {
  editor: HTMLElement;
  waveCanvas: HTMLCanvasElement;
  waveOverlayCanvas: HTMLCanvasElement;
  spectralCanvas: HTMLCanvasElement;
  spectralOverlayCanvas: HTMLCanvasElement;
  spectrumCanvas: HTMLCanvasElement;
  spectrumHoverFrequencyLabel: HTMLElement;
  spectrumHoverFrequencyMask: HTMLElement;
  playhead: HTMLElement;
  onSeek: (time: number) => void;
  onViewChange: (start: number, duration: number) => void;
  onSelectionChange?: (selection: SelectionRange | null) => void;
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

function createCanvasSurface(
  canvas: HTMLCanvasElement,
  alpha: boolean,
  dimensions?: { width: number; height: number },
): CanvasSurface {
  const context = canvas.getContext('2d', { alpha });
  if (!context) throw new Error('Failed to get 2D canvas context.');
  const bounds = dimensions ?? canvas.getBoundingClientRect();
  const surface: CanvasSurface = {
    canvas,
    context,
    width: 1,
    height: 1,
    pixelWidth: 1,
    pixelHeight: 1,
    scaleX: 1,
    scaleY: 1,
  };
  resizeCanvasSurface(surface, bounds.width, bounds.height);
  return surface;
}

function resizeCanvasSurface(surface: CanvasSurface, width: number, height: number): boolean {
  const nextWidth = Math.max(1, width);
  const nextHeight = Math.max(1, height);
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(nextWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(nextHeight * dpr));
  const changed =
    surface.width !== nextWidth ||
    surface.height !== nextHeight ||
    surface.pixelWidth !== pixelWidth ||
    surface.pixelHeight !== pixelHeight;

  if (surface.canvas.width !== pixelWidth || surface.canvas.height !== pixelHeight) {
    surface.canvas.width = pixelWidth;
    surface.canvas.height = pixelHeight;
  }
  surface.width = nextWidth;
  surface.height = nextHeight;
  surface.pixelWidth = pixelWidth;
  surface.pixelHeight = pixelHeight;
  surface.scaleX = pixelWidth / nextWidth;
  surface.scaleY = pixelHeight / nextHeight;
  return changed;
}

function setCanvasSurfaceSize(surface: CanvasSurface, width: number, height: number): boolean {
  const nextWidth = Math.max(1, width);
  const nextHeight = Math.max(1, height);
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(nextWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(nextHeight * dpr));
  const changed =
    surface.width !== nextWidth ||
    surface.height !== nextHeight ||
    surface.pixelWidth !== pixelWidth ||
    surface.pixelHeight !== pixelHeight;

  // Keep the existing backing store alive until its next render. Updating a
  // canvas's width or height clears it immediately, which otherwise exposes a
  // black frame between ResizeObserver and requestAnimationFrame while a pane
  // divider is being dragged.
  surface.width = nextWidth;
  surface.height = nextHeight;
  return changed;
}

function prepareCanvasSurface(surface: CanvasSurface): CanvasSurface {
  resizeCanvasSurface(surface, surface.width, surface.height);
  const { context, scaleX, scaleY } = surface;
  context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  context.imageSmoothingEnabled = false;
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  context.filter = 'none';
  return surface;
}

export class AudioVisualizer {
  private readonly editor: HTMLElement;
  private readonly waveCanvas: HTMLCanvasElement;
  private readonly spectralCanvas: HTMLCanvasElement;
  private readonly spectrumCanvas: HTMLCanvasElement;
  private readonly waveSurface: CanvasSurface;
  private readonly waveOverlaySurface: CanvasSurface;
  private readonly spectralSurface: CanvasSurface;
  private readonly spectralOverlaySurface: CanvasSurface;
  private readonly spectrumSurface: CanvasSurface;
  private readonly spectrumHoverFrequencyLabel: HTMLElement;
  private readonly spectrumHoverFrequencyMask: HTMLElement;
  private readonly playhead: HTMLElement;
  private readonly nativeSpectralToBlob: HTMLCanvasElement['toBlob'];
  private readonly onSeek: (time: number) => void;
  private readonly onViewChange: (start: number, duration: number) => void;
  private readonly onSelectionChange?: (selection: SelectionRange | null) => void;
  private readonly pointers = new Map<number, PointerPoint>();
  private readonly eventAbortController = new AbortController();
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
  private waveformAmplitudeGainDb = 0;
  private scaleBlend = 1;
  private spectralRangeDb = 120;
  private renderFrame = 0;
  private renderMask = 0;
  private analyzerFrame = 0;
  private spectrogramRaster: SpectrogramRaster | null = null;
  private disposed = false;
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
  private analysisMode: AnalysisMode = 'fft';
  private realtimeCqtPlan: CqtPlan | null = null;
  private realtimeCqtDb = new Float32Array(0);
  private pinch: PinchGesture | null = null;
  private scrubbingPointer: number | null = null;
  private touchSeekTimer = 0;
  private wasPinching = false;
  private playbackActive = false;
  private playbackFollowMode: PlaybackFollowMode = 'page';
  private rulerLock: RulerLock | null = null;
  private frequencyAxisTicks: FrequencyAxisTick[] = [];
  private selectionRange: SelectionRange | null = null;
  private selectionDraft: SelectionRange | null = null;
  private selectionDrag: SelectionDrag | null = null;

  constructor(options: VisualizerOptions) {
    this.editor = options.editor;
    this.waveCanvas = options.waveCanvas;
    this.spectralCanvas = options.spectralCanvas;
    this.spectrumCanvas = options.spectrumCanvas;
    this.waveSurface = createCanvasSurface(this.waveCanvas, false);
    this.waveOverlaySurface = createCanvasSurface(options.waveOverlayCanvas, true);
    this.spectralSurface = createCanvasSurface(this.spectralCanvas, false);
    this.spectralOverlaySurface = createCanvasSurface(options.spectralOverlayCanvas, true);
    this.spectrumSurface = createCanvasSurface(this.spectrumCanvas, false);
    this.spectrumHoverFrequencyLabel = options.spectrumHoverFrequencyLabel;
    this.spectrumHoverFrequencyMask = options.spectrumHoverFrequencyMask;
    this.playhead = options.playhead;
    this.nativeSpectralToBlob = this.spectralCanvas.toBlob.bind(this.spectralCanvas);
    // The screenshot control serializes this canvas directly. Keep the live
    // ruler labels on-screen, but route serialization through a clean
    // offscreen redraw so selection-only labels remain UI chrome.
    this.spectralCanvas.toBlob = (callback, type, quality) => {
      this.exportSpectrogramToBlob(callback, type, quality);
    };
    this.onSeek = options.onSeek;
    this.onViewChange = options.onViewChange;
    this.onSelectionChange = options.onSelectionChange;

    this.resizeObserver = new ResizeObserver((entries) => {
      let renderMask = 0;
      let analyzerChanged = false;
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (entry.target === this.waveCanvas) {
          const baseChanged = setCanvasSurfaceSize(this.waveSurface, width, height);
          const overlayChanged = setCanvasSurfaceSize(this.waveOverlaySurface, width, height);
          if (baseChanged || overlayChanged) {
            renderMask |= RENDER_WAVEFORM | RENDER_WAVEFORM_OVERLAY;
            this.showPlayhead(this.cursorTime);
          }
        } else if (entry.target === this.spectralCanvas) {
          const baseChanged = setCanvasSurfaceSize(this.spectralSurface, width, height);
          const overlayChanged = setCanvasSurfaceSize(this.spectralOverlaySurface, width, height);
          if (baseChanged || overlayChanged) {
            renderMask |= RENDER_SPECTROGRAM | RENDER_SPECTROGRAM_OVERLAY;
          }
        } else if (entry.target === this.spectrumCanvas) {
          analyzerChanged = setCanvasSurfaceSize(this.spectrumSurface, width, height);
        }
      }
      if (renderMask) this.requestRender(renderMask);
      if (analyzerChanged) this.requestAnalyzerRender();
    });
    this.resizeObserver.observe(this.waveCanvas);
    this.resizeObserver.observe(this.spectralCanvas);
    this.resizeObserver.observe(this.spectrumCanvas);
    this.bindInteractions();
    const signal = this.eventAbortController.signal;
    this.spectrumCanvas.addEventListener(
      'pointermove',
      (event) => this.updateSpectrumHover(event),
      { signal },
    );
    this.spectrumCanvas.addEventListener('pointerleave', () => this.setSpectrumHover(null), { signal });
    window.addEventListener('resize', () => this.refreshDevicePixelRatio(), { signal });
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.eventAbortController.abort();
    this.resizeObserver.disconnect();
    window.clearTimeout(this.touchSeekTimer);
    if (this.renderFrame) cancelAnimationFrame(this.renderFrame);
    if (this.analyzerFrame) cancelAnimationFrame(this.analyzerFrame);
    this.renderFrame = 0;
    this.renderMask = 0;
    this.analyzerFrame = 0;
    this.spectrogramRaster = null;
    this.spectralCanvas.toBlob = this.nativeSpectralToBlob;
  }

  setAudio(samples: Float32Array, sampleRate: number, duration: number): void {
    this.setSelection(null);
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.realtimeCqtPlan = null; // band grid depends on the sample rate
    this.duration = duration;
    this.peaks = new PeakPyramid(samples);
    this.availableSamples = samples.length;
    this.viewStart = 0;
    this.viewDuration = Math.max(duration, 0.01);
    this.emitView();
    this.requestRender();
    this.requestAnalyzerRender();
  }

  clearAudio(): void {
    this.setSelection(null);
    this.samples = null;
    this.peaks = null;
    this.spectrogram = null;
    this.duration = 0;
    this.viewStart = 0;
    this.viewDuration = 1;
    this.availableSamples = 0;
    this.spectrogramRaster = null;
    this.hideSpectrumHoverFrequencyLabel();
    this.requestRender();
    this.requestAnalyzerRender();
  }

  beginProgressiveAudio(samples: Float32Array, sampleRate: number, duration: number): void {
    this.setSelection(null);
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.realtimeCqtPlan = null; // band grid depends on the sample rate
    this.duration = duration;
    this.peaks = new PeakPyramid(samples, false);
    this.availableSamples = 0;
    this.viewStart = 0;
    this.viewDuration = Math.max(duration, 0.01);
    this.emitView();
    this.requestRender();
    this.requestAnalyzerRender();
  }

  updateProgressiveAudio(start: number, end: number): void {
    this.peaks?.update(start, end);
    this.availableSamples = Math.max(this.availableSamples, Math.min(this.samples?.length ?? 0, end));
    this.requestRender(RENDER_WAVEFORM | RENDER_SPECTROGRAM);
    this.requestAnalyzerRender();
  }

  setSpectrogram(data: SpectrogramData | null): void {
    this.spectrogram = data;
    if (!data) this.spectrogramRaster = null;
    this.requestRender(RENDER_SPECTROGRAM);
    this.requestAnalyzerRender();
  }

  get selection(): SelectionRange | null {
    return this.selectionRange ? { ...this.selectionRange } : null;
  }

  setSelection(selection: SelectionRange | null): void {
    const next = this.normalizeSelection(selection);
    if (selectionRangesEqual(this.selectionRange, next)) return;
    this.selectionRange = next;
    this.selectionDraft = null;
    this.onSelectionChange?.(next ? { ...next } : null);
    this.requestRender(RENDER_WAVEFORM_OVERLAY | RENDER_SPECTROGRAM_OVERLAY);
  }

  setSpectralRange(value: number): void {
    this.spectralRangeDb = Math.max(60, Math.min(140, value));
    this.requestRender(RENDER_SPECTROGRAM);
    this.requestAnalyzerRender();
  }

  setColorPalette(palette: PaletteName): void {
    this.colorLut = createPaletteLut(palette);
    this.requestRender(RENDER_SPECTROGRAM);
  }

  setScaleBlend(value: number): void {
    this.scaleBlend = Math.max(0, Math.min(1, value));
    this.requestRender(RENDER_SPECTROGRAM | RENDER_SPECTROGRAM_OVERLAY);
    this.requestAnalyzerRender();
  }

  setSpectrumAnalyzerOpen(open: boolean): void {
    this.spectrumAnalyzerOpen = open;
    if (!open) {
      this.setSpectrumHover(null);
      this.hideSpectrumHoverFrequencyLabel();
    }
    this.requestAnalyzerRender();
  }

  setSpectrumFftSize(fftSize: number): void {
    const next = Math.max(2, Math.round(fftSize));
    if (next === this.spectrumFftSize) return;
    this.spectrumFftSize = next;
    this.realtimeFft = null;
    this.realtimeCqtPlan = null;
    this.requestAnalyzerRender();
  }

  setAnalysisMode(mode: AnalysisMode): void {
    if (mode === this.analysisMode) return;
    this.analysisMode = mode;
    this.realtimeFft = null;
    this.realtimeCqtPlan = null;
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
    this.requestRender(RENDER_WAVEFORM | RENDER_SPECTROGRAM_OVERLAY);
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

  get waveformAmplitudeDb(): number {
    return this.waveformAmplitudeGainDb;
  }

  get waveformAmplitudeScale(): number {
    return 10 ** (this.waveformAmplitudeGainDb / 20);
  }

  setWaveformAmplitudeDb(value: number): void {
    if (!Number.isFinite(value)) return;
    const next = Math.max(0, value);
    if (Math.abs(next - this.waveformAmplitudeGainDb) < 1e-9) return;
    this.waveformAmplitudeGainDb = next;
    this.requestRender(RENDER_WAVEFORM);
  }

  resetWaveformAmplitude(): void {
    this.setWaveformAmplitudeDb(0);
  }

  get analysisColumnCount(): number {
    const dpr = window.devicePixelRatio || 1;
    return Math.max(1, Math.round(this.timelinePlotWidth * dpr));
  }

  private get timelinePlotWidth(): number {
    return Math.max(1, this.waveSurface.width - AXIS_WIDTH);
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
    const signal = this.eventAbortController.signal;
    this.editor.addEventListener('pointerdown', (event) => this.pointerDown(event), { signal });
    this.editor.addEventListener('pointermove', (event) => this.pointerMove(event), { signal });
    this.editor.addEventListener('pointerup', (event) => this.pointerUp(event), { signal });
    this.editor.addEventListener('pointercancel', (event) => this.pointerUp(event), { signal });
    this.waveCanvas.addEventListener('pointerleave', () => {
      if (!this.selectionDrag) this.setWaveformSelectionCursor(false);
    }, { signal });
    this.editor.addEventListener('wheel', (event) => this.wheel(event), { passive: false, signal });
    this.editor.addEventListener('dblclick', (event) => {
      if (!this.isTimelineEvent(event)) return;
      this.resetView();
    }, { signal });
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.duration || event.button > 0 || !this.isTimelineEvent(event)) return;
    const point = this.eventPoint(event);
    this.pointers.set(event.pointerId, point);
    this.editor.setPointerCapture(event.pointerId);

    if (this.pointers.size === 2) {
      window.clearTimeout(this.touchSeekTimer);
      this.scrubbingPointer = null;
      this.cancelSelectionDrag();
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
    if (this.isWaveformPlotEvent(event)) {
      event.preventDefault();
      this.beginSelectionDrag(event.pointerId, this.waveformEventX(event));
      return;
    }

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
    const isTracked = this.pointers.has(event.pointerId);
    if (isTracked) this.pointers.set(event.pointerId, this.eventPoint(event));

    if (this.selectionDrag?.pointerId === event.pointerId) {
      this.updateSelectionDrag(this.waveformEventX(event));
      return;
    }

    if (this.isWaveformPlotEvent(event)) {
      this.setWaveformSelectionCursor(this.selectionEndpointAtX(this.waveformEventX(event)) !== null);
    }

    if (!isTracked) return;

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
    if (this.selectionDrag?.pointerId === event.pointerId) {
      if (event.type === 'pointercancel') this.cancelSelectionDrag();
      else {
        this.updateSelectionDrag(this.waveformEventX(event));
        this.commitSelectionDrag();
      }
    }

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

  private beginSelectionDrag(pointerId: number, x: number): void {
    const endpoint = this.selectionEndpointAtX(x);
    const current = this.timeAtX(x);
    if (endpoint && this.selectionRange) {
      this.selectionDraft = { ...this.selectionRange };
      this.selectionDrag = {
        pointerId,
        kind: endpoint,
        anchor: endpoint === 'start' ? this.selectionRange.end : this.selectionRange.start,
        startX: x,
        moved: false,
      };
      this.setWaveformSelectionCursor(true);
      return;
    }

    this.selectionDraft = { start: current, end: current };
    this.selectionDrag = {
      pointerId,
      kind: 'range',
      anchor: current,
      startX: x,
      moved: false,
    };
    this.setWaveformSelectionCursor(false);
    this.requestRender(RENDER_WAVEFORM_OVERLAY | RENDER_SPECTROGRAM_OVERLAY);
  }

  private updateSelectionDrag(x: number): void {
    const drag = this.selectionDrag;
    if (!drag) return;
    if (!drag.moved && Math.abs(x - drag.startX) < 2) return;
    drag.moved = true;
    const current = this.timeAtX(x);
    this.selectionDraft = selectionFromEndpoints(drag.anchor, current);
    this.setWaveformSelectionCursor(drag.kind === 'start' || drag.kind === 'end');
    this.requestRender(RENDER_WAVEFORM_OVERLAY | RENDER_SPECTROGRAM_OVERLAY);
  }

  private commitSelectionDrag(): void {
    const drag = this.selectionDrag;
    const draft = this.selectionDraft;
    this.selectionDrag = null;
    this.selectionDraft = null;
    this.setWaveformSelectionCursor(false);

    if (!drag) return;
    if (drag.kind === 'range' && !drag.moved) {
      this.setSelection(null);
      this.seekAtX(drag.startX);
      return;
    }
    this.setSelection(draft);
  }

  private cancelSelectionDrag(): void {
    if (!this.selectionDrag && !this.selectionDraft) return;
    this.selectionDrag = null;
    this.selectionDraft = null;
    this.setWaveformSelectionCursor(false);
    this.requestRender(RENDER_WAVEFORM_OVERLAY | RENDER_SPECTROGRAM_OVERLAY);
  }

  private isWaveformPlotEvent(event: PointerEvent): boolean {
    if (event.target !== this.waveCanvas) return false;
    const rect = this.waveCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return x >= 0 && x < rect.width - AXIS_WIDTH && y >= 0 && y <= rect.height;
  }

  private waveformEventX(event: PointerEvent): number {
    return event.clientX - this.waveCanvas.getBoundingClientRect().left;
  }

  private selectionEndpointAtX(x: number): 'start' | 'end' | null {
    const selection = this.selectionRange;
    if (!selection) return null;
    const hitRadius = 8;
    const startX = this.timeToX(selection.start);
    const endX = this.timeToX(selection.end);
    const startDistance = Math.abs(x - startX);
    const endDistance = Math.abs(x - endX);
    if (startDistance > hitRadius && endDistance > hitRadius) return null;
    return startDistance <= endDistance ? 'start' : 'end';
  }

  private setWaveformSelectionCursor(overEndpoint: boolean): void {
    this.waveCanvas.style.cursor = overEndpoint ? 'ew-resize' : '';
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
    if (previous && Math.abs(previous.x - x) < 0.25 && Math.abs(previous.y - y) < 0.25) return;
    this.spectrumHover = { x, y };
    this.requestAnalyzerRender();
  }

  private setSpectrumHover(hover: SpectrumHover | null): void {
    if (
      this.spectrumHover === hover ||
      (!this.spectrumHover && !hover)
    ) return;
    this.spectrumHover = hover;
    if (!hover) this.hideSpectrumHoverFrequencyLabel();
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

  private timeToX(time: number): number {
    return ((time - this.viewStart) / this.viewDuration) * this.timelinePlotWidth;
  }

  private get renderedSelection(): SelectionRange | null {
    const selection = this.selectionDraft ?? this.selectionRange;
    if (!selection || selection.end - selection.start <= 1e-9) return null;
    return selection;
  }

  private normalizeSelection(selection: SelectionRange | null): SelectionRange | null {
    if (!selection || !this.duration) return null;
    if (!Number.isFinite(selection.start) || !Number.isFinite(selection.end)) return null;
    const start = Math.max(0, Math.min(this.duration, Math.min(selection.start, selection.end)));
    const end = Math.max(0, Math.min(this.duration, Math.max(selection.start, selection.end)));
    return end - start > 1e-9 ? { start, end } : null;
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

  private requestRender(mask = RENDER_TIMELINE): void {
    if (this.disposed) return;
    this.renderMask |= mask;
    if (this.renderFrame) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = 0;
      const nextMask = this.renderMask;
      this.renderMask = 0;
      if (nextMask & RENDER_WAVEFORM) this.drawWaveform();
      if (nextMask & RENDER_WAVEFORM_OVERLAY) this.drawWaveformOverlay();
      if (nextMask & RENDER_SPECTROGRAM) this.drawSpectrogram();
      if (nextMask & RENDER_SPECTROGRAM_OVERLAY) this.drawSpectrogramOverlay();
    });
  }

  private requestAnalyzerRender(): void {
    if (this.disposed || !this.spectrumAnalyzerOpen || this.analyzerFrame) return;
    this.analyzerFrame = requestAnimationFrame(() => {
      this.analyzerFrame = 0;
      this.drawSpectrumAnalyzer();
    });
  }

  private refreshDevicePixelRatio(): void {
    let renderMask = 0;
    if (setCanvasSurfaceSize(this.waveSurface, this.waveSurface.width, this.waveSurface.height)) {
      renderMask |= RENDER_WAVEFORM;
    }
    if (
      setCanvasSurfaceSize(
        this.waveOverlaySurface,
        this.waveOverlaySurface.width,
        this.waveOverlaySurface.height,
      )
    ) {
      renderMask |= RENDER_WAVEFORM_OVERLAY;
    }
    if (
      setCanvasSurfaceSize(this.spectralSurface, this.spectralSurface.width, this.spectralSurface.height)
    ) {
      renderMask |= RENDER_SPECTROGRAM;
    }
    if (
      setCanvasSurfaceSize(
        this.spectralOverlaySurface,
        this.spectralOverlaySurface.width,
        this.spectralOverlaySurface.height,
      )
    ) {
      renderMask |= RENDER_SPECTROGRAM_OVERLAY;
    }
    if (setCanvasSurfaceSize(this.spectrumSurface, this.spectrumSurface.width, this.spectrumSurface.height)) {
      this.requestAnalyzerRender();
    }
    if (renderMask) {
      this.showPlayhead(this.cursorTime);
      this.requestRender(renderMask);
    }
  }

  private drawWaveform(surface = this.waveSurface): void {
    prepareCanvasSurface(surface);
    const {
      context,
      width,
      height,
      pixelWidth: physicalWidth,
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

    this.drawTimeGrid(
      context,
      plotRight,
      height,
      0,
      height,
      false,
      scaleX,
      scaleY,
      physicalWidth,
      physicalHeight,
    );

    const displayDbTicks = selectWaveformDbTicks(waveHalfHeight);
    const dbRules: Array<{ y: number; db: number; sign: number; maximum: boolean }> = [];
    for (const displayDb of displayDbTicks) {
      const amplitude = 10 ** (displayDb / 20);
      for (const sign of [-1, 1]) {
        dbRules.push({
          y: mid + sign * amplitude * waveHalfHeight,
          db: displayDb - this.waveformAmplitudeGainDb,
          sign,
          maximum: displayDb === 0,
        });
      }
    }

    // Rules are drawn in physical canvas coordinates. A one-CSS-pixel stroke
    // becomes two device pixels on a retina canvas, and can land between them
    // when the canvas has a fractional CSS size.
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = false;
    for (const rule of dbRules) {
      context.fillStyle = rule.maximum
        ? (light ? 'rgba(56, 67, 75, .26)' : 'rgba(158, 181, 196, .14)')
        : (light ? 'rgba(56, 67, 75, .13)' : 'rgba(158, 181, 196, .08)');
      drawDeviceHorizontalLine(
        context,
        0,
        plotRight,
        rule.y,
        scaleX,
        scaleY,
        physicalWidth,
        physicalHeight,
      );
    }
    context.fillStyle = light ? 'rgba(49, 59, 67, .3)' : 'rgba(188, 210, 222, .22)';
    drawDeviceHorizontalLine(
      context,
      0,
      plotRight,
      mid,
      scaleX,
      scaleY,
      physicalWidth,
      physicalHeight,
    );
    context.restore();

    context.font = '10px "Chivo Mono", ui-monospace, monospace';
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    for (const rule of dbRules) {
      if (rule.sign < 0 || !rule.maximum) {
        context.fillStyle = rule.maximum
          ? (light ? '#56616a' : '#9aa6b2')
          : (light ? '#76818a' : '#687581');
        const labelY = Math.max(7, Math.min(height - 7, rule.y));
        context.fillText(
          formatWaveformDb(rule.db, rule.maximum),
          plotRight + AXIS_LABEL_INSET,
          labelY,
        );
      }
    }
    context.fillStyle = light ? '#65717a' : '#5d6974';
    context.fillText('-∞', plotRight + AXIS_LABEL_INSET, mid);

    if (this.peaks && this.samples) {
      const physicalWidth = Math.max(1, Math.round(plotWidth * scaleX));
      const physicalMid = physicalHeight / 2;
      const physicalHalfHeight = (physicalHeight / 2) * this.waveformAmplitudeScale;
      const sampleStart = this.viewStart * this.sampleRate;
      const samplesPerPhysicalPixel = (this.viewDuration * this.sampleRate) / physicalWidth;
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.imageSmoothingEnabled = false;
      context.globalAlpha = 1;
      context.fillStyle = this.signalColor;
      context.beginPath();
      for (let pixel = 0; pixel < physicalWidth; pixel += 1) {
        const from = sampleStart + pixel * samplesPerPhysicalPixel;
        if (from >= this.availableSamples) continue;
        const [min, max] = this.peaks.range(
          from,
          Math.min(this.availableSamples, from + samplesPerPhysicalPixel),
        );
        const top = Math.max(0, Math.min(physicalHeight - 1, Math.round(physicalMid - max * physicalHalfHeight)));
        const bottom = Math.max(top, Math.min(physicalHeight - 1, Math.round(physicalMid - min * physicalHalfHeight)));
        context.rect(pixel, top, 1, Math.max(1, bottom - top + 1));
      }
      context.fill();
      context.restore();
    }

    context.fillStyle = light ? '#68747d' : '#74818d';
    context.font = '600 9px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'left';
    context.fillText('L+R', 9, 14);
  }

  private drawWaveformOverlay(surface = this.waveOverlaySurface): void {
    prepareCanvasSurface(surface);
    surface.context.clearRect(0, 0, surface.width, surface.height);
    const plotRight = surface.width - AXIS_WIDTH;
    this.drawWaveformSelection(surface, plotRight);
    this.drawWaveformBorder(surface, plotRight);
  }

  private drawSpectrogram(
    surface = this.spectralSurface,
  ): void {
    prepareCanvasSurface(surface);
    const { context, width, height, scaleX, scaleY } = surface;
    const plotRight = width - AXIS_WIDTH;
    const plotWidth = Math.max(1, plotRight);
    const plotHeight = Math.max(1, height - SPECTRAL_RULER);
    const isStreaming = Boolean(this.samples && this.availableSamples < this.samples.length);
    context.fillStyle = isStreaming ? '#000' : (this.isLightTheme ? '#fff' : '#000');
    context.fillRect(0, 0, width, height);

    const data = this.spectrogram;
    const physicalPlotHeight = Math.max(1, Math.round(plotHeight * scaleY));
    const raster = data ? this.getSpectrogramRaster(data, physicalPlotHeight) : null;
    if (!data || !raster) return;

    const physicalPlotWidth = Math.max(1, Math.round(plotWidth * scaleX));
    const secondsPerColumn = Math.max(1e-9, data.secondsPerColumn);
    const sourceColumnsPerPixel = this.viewDuration / (physicalPlotWidth * secondsPerColumn);
    const sourceColumnAtLeft = (this.viewStart - data.startTime) / secondsPerColumn;
    let drawWidth = physicalPlotWidth;
    if (isStreaming) {
      const availableTime = this.availableSamples / this.sampleRate;
      const availablePixel = Math.floor(
        ((availableTime - this.viewStart) / this.viewDuration) * physicalPlotWidth,
      );
      drawWidth = Math.max(0, Math.min(physicalPlotWidth, availablePixel + 1));
    }
    if (drawWidth <= 0) return;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = false;
    const destinationTop = Math.round(SPECTRAL_RULER * scaleY);

    if (data.columns === 1) {
      context.drawImage(
        raster.canvas,
        1,
        0,
        1,
        raster.height,
        0,
        destinationTop,
        drawWidth,
        physicalPlotHeight,
      );
      return;
    }

    const boundaryEpsilon = 1e-9;
    const firstInteriorPixel = Math.max(0, Math.min(
      drawWidth,
      Math.ceil((0.5 - sourceColumnAtLeft) / sourceColumnsPerPixel - boundaryEpsilon),
    ));
    const lastInteriorPixel = Math.max(firstInteriorPixel, Math.min(
      drawWidth,
      Math.ceil(
        (data.columns - 1.5 - sourceColumnAtLeft) / sourceColumnsPerPixel - boundaryEpsilon,
      ),
    ));

    if (firstInteriorPixel > 0) {
      context.drawImage(
        raster.canvas,
        1,
        0,
        1,
        raster.height,
        0,
        destinationTop,
        firstInteriorPixel,
        physicalPlotHeight,
      );
    }

    if (lastInteriorPixel > firstInteriorPixel) {
      const sourceLeft =
        sourceColumnAtLeft +
        1.5 -
        sourceColumnsPerPixel / 2 +
        firstInteriorPixel * sourceColumnsPerPixel;
      context.drawImage(
        raster.canvas,
        sourceLeft,
        0,
        (lastInteriorPixel - firstInteriorPixel) * sourceColumnsPerPixel,
        raster.height,
        firstInteriorPixel,
        destinationTop,
        lastInteriorPixel - firstInteriorPixel,
        physicalPlotHeight,
      );
    }

    if (lastInteriorPixel < drawWidth) {
      context.drawImage(
        raster.canvas,
        data.columns,
        0,
        1,
        raster.height,
        lastInteriorPixel,
        destinationTop,
        drawWidth - lastInteriorPixel,
        physicalPlotHeight,
      );
    }
  }

  private drawSpectrogramOverlay(
    surface = this.spectralOverlaySurface,
    includeSelectionTimeLabels = true,
    clear = true,
  ): void {
    prepareCanvasSurface(surface);
    const { context, width, height, pixelWidth, pixelHeight, scaleX, scaleY } = surface;
    if (clear) context.clearRect(0, 0, width, height);
    const plotRight = width - AXIS_WIDTH;
    const plotBottom = height;
    const plotWidth = Math.max(1, plotRight);
    const plotHeight = Math.max(1, plotBottom - SPECTRAL_RULER);

    context.fillStyle = this.isLightTheme ? '#fff' : '#000';
    context.fillRect(plotRight, 0, AXIS_WIDTH, height);
    context.fillRect(0, 0, plotWidth, SPECTRAL_RULER);
    this.drawTimeGrid(
      context,
      plotRight,
      height,
      SPECTRAL_RULER,
      plotBottom,
      true,
      scaleX,
      scaleY,
      pixelWidth,
      pixelHeight,
      includeSelectionTimeLabels,
    );
    this.drawFrequencyGrid(
      context,
      plotRight,
      plotBottom,
      plotHeight,
      scaleX,
      scaleY,
      pixelWidth,
      pixelHeight,
    );
  }

  private getSpectrogramRaster(data: SpectrogramData, height: number): SpectrogramRaster | null {
    if (data.columns <= 0 || data.rows <= 0 || data.values.length < data.columns * data.rows) {
      return null;
    }
    const cached = this.spectrogramRaster;
    if (
      cached?.data === data &&
      cached.colorLut === this.colorLut &&
      cached.height === height &&
      cached.scaleBlend === this.scaleBlend &&
      cached.spectralRangeDb === this.spectralRangeDb &&
      cached.theme === this.theme
    ) {
      return cached;
    }

    const canvas = cached?.canvas ?? document.createElement('canvas');
    const context = cached?.context ?? canvas.getContext('2d', { alpha: false });
    if (!context) return null;
    // Duplicate the first and last time columns so native nearest-neighbor
    // scaling can preserve the waveform's left-edge pixel/time convention at
    // both ends without exposing transparent source pixels.
    canvas.width = data.columns + 2;
    canvas.height = height;
    const image = context.createImageData(data.columns + 2, height);
    const packed = new Uint32Array(image.data.buffer);
    const maxFrequency = data.sampleRate / 2;
    const minFrequency = this.minimumFrequency;
    const minNormalized = minFrequency / maxFrequency;
    const isCqt = data.mode === 'cqt';
    const cqtFmin = data.cqtFmin ?? 32.703;
    const cqtBinsPerOctave = data.cqtBinsPerOctave ?? 24;

    for (let y = 0; y < height; y += 1) {
      const scaled = 1 - y / Math.max(1, height - 1);
      const frequency = invertFrequencyScale(scaled, this.scaleBlend, maxFrequency, minFrequency);
      let row: number;
      if (isCqt) {
        const hertz = Math.max(frequency * maxFrequency, 1e-6);
        row = Math.round(cqtBinsPerOctave * Math.log2(hertz / cqtFmin));
      } else {
        const normalizedRow = (frequency - minNormalized) / Math.max(1e-9, 1 - minNormalized);
        row = Math.round(normalizedRow * (data.rows - 1));
      }
      row = Math.min(data.rows - 1, Math.max(0, row));
      const destinationOffset = y * (data.columns + 2);
      for (let column = 0; column < data.columns; column += 1) {
        const db = data.values[column * data.rows + row] / 10;
        const normalized = Math.max(0, Math.min(1, (db + this.spectralRangeDb) / this.spectralRangeDb));
        const paletteIndex = Math.round(normalized * 255);
        packed[destinationOffset + column + 1] = this.colorLut[
          this.isLightTheme ? 255 - paletteIndex : paletteIndex
        ];
      }
      packed[destinationOffset] = packed[destinationOffset + 1];
      packed[destinationOffset + data.columns + 1] = packed[destinationOffset + data.columns];
    }
    context.putImageData(image, 0, 0);

    const raster: SpectrogramRaster = {
      canvas,
      context,
      data,
      colorLut: this.colorLut,
      height,
      scaleBlend: this.scaleBlend,
      spectralRangeDb: this.spectralRangeDb,
      theme: this.theme,
    };
    this.spectrogramRaster = raster;
    return raster;
  }

  private drawSpectrumAnalyzer(): void {
    if (!this.spectrumAnalyzerOpen) return;
    const surface = prepareCanvasSurface(this.spectrumSurface);
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
      ? this.spectrumHoverReadout(spectrum, physicalWidth, plotTop, plotHeight, scaleX, scaleY)
      : null;
    this.updateSpectrumHoverFrequencyLabel(hover, scaleY, height);
    const amplitudeTicks = this.spectrumAmplitudeTicks(width);
    const hoverLabels = hover
      ? this.spectrumHoverAxisLabels(context, hover, width, scaleX)
      : [];
    this.drawSpectrumAnalyzerGrid(
      context,
      width,
      height,
      amplitudeTicks,
      scaleX,
      scaleY,
      physicalWidth,
      physicalHeight,
    );

    this.drawSpectrumAnalyzerRulerBorder(context, physicalWidth, plotTop);

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
    scaleX: number,
    scaleY: number,
  ): SpectrumHoverReadout | null {
    const hover = this.spectrumHover;
    if (!hover || !spectrum.length) return null;

    const hoverX = hover.x * scaleX;
    const hoverY = hover.y * scaleY;
    if (
      hoverX < 0 ||
      hoverX > physicalWidth - 1 ||
      hoverY < plotTop ||
      hoverY > plotTop + plotHeight - 1
    ) return null;

    const maxFrequency = this.sampleRate / 2;
    const minFrequency = this.minimumFrequency;
    let bin = 0;
    let x = 0;
    let y = plotTop + plotHeight - 1;
    let db = spectrum[0];
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < spectrum.length; index += 1) {
      const normalizedBin = this.spectrumPointNormalized(index, spectrum.length);
      const scaled = scaleFrequency(normalizedBin, this.scaleBlend, maxFrequency, minFrequency);
      const pointY = plotTop + plotHeight - 1 - Math.round(scaled * Math.max(1, plotHeight - 1));
      const pointDb = spectrum[index];
      const pointX = spectrumPhysicalX(pointDb, this.spectralRangeDb, physicalWidth);
      const distance = (pointX - hoverX) ** 2 + (pointY - hoverY) ** 2;
      if (distance >= nearestDistance) continue;
      nearestDistance = distance;
      bin = index;
      x = pointX;
      y = pointY;
      db = pointDb;
    }

    return {
      bin,
      frequency: this.spectrumPointFrequency(bin),
      db,
      x,
      y,
    };
  }

  private spectrumHoverAxisLabels(
    context: CanvasRenderingContext2D,
    hover: SpectrumHoverReadout,
    width: number,
    scaleX: number,
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
    return [dbLabel];
  }

  private updateSpectrumHoverFrequencyLabel(
    hover: SpectrumHoverReadout | null,
    scaleY: number,
    height: number,
  ): void {
    if (!hover) {
      this.hideSpectrumHoverFrequencyLabel();
      return;
    }
    const y = hover.y / scaleY;
    const edge = y <= SPECTRAL_RULER + 5
      ? 'top'
      : y >= height - 5
        ? 'bottom'
        : 'middle';
    const label = this.spectrumHoverFrequencyLabel;
    label.textContent = formatFrequency(hover.frequency);
    label.style.setProperty('--spectrum-hover-frequency-y', `${y}px`);
    label.dataset.edge = edge;
    label.classList.add('is-visible');
    this.updateSpectrumHoverFrequencyMask(y, edge);
  }

  private hideSpectrumHoverFrequencyLabel(): void {
    this.spectrumHoverFrequencyLabel.classList.remove('is-visible');
    delete this.spectrumHoverFrequencyLabel.dataset.edge;
    this.spectrumHoverFrequencyMask.classList.remove('is-visible');
  }

  /**
   * The hover readout lives in the same right-hand gutter as the spectrogram
   * frequency labels.  The label itself covers an exact match, but a nearby
   * tick can still peek out above or below it.  Cover just those colliding
   * canvas labels so the hover readout replaces them cleanly without forcing
   * an expensive spectrogram redraw on every pointer move.
   */
  private updateSpectrumHoverFrequencyMask(
    hoverY: number,
    edge: 'top' | 'bottom' | 'middle',
  ): void {
    const hoverBounds = frequencyLabelVerticalBounds(hoverY, edge);
    const overlapping = this.frequencyAxisTicks
      .map((tick) => frequencyLabelVerticalBounds(tick.y, tick.baseline))
      .filter((bounds) => verticalBoundsIntersect(bounds, hoverBounds));

    if (!overlapping.length) {
      this.spectrumHoverFrequencyMask.classList.remove('is-visible');
      return;
    }

    const top = Math.max(0, Math.min(...overlapping.map((bounds) => bounds.top)) - 1);
    const bottom = Math.max(top + 1, Math.max(...overlapping.map((bounds) => bounds.bottom)) + 1);
    const mask = this.spectrumHoverFrequencyMask;
    mask.style.top = `${Math.floor(top)}px`;
    mask.style.height = `${Math.ceil(bottom - top)}px`;
    mask.classList.add('is-visible');
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
      const normalized = this.spectrumPointNormalized(bin, spectrum.length);
      const scaled = scaleFrequency(normalized, this.scaleBlend, maxFrequency, minFrequency);
      const x = spectrumPhysicalX(spectrum[bin], this.spectralRangeDb, physicalWidth);
      const y = plotTop + plotHeight - 1 - Math.round(scaled * Math.max(1, plotHeight - 1));
      if (style === 'lines') {
        context.rect(0, y, x + 1, 1);
      } else if (style === 'points') {
        context.rect(x, y, 1, 1);
      } else {
        const lowerBoundary = Math.max(0, this.spectrumPointNormalized(bin - 0.5, spectrum.length));
        const upperBoundary = Math.min(1, this.spectrumPointNormalized(bin + 0.5, spectrum.length));
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
    pixelWidth: number,
    pixelHeight: number,
  ): void {
    if (width <= 0 || height <= SPECTRAL_RULER) return;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = false;
    context.fillStyle = this.isLightTheme
      ? 'rgba(48, 59, 67, .16)'
      : 'rgba(190, 211, 225, .11)';
    for (const tick of amplitudeTicks) {
      drawDeviceVerticalLine(
        context,
        tick.gridX,
        SPECTRAL_RULER,
        height,
        scaleX,
        scaleY,
        pixelWidth,
        pixelHeight,
      );
    }

    const maxFrequency = this.sampleRate / 2;
    const minFrequency = this.minimumFrequency;
    const plotHeight = height - SPECTRAL_RULER;
    const candidates = frequencyTicks(maxFrequency, this.scaleBlend, minFrequency);
    let lastY = Number.POSITIVE_INFINITY;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const frequency = candidates[index];
      if (frequency === maxFrequency) continue;
      const scaled = scaleFrequency(frequency / maxFrequency, this.scaleBlend, maxFrequency, minFrequency);
      const y = height - scaled * plotHeight;
      if (frequency !== minFrequency && Math.abs(y - height) < 21) continue;
      if (Math.abs(y - lastY) < 21 && frequency !== minFrequency && frequency !== maxFrequency) continue;
      lastY = y;
      drawDeviceHorizontalLine(
        context,
        0,
        width,
        Math.max(
          SPECTRAL_RULER,
          Math.min(height, y),
        ),
        scaleX,
        scaleY,
        pixelWidth,
        pixelHeight,
      );
    }
    context.restore();
  }

  private drawSpectrumAnalyzerRulerBorder(
    context: CanvasRenderingContext2D,
    physicalWidth: number,
    plotTop: number,
  ): void {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = this.isLightTheme
      ? 'rgba(48, 59, 67, .23)'
      : 'rgba(196, 216, 230, .15)';
    context.fillRect(0, Math.max(0, plotTop - 1), physicalWidth, 1);
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
      const binPosition = this.spectrumNormalizedToPosition(normalizedBin, spectrum.length);
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
      const normalized = this.spectrumPointNormalized(bin, spectrum.length);
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
    const frameSize = fft.size;
    const center = Math.round(this.cursorTime * this.sampleRate);
    const start = center - Math.floor(frameSize / 2);
    if (center >= this.availableSamples + frameSize / 2) return null;

    for (let index = 0; index < frameSize; index += 1) {
      const source = start + index;
      const sample = source >= 0 && source < this.availableSamples ? this.samples[source] : 0;
      this.realtimeInput[index] = sample * this.realtimeWindow[index];
    }
    fft.realTransform(this.realtimeComplex, this.realtimeInput);
    if (this.realtimeCqtPlan) {
      // Matched-mode analyzer: same constant-Q bands as the spectrogram.
      const db = cqtColumnFromSpectrum(this.realtimeCqtPlan, this.realtimeComplex);
      for (let band = 0; band < db.length; band += 1) this.realtimeCqtDb[band] = db[band];
      return this.realtimeCqtDb;
    }
    for (let bin = 0; bin < this.realtimeDb.length; bin += 1) {
      const real = this.realtimeComplex[bin * 2];
      const imaginary = this.realtimeComplex[bin * 2 + 1];
      const magnitude = Math.sqrt(real * real + imaginary * imaginary) * (4 / frameSize);
      this.realtimeDb[bin] = 20 * Math.log10(Math.max(magnitude, 1e-10));
    }
    return this.realtimeDb;
  }

  private prepareRealtimeFft(): void {
    if (this.analysisMode === 'cqt') {
      if (this.realtimeCqtPlan && this.realtimeFft) return;
      const plan = buildCqtPlan(this.sampleRate, this.spectrumFftSize);
      this.realtimeCqtPlan = plan;
      this.realtimeCqtDb = new Float32Array(plan.nBands);
      this.allocateRealtimeFft(plan.L);
      return;
    }
    this.realtimeCqtPlan = null;
    if (this.realtimeFft?.size === this.spectrumFftSize) return;
    this.allocateRealtimeFft(this.spectrumFftSize);
    this.realtimeDb = new Float32Array(this.spectrumFftSize / 2);
  }

  private allocateRealtimeFft(size: number): void {
    if (this.realtimeFft?.size !== size) {
      this.realtimeFft = new FFT(size);
      this.realtimeInput = new Float64Array(size);
      this.realtimeWindow = new Float64Array(size);
      this.realtimeComplex = this.realtimeFft.createComplexArray();
      for (let index = 0; index < size; index += 1) {
        this.realtimeWindow[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1));
      }
    }
  }

  /** Normalized frequency (f / Nyquist) of spectrum point `position`
   * (fractional positions supported, for bar boundaries). Linear FFT bins
   * in FFT mode; log-spaced constant-Q band centers in CQT mode. */
  private spectrumPointNormalized(position: number, length: number): number {
    const plan = this.realtimeCqtPlan;
    if (plan) {
      const hertz = plan.fMin * 2 ** (position / plan.binsPerOctave);
      return Math.min(1, hertz / (this.sampleRate / 2));
    }
    return position / Math.max(1, length - 1);
  }

  /** Inverse of spectrumPointNormalized: fractional point position for a
   * normalized frequency, clamped to the valid range. */
  private spectrumNormalizedToPosition(normalized: number, length: number): number {
    const plan = this.realtimeCqtPlan;
    let position: number;
    if (plan) {
      const hertz = Math.max(1e-6, normalized * (this.sampleRate / 2));
      position = plan.binsPerOctave * Math.log2(hertz / plan.fMin);
    } else {
      position = normalized * (length - 1);
    }
    return Math.max(0, Math.min(length - 1, position));
  }

  /** Frequency in Hz of spectrum point `index`. */
  private spectrumPointFrequency(index: number): number {
    const plan = this.realtimeCqtPlan;
    if (plan) return plan.frequencies[index];
    return (index * this.sampleRate) / this.spectrumFftSize;
  }

  private drawTimeGrid(
    context: CanvasRenderingContext2D,
    plotRight: number,
    height: number,
    plotTop: number,
    plotBottom: number,
    withLabels: boolean,
    scaleX: number,
    scaleY: number,
    pixelWidth: number,
    pixelHeight: number,
    includeSelectionTimeLabels = true,
  ): void {
    if (!this.duration) return;
    const plotWidth = plotRight;
    const step = niceStep(this.viewDuration / Math.max(2, plotWidth / 105));
    const ticks = this.timeTicks(plotWidth, step);
    context.font = '10px "Chivo Mono", ui-monospace, monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const selectionLabels = withLabels && includeSelectionTimeLabels
      ? this.selectionTimeAxisLabels(context, plotRight)
      : [];

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = false;
    context.fillStyle = withLabels
      ? (this.isLightTheme ? 'rgba(49, 59, 67, .2)' : 'rgba(183, 202, 219, .13)')
      : (this.isLightTheme ? 'rgba(49, 59, 67, .13)' : 'rgba(183, 202, 219, .07)');
    for (const tick of ticks) {
      const { x } = tick;
      if (x < -1 || x > plotRight + 1) continue;
      if (withLabels) {
        drawDeviceVerticalLine(
          context,
          x,
          SPECTRAL_RULER - 4,
          SPECTRAL_RULER,
          scaleX,
          scaleY,
          pixelWidth,
          pixelHeight,
        );
      } else {
        // The waveform frame owns its outermost pixel. Rendering an endpoint
        // tick beside it would make the right edge look like a two-pixel rule.
        const tickPixel = clampDevicePixel(Math.round(x * scaleX), pixelWidth);
        const frameRightPixel = clampDevicePixel(Math.round(plotRight * scaleX) - 1, pixelWidth);
        if (tickPixel <= 0 || tickPixel >= frameRightPixel) continue;
        drawDeviceVerticalLine(
          context,
          x,
          plotTop,
          plotBottom,
          scaleX,
          scaleY,
          pixelWidth,
          pixelHeight,
        );
      }
    }
    context.restore();

    if (withLabels) {
      context.fillStyle = this.isLightTheme ? '#68747d' : '#83909c';
      for (const { time, x } of ticks) {
        if (x < -1 || x > plotRight + 1) continue;
        const label: SpectrumAxisLabel = {
          label: formatRuler(time, step),
          x,
          y: SPECTRAL_RULER / 2 + 0.5,
          align: x < 24 ? 'left' : x > plotRight - 24 ? 'right' : 'center',
          baseline: 'middle',
          font: context.font,
          bounds: { left: 0, top: 0, right: 0, bottom: 0 },
        };
        label.bounds = labelBounds(context, label);
        if (selectionLabels.some((selectionLabel) => labelsIntersect(label.bounds, selectionLabel.bounds))) {
          continue;
        }
        context.textAlign = label.align;
        context.fillText(label.label, label.x, label.y);
      }
      this.drawSelectionTimeAxisLabels(context, selectionLabels);
    }

    void height;
  }

  private selectionTimeAxisLabels(
    context: CanvasRenderingContext2D,
    plotRight: number,
  ): SpectrumAxisLabel[] {
    const selection = this.renderedSelection;
    if (!selection) return [];
    const viewEnd = this.viewStart + this.viewDuration;
    const endpoints: Array<{ time: number; side: 'start' | 'end' }> = [
      { time: selection.start, side: 'start' },
      { time: selection.end, side: 'end' },
    ];
    const labels: SpectrumAxisLabel[] = [];

    for (const { time, side } of endpoints) {
      if (time < this.viewStart - 1e-9 || time > viewEnd + 1e-9) continue;
      const x = Math.max(0, Math.min(plotRight, this.timeToX(time)));
      const labelText = formatSelectionClock(time);
      const width = context.measureText(labelText).width;
      const align: CanvasTextAlign = side === 'start'
        ? x - width < 2 ? 'left' : 'right'
        : x + width > plotRight - 2 ? 'right' : 'left';
      const label: SpectrumAxisLabel = {
        label: labelText,
        x,
        y: SPECTRAL_RULER / 2 + 0.5,
        align,
        baseline: 'middle',
        font: context.font,
        bounds: { left: 0, top: 0, right: 0, bottom: 0 },
      };
      label.bounds = labelBounds(context, label);
      labels.push(label);
    }

    if (labels.length === 2 && labelsIntersect(labels[0].bounds, labels[1].bounds)) {
      this.layoutOverlappingSelectionTimeLabels(context, labels, plotRight);
    }

    return labels;
  }

  /**
   * Short selections can place both endpoint labels at the same edge of the
   * ruler. Keep them on its single baseline: shift the pair together just
   * enough to fit, instead of moving one label to a second line.
   */
  private layoutOverlappingSelectionTimeLabels(
    context: CanvasRenderingContext2D,
    labels: SpectrumAxisLabel[],
    plotRight: number,
  ): void {
    const [start, end] = labels;
    const startWidth = start.bounds.right - start.bounds.left;
    const endWidth = end.bounds.right - end.bounds.left;
    const inset = 2;
    const gap = 4;
    const totalWidth = startWidth + gap + endWidth;
    const availableWidth = Math.max(0, plotRight - inset * 2);

    // A very narrow viewport cannot hold both exact strings. Prefer a single
    // clean endpoint label to overlapping glyphs, while retaining the same
    // one-line ruler treatment.
    if (totalWidth > availableWidth) {
      labels.splice(1, 1);
      return;
    }

    const preferredCenter = (start.x + end.x) / 2;
    const minimumCenter = inset + totalWidth / 2;
    const maximumCenter = plotRight - inset - totalWidth / 2;
    const center = Math.max(minimumCenter, Math.min(maximumCenter, preferredCenter));
    const left = center - totalWidth / 2;
    const y = SPECTRAL_RULER / 2 + 0.5;

    start.x = left + startWidth;
    start.y = y;
    start.align = 'right';
    start.baseline = 'middle';
    start.bounds = labelBounds(context, start);

    end.x = left + startWidth + gap;
    end.y = y;
    end.align = 'left';
    end.baseline = 'middle';
    end.bounds = labelBounds(context, end);
  }

  private exportSpectrogramToBlob(
    callback: BlobCallback,
    type?: string,
    quality?: number,
  ): void {
    const { width, height } = this.spectralSurface;
    if (width <= 1 || height <= 1) {
      this.nativeSpectralToBlob(callback, type, quality);
      return;
    }

    const exportCanvas = document.createElement('canvas');
    const exportSurface = createCanvasSurface(exportCanvas, false, { width, height });
    this.drawSpectrogram(exportSurface);
    this.drawSpectrogramOverlay(exportSurface, false, false);
    exportCanvas.toBlob(callback, type, quality);
  }

  private drawSelectionTimeAxisLabels(
    context: CanvasRenderingContext2D,
    labels: SpectrumAxisLabel[],
  ): void {
    if (!labels.length) return;
    context.fillStyle = this.signalColor;
    for (const label of labels) {
      context.font = label.font;
      context.textAlign = label.align;
      context.textBaseline = label.baseline;
      context.fillText(label.label, label.x, label.y);
    }
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
    scaleX: number,
    scaleY: number,
    pixelWidth: number,
    pixelHeight: number,
  ): void {
    const maxFrequency = this.sampleRate / 2;
    const minFrequency = this.minimumFrequency;
    const candidates = frequencyTicks(maxFrequency, this.scaleBlend, minFrequency);
    context.font = '10px "Chivo Mono", ui-monospace, monospace';
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    let lastY = Number.POSITIVE_INFINITY;
    const ticks: FrequencyAxisTick[] = [];

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
      ticks.push({
        frequency,
        y,
        baseline: frequency === maxFrequency
          ? 'top'
          : frequency === minFrequency
            ? 'bottom'
            : 'middle',
      });
    }
    this.frequencyAxisTicks = ticks;

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = false;
    context.fillStyle = this.isLightTheme
      ? 'rgba(49, 59, 67, .24)'
      : 'rgba(190, 211, 225, .16)';
    for (const tick of ticks) {
      drawDeviceHorizontalLine(
        context,
        plotRight,
        plotRight + 4,
        tick.y,
        scaleX,
        scaleY,
        pixelWidth,
        pixelHeight,
      );
    }
    context.restore();

    context.fillStyle = this.isLightTheme ? '#68747d' : '#75828e';
    for (const { frequency, y, baseline } of ticks) {
      context.textBaseline = baseline;
      context.fillText(formatFrequency(frequency), plotRight + AXIS_LABEL_INSET, y);
    }
  }

  private drawWaveformSelection(surface: CanvasSurface, plotRight: number): void {
    const selection = this.renderedSelection;
    if (!selection) return;

    const { context, pixelWidth, pixelHeight, scaleX } = surface;
    const plotWidth = Math.max(1, plotRight);
    const startX = ((selection.start - this.viewStart) / this.viewDuration) * plotWidth;
    const endX = ((selection.end - this.viewStart) / this.viewDuration) * plotWidth;
    const plotPhysicalRight = clampDeviceBoundary(Math.round(plotRight * scaleX), pixelWidth);
    const left = Math.max(0, Math.min(plotPhysicalRight, Math.round(Math.min(startX, endX) * scaleX)));
    const right = Math.max(0, Math.min(plotPhysicalRight, Math.round(Math.max(startX, endX) * scaleX)));
    if (right <= 0 || left >= plotPhysicalRight || right <= left) return;

    // Keep the translucent range as a device-aligned rectangle in the backing
    // store. This avoids a softened edge on high-DPI displays while leaving
    // the waveform frame itself to be redrawn above it.
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = false;
    context.fillStyle = this.isLightTheme ? 'rgba(23, 123, 87, .16)' : 'rgba(99, 239, 180, .17)';
    context.fillRect(left, 0, right - left, pixelHeight);
    context.restore();
  }

  private drawWaveformBorder(surface: CanvasSurface, plotRight: number): void {
    const { context, pixelHeight, scaleX } = surface;
    const right = Math.max(1, Math.round(plotRight * scaleX));
    const borderX = 1;
    const borderY = 1;
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

function frequencyLabelVerticalBounds(
  y: number,
  baseline: CanvasTextBaseline | 'top' | 'bottom' | 'middle',
): { top: number; bottom: number } {
  const labelHeight = 12;
  if (baseline === 'top' || baseline === 'hanging') return { top: y, bottom: y + labelHeight };
  if (baseline === 'bottom' || baseline === 'ideographic') return { top: y - labelHeight, bottom: y };
  return { top: y - labelHeight / 2, bottom: y + labelHeight / 2 };
}

function verticalBoundsIntersect(
  a: { top: number; bottom: number },
  b: { top: number; bottom: number },
): boolean {
  const inset = 1;
  return a.top - inset < b.bottom && a.bottom + inset > b.top;
}

function fontPixelSize(font: string): number {
  const match = /([0-9.]+)px/.exec(font);
  return match ? Number(match[1]) : 10;
}

function formatWaveformDb(value: number, includeUnit: boolean): string {
  const rounded = Math.abs(value) < 0.05 ? 0 : Math.round(value * 10) / 10;
  const label = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  return includeUnit ? `${label} dB` : label;
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

function formatSelectionClock(time: number): string {
  const milliseconds = Math.max(0, Math.round(time * 1000));
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${remainder.toString().padStart(3, '0')}`;
}

function selectionFromEndpoints(first: number, second: number): SelectionRange {
  return {
    start: Math.min(first, second),
    end: Math.max(first, second),
  };
}

function selectionRangesEqual(
  first: SelectionRange | null,
  second: SelectionRange | null,
): boolean {
  if (first === second) return true;
  if (!first || !second) return false;
  return Math.abs(first.start - second.start) < 1e-9 && Math.abs(first.end - second.end) < 1e-9;
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

function drawDeviceVerticalLine(
  context: CanvasRenderingContext2D,
  x: number,
  top: number,
  bottom: number,
  scaleX: number,
  scaleY: number,
  pixelWidth: number,
  pixelHeight: number,
): void {
  const physicalX = clampDevicePixel(Math.round(x * scaleX), pixelWidth);
  const [physicalTop, physicalBottom] = deviceSpan(top, bottom, scaleY, pixelHeight);
  context.fillRect(physicalX, physicalTop, 1, physicalBottom - physicalTop);
}

function drawDeviceHorizontalLine(
  context: CanvasRenderingContext2D,
  left: number,
  right: number,
  y: number,
  scaleX: number,
  scaleY: number,
  pixelWidth: number,
  pixelHeight: number,
): void {
  const [physicalLeft, physicalRight] = deviceSpan(left, right, scaleX, pixelWidth);
  const physicalY = clampDevicePixel(Math.round(y * scaleY), pixelHeight);
  context.fillRect(physicalLeft, physicalY, physicalRight - physicalLeft, 1);
}

function deviceSpan(
  start: number,
  end: number,
  scale: number,
  limit: number,
): [number, number] {
  const first = clampDeviceBoundary(Math.round(Math.min(start, end) * scale), limit);
  const last = clampDeviceBoundary(Math.round(Math.max(start, end) * scale), limit);
  if (last > first) return [first, last];
  const pixel = clampDevicePixel(first, limit);
  return [pixel, Math.min(limit, pixel + 1)];
}

function clampDeviceBoundary(value: number, limit: number): number {
  return Math.max(0, Math.min(limit, value));
}

function clampDevicePixel(value: number, limit: number): number {
  return Math.max(0, Math.min(Math.max(0, limit - 1), value));
}
