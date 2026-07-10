import { createPaletteLut, type PaletteName } from './palettes';
import type { SpectrogramData } from './types';

const AXIS_WIDTH = 48;
const SPECTRAL_RULER = 25;

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

export type VisualizerOptions = {
  editor: HTMLElement;
  waveCanvas: HTMLCanvasElement;
  spectralCanvas: HTMLCanvasElement;
  playhead: HTMLElement;
  onSeek: (time: number) => void;
  onViewChange: (start: number, duration: number) => void;
};

class PeakPyramid {
  private levels: PeakLevel[] = [];

  constructor(private readonly samples: Float32Array) {
    if (samples.length) this.build();
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

  private build(): void {
    let blockSize = 32;
    let count = Math.ceil(this.samples.length / blockSize);
    let min = new Float32Array(count);
    let max = new Float32Array(count);

    for (let block = 0; block < count; block += 1) {
      let low = 1;
      let high = -1;
      const end = Math.min(this.samples.length, (block + 1) * blockSize);
      for (let i = block * blockSize; i < end; i += 1) {
        const value = this.samples[i];
        if (value < low) low = value;
        if (value > high) high = value;
      }
      min[block] = low;
      max[block] = high;
    }
    this.levels.push({ blockSize, min, max });

    while (count > 4) {
      const previousMin = min;
      const previousMax = max;
      blockSize *= 4;
      count = Math.ceil(count / 4);
      min = new Float32Array(count);
      max = new Float32Array(count);
      for (let block = 0; block < count; block += 1) {
        let low = 1;
        let high = -1;
        const end = Math.min(previousMin.length, block * 4 + 4);
        for (let i = block * 4; i < end; i += 1) {
          if (previousMin[i] < low) low = previousMin[i];
          if (previousMax[i] > high) high = previousMax[i];
        }
        min[block] = low;
        max[block] = high;
      }
      this.levels.push({ blockSize, min, max });
    }
  }
}

export class AudioVisualizer {
  private readonly editor: HTMLElement;
  private readonly waveCanvas: HTMLCanvasElement;
  private readonly spectralCanvas: HTMLCanvasElement;
  private readonly playhead: HTMLElement;
  private readonly onSeek: (time: number) => void;
  private readonly onViewChange: (start: number, duration: number) => void;
  private readonly pointers = new Map<number, PointerPoint>();
  private colorLut = createPaletteLut('viridis');
  private resizeObserver: ResizeObserver;
  private samples: Float32Array | null = null;
  private peaks: PeakPyramid | null = null;
  private spectrogram: SpectrogramData | null = null;
  private sampleRate = 48000;
  private duration = 0;
  private viewStart = 0;
  private viewDuration = 1;
  private scaleBlend = 1;
  private spectralRangeDb = 120;
  private renderFrame = 0;
  private pinch: PinchGesture | null = null;
  private scrubbingPointer: number | null = null;
  private touchSeekTimer = 0;
  private wasPinching = false;

  constructor(options: VisualizerOptions) {
    this.editor = options.editor;
    this.waveCanvas = options.waveCanvas;
    this.spectralCanvas = options.spectralCanvas;
    this.playhead = options.playhead;
    this.onSeek = options.onSeek;
    this.onViewChange = options.onViewChange;

    this.resizeObserver = new ResizeObserver(() => this.requestRender());
    this.resizeObserver.observe(this.waveCanvas);
    this.resizeObserver.observe(this.spectralCanvas);
    this.bindInteractions();
    this.requestRender();
  }

  setAudio(samples: Float32Array, sampleRate: number, duration: number): void {
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.duration = duration;
    this.peaks = new PeakPyramid(samples);
    this.viewStart = 0;
    this.viewDuration = Math.max(duration, 0.01);
    this.emitView();
    this.requestRender();
  }

  setSpectrogram(data: SpectrogramData | null): void {
    this.spectrogram = data;
    this.requestRender();
  }

  setSpectralRange(value: number): void {
    this.spectralRangeDb = Math.max(60, Math.min(140, value));
    this.requestRender();
  }

  setColorPalette(palette: PaletteName): void {
    this.colorLut = createPaletteLut(palette);
    this.requestRender();
  }

  setScaleBlend(value: number): void {
    this.scaleBlend = Math.max(0, Math.min(1, value));
    this.requestRender();
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

  showPlayhead(time: number): void {
    if (!this.duration) {
      this.playhead.classList.remove('is-visible');
      return;
    }
    const width = this.editor.clientWidth - AXIS_WIDTH;
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
    const edge = this.viewStart + this.viewDuration * 0.94;
    if (time > edge) {
      this.setView(time - this.viewDuration * 0.08, this.viewDuration);
    }
  }

  get zoomRatio(): number {
    return this.duration ? this.duration / this.viewDuration : 1;
  }

  get analysisColumnCount(): number {
    const dpr = window.devicePixelRatio || 1;
    return Math.max(1, Math.round((this.editor.clientWidth - AXIS_WIDTH) * dpr));
  }

  private get minimumFrequency(): number {
    return 0;
  }

  private bindInteractions(): void {
    this.editor.addEventListener('pointerdown', (event) => this.pointerDown(event));
    this.editor.addEventListener('pointermove', (event) => this.pointerMove(event));
    this.editor.addEventListener('pointerup', (event) => this.pointerUp(event));
    this.editor.addEventListener('pointercancel', (event) => this.pointerUp(event));
    this.editor.addEventListener('wheel', (event) => this.wheel(event), { passive: false });
    this.editor.addEventListener('dblclick', () => this.resetView());
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.duration || event.button > 0) return;
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
      const plotWidth = Math.max(1, this.editor.clientWidth - AXIS_WIDTH);
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

  private wheel(event: WheelEvent): void {
    if (!this.duration) return;
    event.preventDefault();
    const rect = this.editor.getBoundingClientRect();
    const x = event.clientX - rect.left;

    if (event.ctrlKey || event.metaKey) {
      const anchor = this.timeAtX(x);
      const nextDuration = this.clampDuration(this.viewDuration * Math.exp(event.deltaY * 0.008));
      const plotWidth = Math.max(1, this.editor.clientWidth - AXIS_WIDTH);
      const ratio = x / plotWidth;
      this.setView(anchor - ratio * nextDuration, nextDuration);
      return;
    }

    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const plotWidth = Math.max(1, this.editor.clientWidth - AXIS_WIDTH);
    this.setView(this.viewStart + (delta / plotWidth) * this.viewDuration, this.viewDuration);
  }

  private seekAtX(x: number): void {
    this.onSeek(this.timeAtX(x));
  }

  private timeAtX(x: number): number {
    const plotWidth = Math.max(1, this.editor.clientWidth - AXIS_WIDTH);
    const ratio = Math.max(0, Math.min(1, x / plotWidth));
    return this.viewStart + ratio * this.viewDuration;
  }

  private eventPoint(event: PointerEvent): PointerPoint {
    const rect = this.editor.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, type: event.pointerType };
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
    });
  }

  private prepareCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext('2d', { alpha: false })!;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return context;
  }

  private drawWaveform(): void {
    const canvas = this.waveCanvas;
    const context = this.prepareCanvas(canvas);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const plotRight = width - AXIS_WIDTH;
    const plotWidth = Math.max(1, plotRight);
    const mid = height / 2;
    const waveHalfHeight = height / 2;
    context.fillStyle = '#11151b';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#0c0f14';
    context.fillRect(plotRight, 0, AXIS_WIDTH, height);

    this.drawTimeGrid(context, height, 0, height, false);

    const dbTicks = selectWaveformDbTicks(waveHalfHeight);
    context.font = '10px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    for (const db of dbTicks) {
      const amplitude = 10 ** (db / 20);
      for (const sign of [-1, 1]) {
        const y = mid + sign * amplitude * waveHalfHeight;
        context.strokeStyle = db === 0 ? 'rgba(158, 181, 196, .14)' : 'rgba(158, 181, 196, .08)';
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(0, snap(y));
        context.lineTo(plotRight, snap(y));
        context.stroke();
        if (sign < 0 || db !== 0) {
          context.fillStyle = db === 0 ? '#9aa6b2' : '#687581';
          const labelY = Math.max(7, Math.min(height - 7, y));
          context.fillText(db === 0 ? '0 dB' : `${db}`, plotRight + 9, labelY);
        }
      }
    }

    context.strokeStyle = 'rgba(188, 210, 222, .22)';
    context.beginPath();
    context.moveTo(0, snap(mid));
    context.lineTo(plotRight, snap(mid));
    context.stroke();
    context.fillStyle = '#5d6974';
    context.fillText('-∞', plotRight + 9, mid);

    if (this.peaks && this.samples) {
      const dpr = window.devicePixelRatio || 1;
      const physicalWidth = Math.max(1, Math.floor(plotWidth * dpr));
      const physicalHeight = Math.max(1, Math.round(height * dpr));
      const physicalMid = physicalHeight / 2;
      const physicalHalfHeight = physicalHeight / 2;
      const sampleStart = this.viewStart * this.sampleRate;
      const samplesPerPhysicalPixel = (this.viewDuration * this.sampleRate) / physicalWidth;
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.imageSmoothingEnabled = false;
      context.fillStyle = '#63efb4';
      for (let pixel = 0; pixel < physicalWidth; pixel += 1) {
        const from = sampleStart + pixel * samplesPerPhysicalPixel;
        const [min, max] = this.peaks.range(from, from + samplesPerPhysicalPixel);
        const top = Math.max(0, Math.min(physicalHeight - 1, Math.round(physicalMid - max * physicalHalfHeight)));
        const bottom = Math.max(top, Math.min(physicalHeight - 1, Math.round(physicalMid - min * physicalHalfHeight)));
        context.fillRect(pixel, top, 1, Math.max(1, bottom - top + 1));
      }
      context.restore();
    }

    this.drawAxisBorder(context, width, height);
    context.fillStyle = '#74818d';
    context.font = '600 9px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'left';
    context.fillText('L+R', 9, 14);
  }

  private drawSpectrogram(): void {
    const canvas = this.spectralCanvas;
    const context = this.prepareCanvas(canvas);
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const plotRight = width - AXIS_WIDTH;
    const plotBottom = height;
    const plotWidth = Math.max(1, plotRight);
    const plotHeight = Math.max(1, plotBottom - SPECTRAL_RULER);
    context.fillStyle = '#080b12';
    context.fillRect(0, 0, width, height);

    if (this.spectrogram) {
      const pixelWidth = Math.max(1, Math.round(plotWidth * dpr));
      const pixelHeight = Math.max(1, Math.round(plotHeight * dpr));
      const image = context.createImageData(pixelWidth, pixelHeight);
      const packed = new Uint32Array(image.data.buffer);
      const { columns, rows, values, startTime, secondsPerColumn } = this.spectrogram;
      const maxFrequency = this.sampleRate / 2;
      const minFrequency = this.minimumFrequency;
      const minNormalized = minFrequency / maxFrequency;
      const timeStartColumn = (this.viewStart - startTime) / secondsPerColumn;
      const columnsPerPixel = (this.viewDuration / pixelWidth) / secondsPerColumn;
      const rowMap = new Uint16Array(pixelHeight);

      for (let y = 0; y < pixelHeight; y += 1) {
        const scaled = 1 - y / Math.max(1, pixelHeight - 1);
        const frequency = invertFrequencyScale(scaled, this.scaleBlend, maxFrequency, minFrequency);
        const row = (frequency - minNormalized) / Math.max(1e-9, 1 - minNormalized);
        rowMap[y] = Math.min(rows - 1, Math.max(0, Math.round(row * (rows - 1))));
      }

      for (let y = 0; y < pixelHeight; y += 1) {
        const row = rowMap[y];
        const offset = y * pixelWidth;
        for (let x = 0; x < pixelWidth; x += 1) {
          const columnFloat = timeStartColumn + x * columnsPerPixel;
          const column = Math.max(0, Math.min(columns - 1, Math.round(columnFloat)));
          const db = values[column * rows + row] / 10;
          const normalized = Math.max(0, Math.min(1, (db + this.spectralRangeDb) / this.spectralRangeDb));
          packed[offset + x] = this.colorLut[Math.round(normalized * 255)];
        }
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.putImageData(image, 0, Math.round(SPECTRAL_RULER * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    context.fillStyle = '#0c0f14';
    context.fillRect(plotRight, 0, AXIS_WIDTH, height);
    context.fillStyle = '#0d1117';
    context.fillRect(0, 0, plotWidth, SPECTRAL_RULER);

    this.drawTimeGrid(context, height, SPECTRAL_RULER, plotBottom, true);
    this.drawFrequencyGrid(context, plotRight, plotBottom, plotHeight);
    this.drawAxisBorder(context, width, height);
  }

  private drawTimeGrid(
    context: CanvasRenderingContext2D,
    height: number,
    plotTop: number,
    plotBottom: number,
    withLabels: boolean,
  ): void {
    if (!this.duration) return;
    const width = this.waveCanvas.clientWidth;
    const plotRight = width - AXIS_WIDTH;
    const plotWidth = plotRight;
    const step = niceStep(this.viewDuration / Math.max(2, plotWidth / 105));
    const first = Math.ceil(this.viewStart / step) * step;
    context.font = '10px Inter, ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    for (let time = first; time <= this.viewStart + this.viewDuration + step * 0.01; time += step) {
      const x = ((time - this.viewStart) / this.viewDuration) * plotWidth;
      if (x < -1 || x > plotRight + 1) continue;
      context.strokeStyle = withLabels ? 'rgba(183, 202, 219, .10)' : 'rgba(183, 202, 219, .07)';
      context.lineWidth = 1;
      context.beginPath();
      if (withLabels) {
        context.moveTo(snap(x), SPECTRAL_RULER - 4);
        context.lineTo(snap(x), SPECTRAL_RULER);
      } else {
        context.moveTo(snap(x), plotTop);
        context.lineTo(snap(x), plotBottom);
      }
      context.stroke();
      if (withLabels) {
        context.fillStyle = '#83909c';
        context.textAlign = x < 24 ? 'left' : x > plotRight - 24 ? 'right' : 'center';
        context.fillText(formatRuler(time, step), x, SPECTRAL_RULER / 2 + 0.5);
      }
    }

    if (withLabels) {
      context.strokeStyle = 'rgba(196, 216, 230, .15)';
      context.beginPath();
      context.moveTo(0, SPECTRAL_RULER - 0.5);
      context.lineTo(plotRight, SPECTRAL_RULER - 0.5);
      context.stroke();
    }
    void height;
  }

  private drawFrequencyGrid(
    context: CanvasRenderingContext2D,
    plotRight: number,
    plotBottom: number,
    plotHeight: number,
  ): void {
    const maxFrequency = this.sampleRate / 2;
    const minFrequency = this.minimumFrequency;
    const candidates = frequencyTicks(maxFrequency, this.scaleBlend, minFrequency);
    context.font = '10px Inter, ui-sans-serif, system-ui, sans-serif';
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
      context.strokeStyle = 'rgba(190, 211, 225, .2)';
      context.beginPath();
      context.moveTo(plotRight, snap(y));
      context.lineTo(plotRight + 4, snap(y));
      context.stroke();
      context.fillStyle = '#75828e';
      context.textBaseline = frequency === maxFrequency
        ? 'top'
        : frequency === minFrequency
          ? 'bottom'
          : 'middle';
      context.fillText(formatFrequency(frequency), plotRight + 9, y);
    }
  }

  private drawAxisBorder(context: CanvasRenderingContext2D, width: number, height: number): void {
    context.strokeStyle = 'rgba(190, 210, 224, .16)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(width - AXIS_WIDTH + 0.5, 0);
    context.lineTo(width - AXIS_WIDTH + 0.5, height);
    context.stroke();
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
  const minutes = Math.floor(time / 60);
  const seconds = time - minutes * 60;
  if (step < 0.1) return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
  if (step < 1) return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
  return `${minutes}:${Math.floor(seconds).toString().padStart(2, '0')}`;
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

function snap(value: number): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.round(value * dpr) / dpr;
}
