import './style.css';
import { AudioEngine } from './audio-engine';
import { isPaletteName, type PaletteName } from './palettes';
import type { AnalysisInitialize, AnalysisMessage, AnalysisRequest, SpectrogramData } from './types';
import { AudioVisualizer, formatClock } from './visualizer';

const icon = (path: string, viewBox = '0 0 24 24') => `
  <svg viewBox="${viewBox}" aria-hidden="true" focusable="false">${path}</svg>
`;

const playIcon = icon('<path d="M8 5.6v12.8c0 .8.9 1.3 1.6.8l9-6.4a1 1 0 0 0 0-1.6l-9-6.4A1 1 0 0 0 8 5.6Z" fill="currentColor"/>');
const pauseIcon = icon('<path d="M7 5.5h3.5v13H7v-13Zm6.5 0H17v13h-3.5v-13Z" fill="currentColor"/>');
const folderIcon = icon('<path d="M3.5 7.5h6l1.7 2H20.5v8.8a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7V7.5Zm0 0V6.7A1.7 1.7 0 0 1 5.2 5h4l1.6 2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>');
const gearIcon = icon('<path d="M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Zm7.7 4.9v-2.4l-2-.7a6.3 6.3 0 0 0-.7-1.6l.9-1.9-1.7-1.7-1.9.9a6.3 6.3 0 0 0-1.6-.7l-.7-2h-2.4l-.7 2a6.3 6.3 0 0 0-1.6.7l-1.9-.9-1.7 1.7.9 1.9a6.3 6.3 0 0 0-.7 1.6l-2 .7v2.4l2 .7c.2.6.4 1.1.7 1.6l-.9 1.9 1.7 1.7 1.9-.9c.5.3 1 .6 1.6.7l.7 2H13l.7-2c.6-.2 1.1-.4 1.6-.7l1.9.9 1.7-1.7-.9-1.9c.3-.5.6-1 .7-1.6l2-.7Z" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>');
const closeIcon = icon('<path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>');

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="workbench">
    <header class="topbar">
      <div class="file-identity is-empty" id="file-identity">
        <div class="file-name-row">
          <strong id="file-name"></strong>
          <span class="file-size" id="file-size"></span>
          <span class="file-format">
            <span id="format-status"></span>
            <i></i>
            <span id="channel-status"></span>
          </span>
        </div>
      </div>

      <div class="transport" aria-label="Playback controls">
        <button class="play-button" id="play-button" type="button" aria-label="Play" title="Play / pause (Space)">
          <span class="play-icon">${playIcon}</span>
          <span class="pause-icon">${pauseIcon}</span>
        </button>
        <div class="timecode" aria-live="off">
          <span id="current-time">00:00.000</span>
          <span class="time-divider">/</span>
          <span id="total-time">00:00.000</span>
        </div>
      </div>

      <div class="header-actions">
        <button class="settings-button" id="settings-button" type="button" aria-label="Spectrogram settings" aria-haspopup="dialog" aria-controls="settings-modal" aria-expanded="false">${gearIcon}</button>
        <label class="open-button icon-only" for="file-input" role="button" tabindex="0" aria-label="Open audio" title="Open audio">
          ${folderIcon}
        </label>
        <input id="file-input" type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus" hidden />
      </div>
    </header>

    <dialog class="settings-modal" id="settings-modal" aria-labelledby="settings-title">
      <div class="settings-header">
        <div>
          <span class="settings-kicker">Spectrogram</span>
          <h2 id="settings-title">Analysis settings</h2>
        </div>
        <button class="settings-close" id="settings-close" type="button" aria-label="Close settings">${closeIcon}</button>
      </div>
      <div class="settings-controls">
        <div class="control-group fft-control">
          <div class="control-heading">
            <label for="fft-slider">FFT resolution</label>
            <output id="fft-output" for="fft-slider">1,024 bins</output>
          </div>
          <div class="slider-row">
            <span>TIME</span>
            <input id="fft-slider" class="range-input stepped" type="range" min="0" max="4" step="1" value="2" aria-label="FFT resolution" />
            <span>FREQ</span>
          </div>
        </div>
        <div class="settings-divider" aria-hidden="true"></div>
        <div class="control-group range-control">
          <div class="control-heading">
            <label for="db-range-slider">Spectral range</label>
            <output id="db-range-output" for="db-range-slider">120 dB</output>
          </div>
          <div class="slider-row">
            <span>60</span>
            <input id="db-range-slider" class="range-input" type="range" min="60" max="140" step="5" value="120" aria-label="Spectrogram dynamic range in decibels" />
            <span>140</span>
          </div>
        </div>
        <div class="settings-divider" aria-hidden="true"></div>
        <div class="control-group palette-control">
          <div class="control-heading">
            <label for="palette-select">Color palette</label>
          </div>
          <div class="palette-select-row">
            <select id="palette-select" class="palette-select" aria-label="Spectrogram color palette">
              <option value="viridis" selected>Viridis</option>
              <option value="magma">Magma</option>
              <option value="inferno">Inferno</option>
            </select>
          </div>
        </div>
      </div>
    </dialog>

    <section class="editor-shell" aria-label="Audio waveform and spectrogram editor">
      <div class="editor-stack" id="editor">
        <section class="editor-panel wave-panel" aria-label="Waveform view">
          <canvas id="wave-canvas"></canvas>
        </section>
        <div class="panel-divider" id="panel-divider" role="separator" aria-label="Resize waveform and spectrogram panels" aria-orientation="horizontal" aria-valuemin="10" aria-valuemax="75" tabindex="0"><span></span></div>
        <section class="editor-panel spectral-panel" aria-label="Spectrogram view">
          <canvas id="spectral-canvas"></canvas>
          <div class="frequency-axis-control" id="frequency-axis-control" role="slider" aria-label="Frequency scale blend" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100" aria-valuetext="Logarithmic" tabindex="0"></div>
          <div class="analysis-overlay" id="analysis-overlay" aria-live="polite">
            <div class="analysis-card">
              <div class="analysis-orbit" aria-hidden="true"><span></span></div>
              <div>
                <strong id="analysis-title">Building spectral map</strong>
                <small id="analysis-detail">Windowing audio frames…</small>
              </div>
              <div class="analysis-progress"><span id="analysis-progress"></span></div>
            </div>
          </div>
        </section>

        <div class="editor-playhead" id="playhead" aria-hidden="true">
          <span class="playhead-cap"></span>
          <span class="playhead-line"></span>
        </div>

        <div class="drop-overlay is-visible is-empty" id="drop-overlay">
          <div class="drop-target">
            <div class="drop-icon">${folderIcon}</div>
            <strong>Drop audio to open</strong>
            <span>WAV, MP3, M4A, FLAC, OGG and more</span>
          </div>
        </div>
      </div>
    </section>

    <div class="toast" id="toast" role="status"><span class="toast-mark">!</span><span id="toast-message"></span></div>
  </main>
`;

const get = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const engine = new AudioEngine();
const editor = get<HTMLDivElement>('editor');
const playButton = get<HTMLButtonElement>('play-button');
const currentTimeElement = get<HTMLSpanElement>('current-time');
const totalTimeElement = get<HTMLSpanElement>('total-time');
const fileIdentity = get<HTMLElement>('file-identity');
const fileNameElement = get<HTMLElement>('file-name');
const fileSizeElement = get<HTMLElement>('file-size');
const fftSlider = get<HTMLInputElement>('fft-slider');
const fftOutput = get<HTMLOutputElement>('fft-output');
const dbRangeSlider = get<HTMLInputElement>('db-range-slider');
const dbRangeOutput = get<HTMLOutputElement>('db-range-output');
const paletteSelect = get<HTMLSelectElement>('palette-select');
const analysisOverlay = get<HTMLElement>('analysis-overlay');
const analysisTitle = get<HTMLElement>('analysis-title');
const analysisDetail = get<HTMLElement>('analysis-detail');
const analysisProgress = get<HTMLElement>('analysis-progress');
const fileInput = get<HTMLInputElement>('file-input');
const dropOverlay = get<HTMLElement>('drop-overlay');
const formatStatus = get<HTMLElement>('format-status');
const channelStatus = get<HTMLElement>('channel-status');
const toast = get<HTMLElement>('toast');
const toastMessage = get<HTMLElement>('toast-message');
const panelDivider = get<HTMLElement>('panel-divider');
const frequencyAxisControl = get<HTMLElement>('frequency-axis-control');
const settingsModal = get<HTMLDialogElement>('settings-modal');
const settingsButton = get<HTMLButtonElement>('settings-button');
const settingsClose = get<HTMLButtonElement>('settings-close');

const SETTINGS_STORAGE_KEY = 'audio-spectrogram.settings.v1';
const persistedSettings = readPersistedSettings();
fftSlider.value = Math.round(clampNumber(persistedSettings?.fftIndex, 2, 0, 4)).toString();
dbRangeSlider.value = clampNumber(persistedSettings?.dbRange, 120, 60, 140).toString();
paletteSelect.value = isPaletteName(persistedSettings?.palette) ? persistedSettings.palette : 'viridis';

let monoSamples: Float32Array | null = null;
let analysisWorker: Worker | null = null;
let analysisId = 0;
let fftDebounce = 0;
let viewportAnalysisTimer = 0;
let lastViewportAnalysisAt = 0;
let analysisViewStart = 0;
let analysisViewDuration = 1;
let toastTimer = 0;
let settingsSaveTimer = 0;
let dragDepth = 0;
let hasLoadedAudio = false;
let wavePanelRatio = clampNumber(persistedSettings?.paneRatio, 0.25, 0.1, 0.75);
let dividerPointer: number | null = null;
let frequencyScaleBlend = clampNumber(persistedSettings?.frequencyScale, 1, 0, 1);
let frequencyScaleDrag: { pointerId: number; anchorFrequency: number } | null = null;
let overlayTimer = 0;
let overlayToken = 0;

const fftBins = [256, 512, 1024, 2048, 4096] as const;

const visualizer = new AudioVisualizer({
  editor,
  waveCanvas: get<HTMLCanvasElement>('wave-canvas'),
  spectralCanvas: get<HTMLCanvasElement>('spectral-canvas'),
  playhead: get<HTMLElement>('playhead'),
  onSeek: (time) => {
    engine.seek(time);
    visualizer.showPlayhead(time);
    updateTimecode(time);
  },
  onViewChange: (start, duration) => {
    analysisViewStart = start;
    analysisViewDuration = duration;
    scheduleViewportAnalysis(24);
  },
});

engine.onEnded = () => {
  updateTransportState();
};

playButton.addEventListener('click', () => void togglePlayback());

settingsButton.addEventListener('click', () => {
  if (settingsModal.open) return;
  settingsModal.showModal();
  settingsButton.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => fftSlider.focus());
});

settingsClose.addEventListener('click', () => settingsModal.close());
settingsModal.addEventListener('close', () => {
  settingsButton.setAttribute('aria-expanded', 'false');
  persistSettings();
  settingsButton.focus();
});
settingsModal.addEventListener('click', (event) => {
  if (event.target !== settingsModal) return;
  const rect = settingsModal.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
    event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside) settingsModal.close();
});

fftSlider.addEventListener('input', () => {
  updateFftControl();
  scheduleSettingsSave();
  window.clearTimeout(fftDebounce);
  fftDebounce = window.setTimeout(() => analyzeCurrentAudio(), 220);
});

dbRangeSlider.addEventListener('input', () => {
  updateDbRangeControl();
  scheduleSettingsSave();
  visualizer.setSpectralRange(Number(dbRangeSlider.value));
});

paletteSelect.addEventListener('change', () => {
  if (!isPaletteName(paletteSelect.value)) return;
  visualizer.setColorPalette(paletteSelect.value);
  scheduleSettingsSave();
});

frequencyAxisControl.addEventListener('pointerdown', (event) => {
  if (event.button > 0) return;
  event.preventDefault();
  event.stopPropagation();
  frequencyScaleDrag = {
    pointerId: event.pointerId,
    anchorFrequency: visualizer.frequencyAtClientY(event.clientY),
  };
  frequencyAxisControl.setPointerCapture(event.pointerId);
  frequencyAxisControl.classList.add('is-dragging');
});

frequencyAxisControl.addEventListener('pointermove', (event) => {
  if (frequencyScaleDrag?.pointerId !== event.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  setFrequencyScale(
    visualizer.scaleBlendForFrequencyAtClientY(frequencyScaleDrag.anchorFrequency, event.clientY),
  );
});

const finishFrequencyScaleDrag = (event: PointerEvent) => {
  if (frequencyScaleDrag?.pointerId !== event.pointerId) return;
  event.stopPropagation();
  frequencyScaleDrag = null;
  frequencyAxisControl.classList.remove('is-dragging');
};

frequencyAxisControl.addEventListener('pointerup', finishFrequencyScaleDrag);
frequencyAxisControl.addEventListener('pointercancel', finishFrequencyScaleDrag);
frequencyAxisControl.addEventListener('keydown', (event) => {
  const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight'
    ? 1
    : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
      ? -1
      : 0;
  if (!direction && event.key !== 'Home' && event.key !== 'End') return;
  event.preventDefault();
  if (event.key === 'Home') setFrequencyScale(0);
  else if (event.key === 'End') setFrequencyScale(1);
  else setFrequencyScale(frequencyScaleBlend + direction * 0.05);
});

panelDivider.addEventListener('pointerdown', (event) => {
  if (event.button > 0) return;
  event.preventDefault();
  event.stopPropagation();
  dividerPointer = event.pointerId;
  panelDivider.setPointerCapture(event.pointerId);
  panelDivider.classList.add('is-dragging');
  resizePanelsAt(event.clientY);
});

panelDivider.addEventListener('pointermove', (event) => {
  if (dividerPointer !== event.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  resizePanelsAt(event.clientY);
});

const finishDividerDrag = (event: PointerEvent) => {
  if (dividerPointer !== event.pointerId) return;
  event.stopPropagation();
  dividerPointer = null;
  panelDivider.classList.remove('is-dragging');
  scheduleSettingsSave();
};

panelDivider.addEventListener('pointerup', finishDividerDrag);
panelDivider.addEventListener('pointercancel', finishDividerDrag);
panelDivider.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  wavePanelRatio += event.key === 'ArrowUp' ? -0.025 : 0.025;
  applyPanelRatio();
  scheduleSettingsSave();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
  fileInput.value = '';
});

document.querySelector<HTMLLabelElement>('.open-button')!.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') fileInput.click();
});

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat) return;
  const target = event.target as HTMLElement | null;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLButtonElement ||
    target?.closest('[role="button"]') ||
    target?.isContentEditable
  ) return;
  event.preventDefault();
  void togglePlayback();
});

window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event.dataTransfer)) return;
  event.preventDefault();
  dragDepth += 1;
  updateDropOverlayState();
});

window.addEventListener('dragover', (event) => {
  if (!hasFiles(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', () => {
  if (!dragDepth) return;
  dragDepth = Math.max(0, dragDepth - 1);
  updateDropOverlayState();
});

window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  updateDropOverlayState();
  const file = event.dataTransfer?.files[0];
  if (file) void loadFile(file);
});

window.addEventListener('resize', () => {
  applyPanelRatio();
  scheduleViewportAnalysis(90);
});
window.addEventListener('pagehide', persistSettings);

async function togglePlayback(): Promise<void> {
  if (!engine.buffer) return;
  await engine.toggle();
  updateTransportState();
}

function updateTransportState(): void {
  playButton.classList.toggle('is-playing', engine.isPlaying);
  playButton.setAttribute('aria-label', engine.isPlaying ? 'Pause' : 'Play');
}

function updateTimecode(time = engine.currentTime): void {
  currentTimeElement.textContent = formatClock(time);
  visualizer.showPlayhead(time);
}

function animationLoop(): void {
  const time = engine.currentTime;
  updateTimecode(time);
  if (engine.isPlaying) visualizer.follow(time);
  requestAnimationFrame(animationLoop);
}

async function loadFile(file: File): Promise<void> {
  if (!file.type.startsWith('audio/') && !/\.(wav|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(file.name)) {
    showToast('That file does not look like browser-decodable audio.');
    return;
  }

  beginDelayedOverlay('Opening audio', `Decoding ${file.name}…`);
  analysisProgress.style.width = '8%';
  try {
    const encoded = await file.arrayBuffer();
    analysisProgress.style.width = '18%';
    const buffer = await engine.decode(encoded);
    engine.setBuffer(buffer);
    monoSamples = downmix(buffer);
    visualizer.setSpectrogram(null);
    visualizer.setAudio(monoSamples, buffer.sampleRate, buffer.duration);
    fileNameElement.textContent = file.name;
    fileSizeElement.textContent = formatFileSize(file.size);
    fileIdentity.classList.remove('is-empty');
    formatStatus.textContent = `${buffer.sampleRate.toLocaleString()} Hz`;
    channelStatus.textContent = buffer.numberOfChannels === 1
      ? 'Mono'
      : buffer.numberOfChannels === 2
        ? 'Stereo'
        : `${buffer.numberOfChannels}-channel`;
    totalTimeElement.textContent = formatClock(buffer.duration);
    updateTimecode(0);
    updateTransportState();
    hasLoadedAudio = true;
    updateDropOverlayState();
    initializeAnalysisWorker();
  } catch (error) {
    hideAnalysisOverlay();
    showToast(error instanceof Error ? `Could not decode audio: ${error.message}` : 'Could not decode that audio file.');
  }
}

function initializeAnalysisWorker(): void {
  if (!monoSamples || !engine.buffer) return;
  analysisWorker?.terminate();
  analysisId += 1;
  analysisWorker = new Worker(new URL('./spectrogram.worker.ts', import.meta.url), { type: 'module' });
  analysisWorker.onmessage = handleAnalysisMessage;
  analysisWorker.onerror = () => {
    hideAnalysisOverlay();
    showToast('The spectral analysis worker stopped unexpectedly.');
  };
  const samplesCopy = monoSamples.slice();
  const initialize: AnalysisInitialize = {
    type: 'initialize',
    samples: samplesCopy.buffer,
    sampleRate: engine.buffer.sampleRate,
  };
  analysisWorker.postMessage(initialize, [initialize.samples]);
  analyzeCurrentAudio();
}

function scheduleViewportAnalysis(interval = 24): void {
  if (!analysisWorker) return;
  const remaining = interval - (performance.now() - lastViewportAnalysisAt);
  if (remaining <= 0) {
    window.clearTimeout(viewportAnalysisTimer);
    viewportAnalysisTimer = 0;
    analyzeCurrentAudio();
    return;
  }
  if (viewportAnalysisTimer) return;
  viewportAnalysisTimer = window.setTimeout(() => {
    viewportAnalysisTimer = 0;
    analyzeCurrentAudio();
  }, remaining);
}

function analyzeCurrentAudio(): void {
  if (!analysisWorker || !engine.buffer) return;
  window.clearTimeout(fftDebounce);
  window.clearTimeout(viewportAnalysisTimer);
  viewportAnalysisTimer = 0;
  lastViewportAnalysisAt = performance.now();
  analysisId += 1;
  beginDelayedOverlay('Preparing spectral map', 'Computing visible columns…');
  analysisProgress.style.width = '2%';
  const bins = fftBins[Number(fftSlider.value)];
  const request: AnalysisRequest = {
    type: 'analyze',
    id: analysisId,
    fftSize: bins * 2,
    startTime: analysisViewStart,
    viewDuration: analysisViewDuration,
    columns: visualizer.analysisColumnCount,
    minimumSecondsPerColumn: 0.001,
  };
  analysisWorker.postMessage(request);
}

function handleAnalysisMessage(event: MessageEvent<AnalysisMessage>): void {
  const message = event.data;
  if (message.id !== analysisId) return;
  if (message.type === 'backend') {
    analysisTitle.textContent = message.backend === 'webgpu' ? 'WebGPU spectral analysis' : 'Spectral analysis';
    analysisDetail.textContent = message.backend === 'webgpu'
      ? 'Computing visible columns…'
      : 'WebGPU unavailable • compatibility analysis';
    return;
  }
  if (message.type === 'progress') {
    const percent = Math.max(2, Math.round(message.progress * 100));
    analysisProgress.style.width = `${percent}%`;
    analysisDetail.textContent = `${percent}% analyzed`;
    return;
  }
  if (message.type === 'error') {
    hideAnalysisOverlay();
    showToast(`Spectral analysis failed: ${message.message}`);
    return;
  }

  const data: SpectrogramData = {
    values: new Int16Array(message.data.values),
    columns: message.data.columns,
    rows: message.data.rows,
    fftSize: message.data.fftSize,
    sampleRate: message.data.sampleRate,
    duration: message.data.duration,
    startTime: message.data.startTime,
    endTime: message.data.endTime,
    secondsPerColumn: message.data.secondsPerColumn,
  };
  visualizer.setSpectrogram(data);
  if (message.complete) analysisProgress.style.width = '100%';
  hideAnalysisOverlay();
}

function updateFftControl(): void {
  const bins = fftBins[Number(fftSlider.value)];
  fftOutput.value = `${bins.toLocaleString()} bins`;
  fftSlider.setAttribute('aria-valuetext', fftOutput.value);
  updateRangeFill(fftSlider);
}

function updateDbRangeControl(): void {
  dbRangeOutput.value = `${Number(dbRangeSlider.value)} dB`;
  dbRangeSlider.setAttribute('aria-valuetext', `${dbRangeOutput.value} dynamic range`);
  updateRangeFill(dbRangeSlider);
}

function setFrequencyScale(value: number): void {
  frequencyScaleBlend = Math.max(0, Math.min(1, value));
  visualizer.setScaleBlend(frequencyScaleBlend);
  const percent = Math.round(frequencyScaleBlend * 100);
  const label = percent === 0 ? 'Linear' : percent === 100 ? 'Logarithmic' : `${percent}% logarithmic`;
  frequencyAxisControl.setAttribute('aria-valuenow', percent.toString());
  frequencyAxisControl.setAttribute('aria-valuetext', label);
  scheduleSettingsSave();
}

function updateRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const progress = ((Number(input.value) - min) / Math.max(1, max - min)) * 100;
  input.style.setProperty('--fill', `${progress}%`);
}

type PersistedSettings = {
  version: 1;
  paneRatio: number;
  frequencyScale: number;
  fftIndex: number;
  dbRange: number;
  palette: PaletteName;
};

function readPersistedSettings(): PersistedSettings | null {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null') as Partial<PersistedSettings> | null;
    return value?.version === 1 ? value as PersistedSettings : null;
  } catch {
    return null;
  }
}

function scheduleSettingsSave(): void {
  window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(persistSettings, 120);
}

function persistSettings(): void {
  window.clearTimeout(settingsSaveTimer);
  const settings: PersistedSettings = {
    version: 1,
    paneRatio: wavePanelRatio,
    frequencyScale: frequencyScaleBlend,
    fftIndex: Number(fftSlider.value),
    dbRange: Number(dbRangeSlider.value),
    palette: isPaletteName(paletteSelect.value) ? paletteSelect.value : 'viridis',
  };
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be disabled or unavailable in a private browsing context.
  }
}

function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function downmix(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const source = buffer.getChannelData(channel);
    for (let i = 0; i < source.length; i += 1) mono[i] += source[i] / buffer.numberOfChannels;
  }
  return mono;
}

function hasFiles(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && [...dataTransfer.types].includes('Files'));
}

function updateDropOverlayState(): void {
  dropOverlay.classList.toggle('is-visible', dragDepth > 0 || !hasLoadedAudio);
  dropOverlay.classList.toggle('is-empty', !hasLoadedAudio);
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1_048_576) {
    const megabytes = bytes / 1_048_576;
    return `${megabytes.toFixed(megabytes >= 10 ? 1 : 2)} MB`;
  }
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(bytes >= 102_400 ? 0 : 1)} KB`;
  return `${bytes.toLocaleString()} B`;
}

function showToast(message: string): void {
  toastMessage.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 4800);
}

function beginDelayedOverlay(title: string, detail: string): void {
  const token = ++overlayToken;
  window.clearTimeout(overlayTimer);
  analysisOverlay.classList.remove('is-active');
  analysisTitle.textContent = title;
  analysisDetail.textContent = detail;
  overlayTimer = window.setTimeout(() => {
    if (token === overlayToken) analysisOverlay.classList.add('is-active');
  }, 1000);
}

function hideAnalysisOverlay(): void {
  overlayToken += 1;
  window.clearTimeout(overlayTimer);
  analysisOverlay.classList.remove('is-active');
}

function resizePanelsAt(clientY: number): void {
  const rect = editor.getBoundingClientRect();
  const dividerHeight = panelDivider.offsetHeight;
  const available = Math.max(1, rect.height - dividerHeight);
  wavePanelRatio = (clientY - rect.top - dividerHeight / 2) / available;
  applyPanelRatio();
}

function applyPanelRatio(): void {
  const dividerHeight = panelDivider.offsetHeight || 7;
  const available = Math.max(1, editor.clientHeight - dividerHeight);
  const minWave = Math.min(96, available * 0.32);
  const minSpectral = Math.min(180, available * 0.48);
  const waveHeight = Math.max(minWave, Math.min(available - minSpectral, wavePanelRatio * available));
  wavePanelRatio = waveHeight / available;
  editor.style.setProperty('--wave-size', `${waveHeight}px`);
  panelDivider.setAttribute('aria-valuenow', Math.round(wavePanelRatio * 100).toString());
  panelDivider.setAttribute('aria-valuetext', `${Math.round(wavePanelRatio * 100)}% waveform height`);
}

function initialize(): void {
  updateFftControl();
  updateDbRangeControl();
  visualizer.setSpectralRange(Number(dbRangeSlider.value));
  visualizer.setColorPalette(isPaletteName(paletteSelect.value) ? paletteSelect.value : 'viridis');
  setFrequencyScale(frequencyScaleBlend);
  updateDropOverlayState();
  requestAnimationFrame(applyPanelRatio);
  requestAnimationFrame(animationLoop);
}

initialize();
