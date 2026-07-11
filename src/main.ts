import './style.css';
import { AudioEngine } from './audio-engine';
import { isPaletteName, type PaletteName } from './palettes';
import type {
  AnalysisAppend,
  AnalysisInitialize,
  AnalysisMessage,
  AnalysisMode,
  AnalysisRequest,
  AnalysisStreamInitialize,
  SpectrogramData,
} from './types';
import {
  AudioVisualizer,
  formatClock,
  type PlaybackFollowMode,
  type SelectionRange,
  type SpectrumDrawStyle,
  type SpectrumInterpolation,
  type ThemeMode,
} from './visualizer';
import { decodeWavChunk, parseWavHeader, preferredWavChunkBytes, type WavHeader } from './wav-reader';
import { trimAudioBufferToFloatWav, trimWavFile } from './wav-export';
import type { Mp4AudioSession } from './mp4-reader';

const icon = (path: string, viewBox = '0 0 24 24') => `
  <svg viewBox="${viewBox}" aria-hidden="true" focusable="false">${path}</svg>
`;

const playIcon = icon('<path d="M8 5.6v12.8c0 .8.9 1.3 1.6.8l9-6.4a1 1 0 0 0 0-1.6l-9-6.4A1 1 0 0 0 8 5.6Z" fill="currentColor"/>');
const pauseIcon = icon('<path d="M7 5.5h3.5v13H7v-13Zm6.5 0H17v13h-3.5v-13Z" fill="currentColor"/>');
const folderIcon = icon('<path d="M3.5 7.5h6l1.7 2H20.5v8.8a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7V7.5Zm0 0V6.7A1.7 1.7 0 0 1 5.2 5h4l1.6 2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>');
const importIcon = icon('<path d="M13.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4.5M4 12h11m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>');
const spectrumIcon = icon('<path d="M3 17.5h18M4 15l2.3-5 2.2 3.2L11 6l2.2 8 2.3-5.6 1.8 4.2L20 5.5" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>');
const gearIcon = icon('<path d="M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Zm7.7 4.9v-2.4l-2-.7a6.3 6.3 0 0 0-.7-1.6l.9-1.9-1.7-1.7-1.9.9a6.3 6.3 0 0 0-1.6-.7l-.7-2h-2.4l-.7 2a6.3 6.3 0 0 0-1.6.7l-1.9-.9-1.7 1.7.9 1.9a6.3 6.3 0 0 0-.7 1.6l-2 .7v2.4l2 .7c.2.6.4 1.1.7 1.6l-.9 1.9 1.7 1.7 1.9-.9c.5.3 1 .6 1.6.7l.7 2H13l.7-2c.6-.2 1.1-.4 1.6-.7l1.9.9 1.7-1.7-.9-1.9c.3-.5.6-1 .7-1.6l2-.7Z" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>');
const downloadIcon = icon('<path d="M12 3.5v11m-4-4 4 4 4-4M5 19.5h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>');
const imageIcon = icon('<rect x="3.5" y="4.5" width="17" height="15" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.55"/><circle cx="8.4" cy="9" r="1.35" fill="currentColor"/><path d="m5.5 17 4.3-4.4 2.8 2.6 2.2-2.1 3.7 3.9" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>');
const closeIcon = icon('<path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>');

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="workbench">
    <header class="topbar">
      <div class="header-leading">
        <label class="open-button icon-only" for="file-input" role="button" tabindex="0" aria-label="Import audio" title="Import audio">
          ${importIcon}
        </label>
        <input id="file-input" type="file" accept="audio/*,video/mp4,.wav,.wave,.mp3,.m4a,.mp4,.aac,.flac,.ogg,.opus" hidden />
        <div class="file-identity is-empty" id="file-identity">
          <strong id="file-name"></strong>
          <div class="file-meta-row">
            <span class="file-size" id="file-size"></span>
            <span class="file-format is-empty" id="file-format">
              <i></i>
              <span id="format-status"></span>
              <i></i>
              <span id="channel-status"></span>
            </span>
          </div>
        </div>
      </div>

      <div class="transport" aria-label="Playback controls">
        <span class="transport-time current" id="current-time" aria-live="off">00:00.000</span>
        <button class="play-button" id="play-button" type="button" aria-label="Play" title="Play / pause (Space)">
          <span class="play-icon">${playIcon}</span>
          <span class="pause-icon">${pauseIcon}</span>
        </button>
        <span class="transport-time total" id="total-time">00:00.000</span>
      </div>

      <div class="header-actions">
        <button class="header-icon-button" id="spectrum-button" type="button" aria-label="Open spectrum analyzer" aria-controls="spectrum-analyzer" aria-expanded="false" aria-pressed="false" title="Spectrum analyzer">${spectrumIcon}</button>
        <button class="header-icon-button" id="screenshot-button" type="button" aria-label="Save spectrogram screenshot" title="Save spectrogram screenshot" disabled>${imageIcon}</button>
        <button class="header-icon-button" id="selection-download-button" type="button" aria-label="Download selected audio as WAV" title="Download selection as WAV" hidden>${downloadIcon}</button>
        <button class="header-icon-button" id="settings-button" type="button" aria-label="Spectrogram settings" aria-haspopup="dialog" aria-controls="settings-modal" aria-expanded="false" title="Spectrogram settings">${gearIcon}</button>
      </div>
    </header>

    <dialog class="settings-modal" id="settings-modal" aria-label="Settings">
      <div class="settings-header">
        <button class="settings-close" id="settings-close" type="button" aria-label="Close settings">${closeIcon}</button>
      </div>
      <div class="settings-controls">
        <div class="control-group analysis-mode-control">
          <div class="control-heading">
            <label for="analysis-mode-select">Spectrogram analysis</label>
          </div>
          <div class="palette-select-row">
            <select id="analysis-mode-select" class="palette-select" aria-label="Spectrogram analysis mode">
              <option value="fft" selected>FFT — linear bins</option>
              <option value="cqt">CQT — constant-Q log bands</option>
            </select>
          </div>
        </div>
        <div class="settings-divider" aria-hidden="true"></div>
        <div class="control-group fft-control">
          <div class="control-heading">
            <label for="fft-slider">Spectrogram resolution</label>
            <output id="fft-output" for="fft-slider">1,024 bins</output>
          </div>
          <div class="slider-row">
            <span>TIME</span>
            <input id="fft-slider" class="range-input stepped" type="range" min="0" max="4" step="1" value="2" aria-label="Spectrogram resolution" />
            <span>FREQ</span>
          </div>
        </div>
        <div class="settings-divider" aria-hidden="true"></div>
        <div class="control-group fft-control">
          <div class="control-heading">
            <label for="spectrum-fft-slider">Spectrum resolution</label>
            <output id="spectrum-fft-output" for="spectrum-fft-slider">1,024 bins</output>
          </div>
          <div class="slider-row">
            <span>TIME</span>
            <input id="spectrum-fft-slider" class="range-input stepped" type="range" min="0" max="8" step="1" value="4" aria-label="Spectrum resolution" />
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
        <div class="control-group frequency-scale-control">
          <div class="control-heading">
            <label for="frequency-scale-slider">Frequency scale</label>
            <output id="frequency-scale-output" for="frequency-scale-slider">Logarithmic</output>
          </div>
          <div class="slider-row">
            <span>LIN</span>
            <input id="frequency-scale-slider" class="range-input" type="range" min="0" max="100" step="1" value="100" aria-label="Linear to logarithmic frequency scale" />
            <span>LOG</span>
          </div>
        </div>
        <div class="settings-divider" aria-hidden="true"></div>
        <div class="control-group spectrum-style-control">
          <div class="control-heading">
            <label for="spectrum-style-select">Spectrum draw style</label>
          </div>
          <div class="palette-select-row">
            <select id="spectrum-style-select" class="palette-select" aria-label="Spectrum draw style">
              <option value="outline">Outline</option>
              <option value="filled" selected>Filled</option>
              <option value="bars">Bars</option>
              <option value="lines">Lines</option>
              <option value="points">Points</option>
            </select>
          </div>
        </div>
        <div class="settings-divider" aria-hidden="true"></div>
        <div class="control-group spectrum-interpolation-control">
          <div class="control-heading">
            <label for="spectrum-interpolation-select">Spectrum interpolation</label>
          </div>
          <div class="palette-select-row">
            <select id="spectrum-interpolation-select" class="palette-select" aria-label="Spectrum interpolation style">
              <option value="nearest">Nearest neighbor</option>
              <option value="linear" selected>Linear</option>
            </select>
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
        <div class="settings-divider" aria-hidden="true"></div>
        <div class="control-group playback-control">
          <div class="control-heading">
            <label for="playback-follow-select">Playback scrolling</label>
          </div>
          <div class="palette-select-row">
            <select id="playback-follow-select" class="palette-select" aria-label="Playback scrolling behavior">
              <option value="center">Keep cursor centered</option>
              <option value="right">Keep cursor on right</option>
              <option value="page" selected>Page when cursor reaches end</option>
            </select>
          </div>
        </div>
        <div class="settings-divider" aria-hidden="true"></div>
        <div class="control-group appearance-control">
          <div class="control-heading">
            <label for="theme-toggle">Appearance</label>
          </div>
          <div class="theme-toggle-row">
            <span>Dark</span>
            <label class="theme-switch">
              <input id="theme-toggle" type="checkbox" role="switch" aria-label="Use light mode" />
              <span aria-hidden="true"></span>
            </label>
            <span>Light</span>
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
          <div class="spectrum-hover-frequency-mask" id="spectrum-hover-frequency-mask" aria-hidden="true"></div>
          <div class="spectrum-hover-frequency" id="spectrum-hover-frequency" aria-hidden="true"></div>
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

        <div class="spectrum-divider" id="spectrum-divider" role="separator" aria-label="Resize spectrum analyzer" aria-orientation="vertical" aria-valuemin="96" tabindex="0" data-timeline-exempt hidden><span></span></div>
        <aside class="spectrum-sidebar" id="spectrum-analyzer" aria-label="Spectrum at the playback cursor" data-timeline-exempt hidden>
          <div class="spectrum-wave-spacer" aria-hidden="true"></div>
          <div class="spectrum-horizontal-divider" aria-hidden="true"></div>
          <div class="spectrum-canvas-wrap">
            <canvas id="spectrum-canvas"></canvas>
          </div>
        </aside>

        <div class="editor-playhead" id="playhead" aria-hidden="true">
          <span class="playhead-line"></span>
        </div>

        <div class="drop-overlay is-visible is-empty" id="drop-overlay">
          <div class="drop-target">
            <div class="drop-icon">${folderIcon}</div>
            <strong>Drop audio to open</strong>
            <span>WAV, MP3, M4A, MP4, FLAC, OGG and more</span>
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
const waveCanvas = get<HTMLCanvasElement>('wave-canvas');
const spectralCanvas = get<HTMLCanvasElement>('spectral-canvas');
const spectrumCanvas = get<HTMLCanvasElement>('spectrum-canvas');
const playButton = get<HTMLButtonElement>('play-button');
const currentTimeElement = get<HTMLSpanElement>('current-time');
const totalTimeElement = get<HTMLSpanElement>('total-time');
const fileIdentity = get<HTMLElement>('file-identity');
const fileNameElement = get<HTMLElement>('file-name');
const fileSizeElement = get<HTMLElement>('file-size');
const fileFormatElement = get<HTMLElement>('file-format');
const fftSlider = get<HTMLInputElement>('fft-slider');
const fftOutput = get<HTMLOutputElement>('fft-output');
const spectrumFftSlider = get<HTMLInputElement>('spectrum-fft-slider');
const spectrumFftOutput = get<HTMLOutputElement>('spectrum-fft-output');
const dbRangeSlider = get<HTMLInputElement>('db-range-slider');
const dbRangeOutput = get<HTMLOutputElement>('db-range-output');
const frequencyScaleSlider = get<HTMLInputElement>('frequency-scale-slider');
const frequencyScaleOutput = get<HTMLOutputElement>('frequency-scale-output');
const analysisModeSelect = get<HTMLSelectElement>('analysis-mode-select');
const spectrumStyleSelect = get<HTMLSelectElement>('spectrum-style-select');
const spectrumInterpolationSelect = get<HTMLSelectElement>('spectrum-interpolation-select');
const paletteSelect = get<HTMLSelectElement>('palette-select');
const playbackFollowSelect = get<HTMLSelectElement>('playback-follow-select');
const themeToggle = get<HTMLInputElement>('theme-toggle');
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
const spectrumHoverFrequencyLabel = get<HTMLElement>('spectrum-hover-frequency');
const spectrumHoverFrequencyMask = get<HTMLElement>('spectrum-hover-frequency-mask');
const settingsModal = get<HTMLDialogElement>('settings-modal');
const settingsButton = get<HTMLButtonElement>('settings-button');
const settingsClose = get<HTMLButtonElement>('settings-close');
const spectrumButton = get<HTMLButtonElement>('spectrum-button');
const screenshotButton = get<HTMLButtonElement>('screenshot-button');
const selectionDownloadButton = get<HTMLButtonElement>('selection-download-button');
const spectrumDivider = get<HTMLElement>('spectrum-divider');
const spectrumAnalyzer = get<HTMLElement>('spectrum-analyzer');

const SETTINGS_STORAGE_KEY = 'audio-spectrogram.settings.v1';
const persistedSettings = readPersistedSettings();
fftSlider.value = Math.round(clampNumber(persistedSettings?.fftIndex, 2, 0, 4)).toString();
spectrumFftSlider.value = Math.round(clampNumber(persistedSettings?.spectrumFftIndex, 4, 0, 8)).toString();
dbRangeSlider.value = clampNumber(persistedSettings?.dbRange, 120, 60, 140).toString();
spectrumStyleSelect.value = isSpectrumDrawStyle(persistedSettings?.spectrumDrawStyle)
  ? persistedSettings.spectrumDrawStyle
  : 'filled';
spectrumInterpolationSelect.value = isSpectrumInterpolation(persistedSettings?.spectrumInterpolation)
  ? persistedSettings.spectrumInterpolation
  : 'linear';
analysisModeSelect.value = persistedSettings?.analysisMode === 'cqt' ? 'cqt' : 'fft';
paletteSelect.value = isPaletteName(persistedSettings?.palette) ? persistedSettings.palette : 'viridis';
playbackFollowSelect.value = isPlaybackFollowMode(persistedSettings?.playbackFollowMode)
  ? persistedSettings.playbackFollowMode
  : 'page';
themeToggle.checked = isThemeMode(persistedSettings?.theme) && persistedSettings.theme === 'light';

let monoSamples: Float32Array | null = null;
let audioSampleRate = 48000;
let audioDuration = 0;
let availableAudioSamples = 0;
let analysisWorker: Worker | null = null;
let analysisId = 0;
let fftDebounce = 0;
let viewportAnalysisTimer = 0;
let lastViewportAnalysisAt = 0;
let analysisViewStart = 0;
let analysisViewDuration = 1;
let latestSpectrogram: SpectrogramData | null = null;
let activeAnalysisRequest: AnalysisCoverage | null = null;
let sourceFile: File | null = null;
let sourceWavHeader: WavHeader | null = null;
let selection: SelectionRange | null = null;
let toastTimer = 0;
let settingsSaveTimer = 0;
let dragDepth = 0;
let hasLoadedAudio = false;
let isReadingFile = false;
let fileLoadId = 0;
let activeMp4Session: Mp4AudioSession | null = null;
let wavePanelRatio = clampNumber(persistedSettings?.paneRatio, 0.25, 0.1, 0.75);
let dividerPointer: number | null = null;
let frequencyScaleBlend = clampNumber(persistedSettings?.frequencyScale, 1, 0, 1);
let frequencyScaleDrag: { pointerId: number; anchorFrequency: number } | null = null;
let spectrumAnalyzerOpen = typeof persistedSettings?.spectrumAnalyzerOpen === 'boolean'
  ? persistedSettings.spectrumAnalyzerOpen
  : true;
let spectrumAnalyzerWidth = clampNumber(
  persistedSettings?.spectrumAnalyzerWidth,
  defaultSpectrumAnalyzerWidth(),
  96,
  Math.max(96, window.innerWidth * 0.45),
);
let spectrumDividerPointer: number | null = null;
let spectrumDividerGrabOffset = 0;
let overlayTimer = 0;
let overlayToken = 0;
let playbackFollowMode = playbackFollowSelect.value as PlaybackFollowMode;
let themeMode: ThemeMode = themeToggle.checked ? 'light' : 'dark';
let lastPlaybackAnalysisCheck = 0;

document.documentElement.dataset.theme = themeMode;

const fftBins = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536] as const;

const visualizer = new AudioVisualizer({
  editor,
  waveCanvas,
  spectralCanvas,
  spectrumCanvas,
  spectrumHoverFrequencyLabel,
  spectrumHoverFrequencyMask,
  playhead: get<HTMLElement>('playhead'),
  onSeek: (time) => {
    // While a WAV is still decoding, its AudioBuffer has its final length but
    // only the leading, contiguous section is safe to play. Keep the visual
    // cursor synchronized with the engine's clamped seek position.
    const availableTime = engine.seek(time);
    visualizer.showPlayhead(availableTime);
    updateTimecode(availableTime);
  },
  onViewChange: (start, duration) => {
    analysisViewStart = start;
    analysisViewDuration = duration;
    scheduleViewportAnalysis(engine.isPlaying ? playbackAnalysisInterval() : 24);
  },
  onSelectionChange: (nextSelection) => {
    selection = nextSelection;
    engine.setPlaybackRange(nextSelection ? [nextSelection.start, nextSelection.end] : null);
    updateSelectionDownloadState();
  },
});

engine.onEnded = () => {
  updateTimecode(engine.currentTime);
  updateTransportState();
};

playButton.addEventListener('click', () => void togglePlayback());
screenshotButton.addEventListener('click', downloadSpectrogramPng);
selectionDownloadButton.addEventListener('click', () => void downloadSelectionWav());
spectrumButton.addEventListener('click', () => {
  spectrumAnalyzerOpen = !spectrumAnalyzerOpen;
  applySpectrumAnalyzerLayout();
  scheduleSettingsSave();
});

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

analysisModeSelect.addEventListener('change', () => {
  scheduleSettingsSave();
  analyzeCurrentAudio({ force: true });
});

spectrumFftSlider.addEventListener('input', () => {
  updateSpectrumFftControl();
  visualizer.setSpectrumFftSize(fftBins[Number(spectrumFftSlider.value)] * 2);
  scheduleSettingsSave();
});

dbRangeSlider.addEventListener('input', () => {
  updateDbRangeControl();
  scheduleSettingsSave();
  visualizer.setSpectralRange(Number(dbRangeSlider.value));
});

frequencyScaleSlider.addEventListener('input', () => {
  setFrequencyScale(Number(frequencyScaleSlider.value) / 100);
});

spectrumStyleSelect.addEventListener('change', () => {
  if (!isSpectrumDrawStyle(spectrumStyleSelect.value)) return;
  visualizer.setSpectrumDrawStyle(spectrumStyleSelect.value);
  updateSpectrumInterpolationControl();
  scheduleSettingsSave();
});

spectrumInterpolationSelect.addEventListener('change', () => {
  if (!isSpectrumInterpolation(spectrumInterpolationSelect.value)) return;
  visualizer.setSpectrumInterpolation(spectrumInterpolationSelect.value);
  scheduleSettingsSave();
});

paletteSelect.addEventListener('change', () => {
  if (!isPaletteName(paletteSelect.value)) return;
  visualizer.setColorPalette(paletteSelect.value);
  scheduleSettingsSave();
});

playbackFollowSelect.addEventListener('change', () => {
  if (!isPlaybackFollowMode(playbackFollowSelect.value)) return;
  playbackFollowMode = playbackFollowSelect.value;
  visualizer.setPlaybackState(engine.isPlaying, playbackFollowMode);
  if (engine.isPlaying) {
    visualizer.follow(engine.currentTime);
    scheduleViewportAnalysis(0);
  }
  scheduleSettingsSave();
});

themeToggle.addEventListener('change', () => {
  themeMode = themeToggle.checked ? 'light' : 'dark';
  applyTheme();
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

spectrumDivider.addEventListener('pointerdown', (event) => {
  if (event.button > 0 || !spectrumAnalyzerOpen) return;
  event.preventDefault();
  event.stopPropagation();
  spectrumDividerPointer = event.pointerId;
  spectrumDividerGrabOffset = event.clientX - spectrumDivider.getBoundingClientRect().left;
  spectrumDivider.setPointerCapture(event.pointerId);
  spectrumDivider.classList.add('is-dragging');
  resizeSpectrumAnalyzerAt(event.clientX);
});

spectrumDivider.addEventListener('pointermove', (event) => {
  if (spectrumDividerPointer !== event.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  resizeSpectrumAnalyzerAt(event.clientX);
});

const finishSpectrumDividerDrag = (event: PointerEvent) => {
  if (spectrumDividerPointer !== event.pointerId) return;
  event.stopPropagation();
  spectrumDividerPointer = null;
  spectrumDividerGrabOffset = 0;
  spectrumDivider.classList.remove('is-dragging');
  scheduleSettingsSave();
};

spectrumDivider.addEventListener('pointerup', finishSpectrumDividerDrag);
spectrumDivider.addEventListener('pointercancel', finishSpectrumDividerDrag);
spectrumDivider.addEventListener('keydown', (event) => {
  if (!spectrumAnalyzerOpen) return;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') spectrumAnalyzerWidth = defaultSpectrumAnalyzerWidth();
  else if (event.key === 'End') spectrumAnalyzerWidth = 96;
  else spectrumAnalyzerWidth += event.key === 'ArrowLeft' ? 12 : -12;
  applySpectrumAnalyzerLayout();
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
  applySpectrumAnalyzerLayout();
  scheduleViewportAnalysis(90);
});
window.addEventListener('pagehide', persistSettings);

async function togglePlayback(): Promise<void> {
  if (!engine.hasAudio) return;
  try {
    if (engine.isPlaying) {
      engine.pause();
      updateTransportState();
      return;
    }

    if (selection) {
      // A selection is its own transport range: every fresh play starts at
      // the in point, then AudioEngine finishes normally at the out point.
      const selectionRange = [selection.start, selection.end] as const;
      const start = engine.seek(selection.start, selectionRange);
      visualizer.showPlayhead(start);
      updateTimecode(start);
      await engine.play(selectionRange);
    } else {
      const restartingFromEnd = engine.hasEnded || (
        audioDuration > 0 && engine.currentTime >= audioDuration - 0.001
      );
      if (restartingFromEnd) {
        engine.seek(0);
        visualizer.moveViewportToStart();
        updateTimecode(0);
      }
      await engine.play(null);
    }
    updateTransportState();
  } catch (error) {
    updateTransportState();
    showToast(error instanceof Error ? `Could not start playback: ${error.message}` : 'Could not start playback.');
  }
}

function updateTransportState(): void {
  playButton.classList.toggle('is-playing', engine.isPlaying);
  playButton.setAttribute('aria-label', engine.isPlaying ? 'Pause' : 'Play');
  visualizer.setPlaybackState(engine.isPlaying, playbackFollowMode);
  if (engine.isPlaying) {
    hideAnalysisOverlay();
    scheduleViewportAnalysis(0);
  }
}

function updateTimecode(time = engine.currentTime): void {
  currentTimeElement.textContent = formatClock(time);
  visualizer.showPlayhead(time);
}

function animationLoop(): void {
  const time = engine.currentTime;
  if (engine.isPlaying) visualizer.follow(time);
  updateTimecode(time);
  const analysisCheckInterval = playbackAnalysisInterval();
  if (engine.isPlaying && performance.now() - lastPlaybackAnalysisCheck >= analysisCheckInterval) {
    lastPlaybackAnalysisCheck = performance.now();
    scheduleViewportAnalysis(analysisCheckInterval);
  }
  requestAnimationFrame(animationLoop);
}

async function loadFile(file: File): Promise<void> {
  if (
    !file.type.startsWith('audio/') &&
    file.type !== 'video/mp4' &&
    file.type !== 'application/mp4' &&
    !/\.(wav|wave|mp3|m4a|mp4|aac|flac|ogg|opus|webm)$/i.test(file.name)
  ) {
    showToast('That file does not look like browser-decodable audio.');
    return;
  }

  const loadId = ++fileLoadId;
  prepareFileLoad(file);

  try {
    const likelyWav = /\.wave?$/i.test(file.name) || /(?:audio\/(?:wav|wave|x-wav))/i.test(file.type);
    const likelyMp4 = /\.mp4$/i.test(file.name) || /^(?:audio|video|application)\/mp4/i.test(file.type);
    const headerPromise = likelyWav ? parseWavHeader(file) : Promise.resolve(null);
    const mp4ModulePromise = likelyMp4 ? import('./mp4-reader') : null;
    const mp4SessionPromise = mp4ModulePromise
      ?.then(({ openMp4Audio }) => openMp4Audio(file))
      .then(
        (session) => ({ ok: true as const, session }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await nextPaint();
    const header = await headerPromise;
    if (loadId !== fileLoadId) return;

    if (header) {
      sourceWavHeader = header;
      await loadProgressiveWav(file, header, loadId);
    } else if (mp4SessionPromise && mp4ModulePromise) {
      const result = await mp4SessionPromise;
      if (!result.ok) {
        const error = result.error;
        const { Mp4AudioDecodeUnsupportedError } = await mp4ModulePromise;
        if (error instanceof Mp4AudioDecodeUnsupportedError) {
          if (loadId !== fileLoadId) return;
          await loadWithBrowserDecoder(file, loadId);
          return;
        }
        throw error;
      }
      const session = result.session;
      if (loadId !== fileLoadId) {
        session.dispose();
        return;
      }
      await loadProgressiveMp4(file, session, loadId);
    } else {
      await loadWithBrowserDecoder(file, loadId);
    }
  } catch (error) {
    if (loadId !== fileLoadId) return;
    isReadingFile = false;
    hasLoadedAudio = false;
    audioDuration = 0;
    availableAudioSamples = 0;
    monoSamples = null;
    activeMp4Session?.dispose();
    activeMp4Session = null;
    sourceFile = null;
    sourceWavHeader = null;
    engine.clear();
    analysisWorker?.terminate();
    analysisWorker = null;
    latestSpectrogram = null;
    updateDownloadState();
    activeAnalysisRequest = null;
    visualizer.clearAudio();
    hideAnalysisOverlay();
    clearFileHeader();
    updateTransportState();
    updateDropOverlayState();
    showToast(error instanceof Error ? `Could not decode audio: ${error.message}` : 'Could not decode that audio file.');
  }
}

function prepareFileLoad(file: File): void {
  isReadingFile = true;
  hasLoadedAudio = true;
  sourceFile = file;
  sourceWavHeader = null;
  selection = null;
  updateSelectionDownloadState();
  availableAudioSamples = 0;
  audioDuration = 0;
  monoSamples = null;
  latestSpectrogram = null;
  updateDownloadState();
  activeAnalysisRequest = null;
  activeMp4Session?.dispose();
  activeMp4Session = null;
  engine.clear();
  analysisWorker?.terminate();
  analysisWorker = null;
  hideAnalysisOverlay();
  visualizer.clearAudio();
  fileNameElement.textContent = file.name;
  fileSizeElement.textContent = `${formatFileSize(file.size)} · 0%`;
  fileIdentity.classList.remove('is-empty');
  fileFormatElement.classList.add('is-empty');
  formatStatus.textContent = '';
  channelStatus.textContent = '';
  currentTimeElement.textContent = formatClock(0);
  totalTimeElement.textContent = formatClock(0);
  updateTransportState();
  updateDropOverlayState();
}

async function loadProgressiveWav(file: File, header: WavHeader, loadId: number): Promise<void> {
  audioSampleRate = header.sampleRate;
  audioDuration = header.duration;
  availableAudioSamples = 0;
  setFileFormat(header.sampleRate, header.channels);
  totalTimeElement.textContent = formatClock(header.duration);

  monoSamples = new Float32Array(header.frameCount);
  visualizer.beginProgressiveAudio(monoSamples, header.sampleRate, header.duration);
  initializeStreamingAnalysisWorker(header.frameCount, header.sampleRate);
  await nextPaint();
  if (loadId !== fileLoadId) return;

  const playbackBuffer = engine.createBuffer(header.channels, header.frameCount, header.sampleRate);
  // Install the final-sized buffer immediately. Its unfilled tail is never
  // scheduled by AudioEngine, allowing users to play (or queue playback for)
  // the decoded prefix while the remainder streams in from disk.
  engine.setProgressiveBuffer(playbackBuffer);
  updateTransportState();
  const chunkBytes = preferredWavChunkBytes(header);
  let processedBytes = 0;
  let frameStart = 0;

  while (processedBytes < header.dataSize) {
    if (loadId !== fileLoadId) return;
    const byteCount = Math.min(chunkBytes, header.dataSize - processedBytes);
    const encoded = await file.slice(
      header.dataOffset + processedBytes,
      header.dataOffset + processedBytes + byteCount,
    ).arrayBuffer();
    if (loadId !== fileLoadId) return;

    const decoded = decodeWavChunk(encoded, header);
    monoSamples.set(decoded.mono, frameStart);
    for (let channel = 0; channel < decoded.channels.length; channel += 1) {
      playbackBuffer.copyToChannel(decoded.channels[channel], channel, frameStart);
    }
    visualizer.updateProgressiveAudio(frameStart, frameStart + decoded.frameCount);
    availableAudioSamples = frameStart + decoded.frameCount;
    engine.updateProgressiveBufferAvailability(availableAudioSamples / header.sampleRate);

    const append: AnalysisAppend = {
      type: 'append',
      startSample: frameStart,
      samples: decoded.mono.buffer,
    };
    analysisWorker?.postMessage(append, [append.samples]);

    processedBytes += decoded.frameCount * header.blockAlign;
    frameStart += decoded.frameCount;
    updateFileReadProgress(file, processedBytes / header.dataSize);
    scheduleViewportAnalysis(90);
  }

  if (loadId !== fileLoadId) return;
  availableAudioSamples = header.frameCount;
  engine.completeProgressiveBuffer();
  isReadingFile = false;
  fileSizeElement.textContent = formatFileSize(file.size);
  updateTransportState();
  analyzeCurrentAudio({ stableUpdate: true, force: true });
}

async function loadProgressiveMp4(file: File, session: Mp4AudioSession, loadId: number): Promise<void> {
  activeMp4Session = session;
  audioSampleRate = session.sampleRate;
  audioDuration = session.duration;
  availableAudioSamples = 0;
  setFileFormat(session.sampleRate, session.channels);
  totalTimeElement.textContent = formatClock(session.duration);

  monoSamples = new Float32Array(session.frameCount);
  visualizer.beginProgressiveAudio(monoSamples, session.sampleRate, session.duration);
  initializeStreamingAnalysisWorker(session.frameCount, session.sampleRate);
  engine.setMediaFile(file, session.duration);
  updateTransportState();
  await nextPaint();
  if (loadId !== fileLoadId) return;

  const publishFrames = Math.max(4096, Math.round(session.sampleRate * 2));
  let publishedEnd = 0;
  let decodedEnd = 0;
  let decodedSamples = false;
  let lastYield = performance.now();

  try {
    for await (const block of session.blocks()) {
      if (loadId !== fileLoadId) return;
      const sourceStart = Math.max(0, -block.startFrame);
      const destinationStart = Math.max(0, block.startFrame);
      const count = Math.min(
        block.samples.length - sourceStart,
        session.frameCount - destinationStart,
      );
      if (count <= 0) continue;

      monoSamples.set(block.samples.subarray(sourceStart, sourceStart + count), destinationStart);
      decodedSamples = true;
      decodedEnd = Math.max(decodedEnd, destinationStart + count);

      if (decodedEnd - publishedEnd >= publishFrames) {
        publishProgressiveMp4Frames(file, publishedEnd, decodedEnd, session.frameCount);
        publishedEnd = decodedEnd;
      }

      if (performance.now() - lastYield >= 32) {
        await nextPaint();
        lastYield = performance.now();
      }
    }

    if (loadId !== fileLoadId) return;
    if (!decodedSamples) throw new Error('The MP4 audio track did not produce any decoded samples.');
    if (decodedEnd > publishedEnd) {
      publishProgressiveMp4Frames(file, publishedEnd, decodedEnd, session.frameCount);
    }

    // The arrays are zero-initialized, so any trailing edit-list gap is already represented.
    // An empty append at the final frame marks the worker stream complete without copying it.
    visualizer.updateProgressiveAudio(session.frameCount, session.frameCount);
    availableAudioSamples = session.frameCount;
    const complete: AnalysisAppend = {
      type: 'append',
      startSample: session.frameCount,
      samples: new ArrayBuffer(0),
    };
    analysisWorker?.postMessage(complete, [complete.samples]);
    isReadingFile = false;
    fileSizeElement.textContent = formatFileSize(file.size);
    analyzeCurrentAudio({ stableUpdate: true, force: true });
  } finally {
    session.dispose();
    if (activeMp4Session === session) activeMp4Session = null;
  }
}

function publishProgressiveMp4Frames(file: File, start: number, end: number, total: number): void {
  if (!monoSamples || end <= start) return;
  visualizer.updateProgressiveAudio(start, end);
  availableAudioSamples = Math.max(availableAudioSamples, end);
  const samples = monoSamples.slice(start, end);
  const append: AnalysisAppend = {
    type: 'append',
    startSample: start,
    samples: samples.buffer,
  };
  analysisWorker?.postMessage(append, [append.samples]);
  updateFileReadProgress(file, end / Math.max(1, total));
  scheduleViewportAnalysis(90);
}

async function loadWithBrowserDecoder(file: File, loadId: number): Promise<void> {
  const encoded = await readFileWithProgress(file, loadId);
  if (loadId !== fileLoadId) return;
  fileSizeElement.textContent = `${formatFileSize(file.size)} · Decoding`;
  await nextPaint();
  const buffer = await engine.decode(encoded);
  if (loadId !== fileLoadId) return;

  engine.setBuffer(buffer);
  monoSamples = downmix(buffer);
  audioSampleRate = buffer.sampleRate;
  audioDuration = buffer.duration;
  availableAudioSamples = monoSamples.length;
  latestSpectrogram = null;
  updateDownloadState();
  activeAnalysisRequest = null;
  visualizer.setSpectrogram(null);
  visualizer.setAudio(monoSamples, buffer.sampleRate, buffer.duration);
  setFileFormat(buffer.sampleRate, buffer.numberOfChannels);
  totalTimeElement.textContent = formatClock(buffer.duration);
  updateTimecode(0);
  updateTransportState();
  isReadingFile = false;
  fileSizeElement.textContent = formatFileSize(file.size);
  initializeAnalysisWorker();
}

async function readFileWithProgress(file: File, loadId: number): Promise<ArrayBuffer> {
  const reader = file.stream().getReader();
  const encoded = new Uint8Array(file.size);
  let bytesRead = 0;
  while (true) {
    const result = await reader.read();
    if (loadId !== fileLoadId) {
      await reader.cancel();
      return new ArrayBuffer(0);
    }
    if (result.done) break;
    encoded.set(result.value, bytesRead);
    bytesRead += result.value.byteLength;
    updateFileReadProgress(file, bytesRead / Math.max(1, file.size));
  }
  return encoded.buffer;
}

function updateFileReadProgress(file: File, progress: number): void {
  const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
  fileSizeElement.textContent = percent >= 100
    ? `${formatFileSize(file.size)} · Parsing`
    : `${formatFileSize(file.size)} · ${percent}%`;
}

function setFileFormat(sampleRate: number, channels: number): void {
  formatStatus.textContent = `${sampleRate.toLocaleString()} Hz`;
  channelStatus.textContent = channels === 1 ? 'Mono' : channels === 2 ? 'Stereo' : `${channels}-channel`;
  fileFormatElement.classList.remove('is-empty');
}

function clearFileHeader(): void {
  fileNameElement.textContent = '';
  fileSizeElement.textContent = '';
  formatStatus.textContent = '';
  channelStatus.textContent = '';
  fileIdentity.classList.add('is-empty');
  fileFormatElement.classList.add('is-empty');
}

function initializeAnalysisWorker(): void {
  if (!monoSamples || audioDuration <= 0) return;
  const worker = resetAnalysisWorker();
  const samplesCopy = monoSamples.slice();
  const initialize: AnalysisInitialize = {
    type: 'initialize',
    samples: samplesCopy.buffer,
    sampleRate: audioSampleRate,
  };
  worker.postMessage(initialize, [initialize.samples]);
  analyzeCurrentAudio();
}

function initializeStreamingAnalysisWorker(sampleLength: number, sampleRate: number): void {
  const worker = resetAnalysisWorker();
  const initialize: AnalysisStreamInitialize = {
    type: 'initialize-stream',
    sampleLength,
    sampleRate,
  };
  worker.postMessage(initialize);
}

function resetAnalysisWorker(): Worker {
  analysisWorker?.terminate();
  analysisId += 1;
  activeAnalysisRequest = null;
  analysisWorker = new Worker(new URL('./spectrogram.worker.ts', import.meta.url), { type: 'module' });
  analysisWorker.onmessage = handleAnalysisMessage;
  analysisWorker.onerror = () => {
    hideAnalysisOverlay();
    showToast('The spectral analysis worker stopped unexpectedly.');
  };
  return analysisWorker;
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

function playbackAnalysisInterval(): number {
  return Math.max(16, Math.min(120, analysisViewDuration * 250));
}

function analyzeCurrentAudio(options: { stableUpdate?: boolean; force?: boolean } = {}): void {
  if (!analysisWorker || audioDuration <= 0) return;
  window.clearTimeout(fftDebounce);
  window.clearTimeout(viewportAnalysisTimer);
  viewportAnalysisTimer = 0;
  const bins = fftBins[Number(fftSlider.value)];
  const fftSize = bins * 2;
  const analysisMode: AnalysisMode = analysisModeSelect.value === 'cqt' ? 'cqt' : 'fft';
  const visibleColumns = visualizer.analysisColumnCount;
  const viewDuration = Math.max(0.001, analysisViewDuration);
  let requestStart = analysisViewStart;
  let requestEnd = analysisViewStart + viewDuration;
  let requiredEnd = requestEnd;

  if (isReadingFile) {
    const safeEnd = Math.max(0, (availableAudioSamples - fftSize / 2) / audioSampleRate);
    requestEnd = Math.min(requestEnd, safeEnd);
    requiredEnd = requestEnd;
  } else if (engine.isPlaying) {
    const requestedScreens = playbackFollowMode === 'page' ? 3 : 2;
    const requiredScreens = playbackFollowMode === 'page' ? 2.75 : 1.55;
    requestEnd = Math.min(audioDuration, requestStart + viewDuration * requestedScreens);
    requiredEnd = Math.min(audioDuration, requestStart + viewDuration * requiredScreens);
  }

  if (requestEnd <= requestStart) return;
  const requestDuration = requestEnd - requestStart;
  const requestColumns = Math.max(1, Math.round(visibleColumns * (requestDuration / viewDuration)));
  const secondsPerColumn = analysisTargetStep(requestDuration, requestColumns);

  if (!options.force && (
    coverageIncludes(latestSpectrogram, requestStart, requiredEnd, fftSize, secondsPerColumn, analysisMode) ||
    coverageIncludes(activeAnalysisRequest, requestStart, requiredEnd, fftSize, secondsPerColumn, analysisMode)
  )) return;

  lastViewportAnalysisAt = performance.now();
  analysisId += 1;
  if (!isReadingFile && !engine.isPlaying) {
    beginDelayedOverlay('Preparing spectral map', 'Computing visible columns…');
    analysisProgress.style.width = '2%';
  }

  const request: AnalysisRequest = {
    type: 'analyze',
    id: analysisId,
    fftSize,
    analysisMode,
    startTime: requestStart,
    viewDuration: requestDuration,
    columns: requestColumns,
    minimumSecondsPerColumn: 0.001,
    intermediateResults: !isReadingFile && !options.stableUpdate,
    prefetchFiner: !isReadingFile,
  };
  activeAnalysisRequest = {
    id: request.id,
    fftSize,
    mode: analysisMode,
    startTime: requestStart,
    endTime: requestEnd,
    secondsPerColumn,
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
    if (activeAnalysisRequest?.id === message.id) activeAnalysisRequest = null;
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
    mode: message.data.mode ?? 'fft',
    cqtFmin: message.data.cqtFmin,
    cqtBinsPerOctave: message.data.cqtBinsPerOctave,
  };
  latestSpectrogram = data;
  updateDownloadState();
  visualizer.setSpectrogram(data);
  if (message.complete) {
    analysisProgress.style.width = '100%';
    if (activeAnalysisRequest?.id === message.id) activeAnalysisRequest = null;
  }
  hideAnalysisOverlay();
}

function analysisTargetStep(duration: number, columns: number): number {
  const desiredMs = Math.max(1, (duration * 1000) / Math.max(1, Math.round(columns)));
  return 2 ** Math.max(0, Math.floor(Math.log2(desiredMs))) / 1000;
}

function coverageIncludes(
  coverage: Pick<SpectrogramData, 'fftSize' | 'mode' | 'startTime' | 'endTime' | 'secondsPerColumn'> | AnalysisCoverage | null,
  startTime: number,
  endTime: number,
  fftSize: number,
  secondsPerColumn: number,
  mode: AnalysisMode,
): boolean {
  if (!coverage || coverage.fftSize !== fftSize || coverage.mode !== mode) return false;
  const tolerance = Math.max(0.001, coverage.secondsPerColumn * 1.1);
  return coverage.secondsPerColumn <= secondsPerColumn * 1.01 &&
    coverage.startTime <= startTime + tolerance &&
    coverage.endTime >= endTime - tolerance;
}

function updateFftControl(): void {
  const bins = fftBins[Number(fftSlider.value)];
  fftOutput.value = `${bins.toLocaleString()} bins`;
  fftSlider.setAttribute('aria-valuetext', fftOutput.value);
  updateRangeFill(fftSlider);
}

function updateSpectrumFftControl(): void {
  const bins = fftBins[Number(spectrumFftSlider.value)];
  spectrumFftOutput.value = `${bins.toLocaleString()} bins`;
  spectrumFftSlider.setAttribute('aria-valuetext', spectrumFftOutput.value);
  updateRangeFill(spectrumFftSlider);
}

function updateSpectrumInterpolationControl(): void {
  const interpolationApplies = spectrumStyleSelect.value === 'outline' || spectrumStyleSelect.value === 'filled';
  spectrumInterpolationSelect.disabled = !interpolationApplies;
  spectrumInterpolationSelect.setAttribute('aria-disabled', (!interpolationApplies).toString());
  spectrumInterpolationSelect.closest('.spectrum-interpolation-control')?.classList.toggle(
    'is-disabled',
    !interpolationApplies,
  );
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
  frequencyScaleSlider.value = percent.toString();
  frequencyScaleOutput.value = label;
  frequencyScaleSlider.setAttribute('aria-valuenow', percent.toString());
  frequencyScaleSlider.setAttribute('aria-valuetext', label);
  updateRangeFill(frequencyScaleSlider);
  frequencyAxisControl.setAttribute('aria-valuenow', percent.toString());
  frequencyAxisControl.setAttribute('aria-valuetext', label);
  scheduleSettingsSave();
}

function applyTheme(): void {
  document.documentElement.dataset.theme = themeMode;
  themeToggle.checked = themeMode === 'light';
  themeToggle.setAttribute('aria-checked', themeToggle.checked.toString());
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    'content',
    themeMode === 'light' ? '#ffffff' : '#000000',
  );
  visualizer.setTheme(themeMode);
}

function updateRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const progress = ((Number(input.value) - min) / Math.max(1, max - min)) * 100;
  input.style.setProperty('--fill', `${progress}%`);
}

type AnalysisCoverage = {
  id: number;
  fftSize: number;
  mode: AnalysisMode;
  startTime: number;
  endTime: number;
  secondsPerColumn: number;
};

type PersistedSettings = {
  version: 7;
  paneRatio: number;
  frequencyScale: number;
  fftIndex: number;
  analysisMode?: AnalysisMode;
  spectrumFftIndex: number;
  dbRange: number;
  spectrumDrawStyle: SpectrumDrawStyle;
  spectrumInterpolation: SpectrumInterpolation;
  palette: PaletteName;
  playbackFollowMode: PlaybackFollowMode;
  spectrumAnalyzerOpen: boolean;
  spectrumAnalyzerWidth: number;
  theme: ThemeMode;
};

function readPersistedSettings(): PersistedSettings | null {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null') as Partial<PersistedSettings> | null;
    if (value?.version === 7) return value as PersistedSettings;
    if ((value?.version as number | undefined) === 6) {
      return {
        ...value,
        version: 7,
        spectrumDrawStyle: value?.spectrumDrawStyle === 'lines' ? 'points' : value?.spectrumDrawStyle,
      } as PersistedSettings;
    }
    if ((value?.version as number | undefined) === 5) {
      return {
        ...value,
        version: 7,
        theme: 'dark',
      } as PersistedSettings;
    }
    if ((value?.version as number | undefined) === 4) {
      return {
        ...value,
        version: 7,
        spectrumFftIndex: clampNumber(value?.fftIndex, 2, 0, 8),
        spectrumDrawStyle: 'filled',
        spectrumInterpolation: 'nearest',
        theme: 'dark',
      } as PersistedSettings;
    }
    if ((value?.version as number | undefined) === 3) {
      return {
        ...value,
        version: 7,
        spectrumFftIndex: clampNumber(value?.fftIndex, 2, 0, 8),
        spectrumDrawStyle: 'filled',
        spectrumInterpolation: 'nearest',
        theme: 'dark',
        spectrumAnalyzerOpen: false,
        spectrumAnalyzerWidth: defaultSpectrumAnalyzerWidth(),
      } as PersistedSettings;
    }
    if ((value?.version as number | undefined) === 2) {
      return {
        ...value,
        version: 7,
        spectrumFftIndex: clampNumber(value?.fftIndex, 2, 0, 8),
        spectrumDrawStyle: 'filled',
        spectrumInterpolation: 'nearest',
        theme: 'dark',
        playbackFollowMode: 'page',
        spectrumAnalyzerOpen: false,
        spectrumAnalyzerWidth: defaultSpectrumAnalyzerWidth(),
      } as PersistedSettings;
    }
    if ((value?.version as number | undefined) === 1) {
      return {
        ...value,
        version: 7,
        spectrumFftIndex: clampNumber(value?.fftIndex, 2, 0, 8),
        spectrumDrawStyle: 'filled',
        spectrumInterpolation: 'nearest',
        theme: 'dark',
        palette: 'viridis',
        playbackFollowMode: 'page',
        spectrumAnalyzerOpen: false,
        spectrumAnalyzerWidth: defaultSpectrumAnalyzerWidth(),
      } as PersistedSettings;
    }
    return null;
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
    version: 7,
    paneRatio: wavePanelRatio,
    frequencyScale: frequencyScaleBlend,
    fftIndex: Number(fftSlider.value),
    analysisMode: analysisModeSelect.value === 'cqt' ? 'cqt' : 'fft',
    spectrumFftIndex: Number(spectrumFftSlider.value),
    dbRange: Number(dbRangeSlider.value),
    spectrumDrawStyle: isSpectrumDrawStyle(spectrumStyleSelect.value) ? spectrumStyleSelect.value : 'filled',
    spectrumInterpolation: isSpectrumInterpolation(spectrumInterpolationSelect.value)
      ? spectrumInterpolationSelect.value
      : 'linear',
    palette: isPaletteName(paletteSelect.value) ? paletteSelect.value : 'viridis',
    playbackFollowMode,
    spectrumAnalyzerOpen,
    spectrumAnalyzerWidth,
    theme: themeMode,
  };
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be disabled or unavailable in a private browsing context.
  }
}

function isPlaybackFollowMode(value: unknown): value is PlaybackFollowMode {
  return value === 'center' || value === 'right' || value === 'page';
}

function isSpectrumDrawStyle(value: unknown): value is SpectrumDrawStyle {
  return value === 'outline' || value === 'filled' || value === 'bars' || value === 'lines' || value === 'points';
}

function isSpectrumInterpolation(value: unknown): value is SpectrumInterpolation {
  return value === 'nearest' || value === 'linear';
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light';
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

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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
  const available = Math.max(1, rect.height);
  wavePanelRatio = (clientY - rect.top) / available;
  applyPanelRatio();
}

function applyPanelRatio(): void {
  const available = Math.max(1, editor.clientHeight);
  const minWave = Math.ceil(Math.min(96, available * 0.32));
  const minSpectral = Math.ceil(Math.min(180, available * 0.48));
  const waveHeight = Math.max(
    minWave,
    Math.min(Math.floor(available - minSpectral), Math.round(wavePanelRatio * available)),
  );
  wavePanelRatio = waveHeight / available;
  editor.style.setProperty('--wave-size', `${waveHeight}px`);
  panelDivider.setAttribute('aria-valuenow', Math.round(wavePanelRatio * 100).toString());
  panelDivider.setAttribute('aria-valuetext', `${Math.round(wavePanelRatio * 100)}% waveform height`);
}

function defaultSpectrumAnalyzerWidth(): number {
  return Math.max(96, Math.round(window.innerWidth / 8));
}

function maximumSpectrumAnalyzerWidth(): number {
  const width = editor.clientWidth || window.innerWidth;
  return Math.max(96, Math.min(width * 0.45, width - 420));
}

function resizeSpectrumAnalyzerAt(clientX: number): void {
  const rect = editor.getBoundingClientRect();
  spectrumAnalyzerWidth = rect.right - clientX + spectrumDividerGrabOffset - spectrumDivider.offsetWidth / 2;
  applySpectrumAnalyzerLayout();
}

function applySpectrumAnalyzerLayout(): void {
  spectrumAnalyzerWidth = Math.max(96, Math.min(maximumSpectrumAnalyzerWidth(), spectrumAnalyzerWidth));
  editor.style.setProperty('--spectrum-size', `${Math.round(spectrumAnalyzerWidth)}px`);
  editor.classList.toggle('has-spectrum-analyzer', spectrumAnalyzerOpen);
  spectrumDivider.hidden = !spectrumAnalyzerOpen;
  spectrumAnalyzer.hidden = !spectrumAnalyzerOpen;
  spectrumButton.classList.toggle('is-active', spectrumAnalyzerOpen);
  spectrumButton.setAttribute('aria-expanded', spectrumAnalyzerOpen.toString());
  spectrumButton.setAttribute('aria-pressed', spectrumAnalyzerOpen.toString());
  spectrumButton.setAttribute('aria-label', spectrumAnalyzerOpen ? 'Close spectrum analyzer' : 'Open spectrum analyzer');
  spectrumDivider.setAttribute('aria-valuemax', Math.round(maximumSpectrumAnalyzerWidth()).toString());
  spectrumDivider.setAttribute('aria-valuenow', Math.round(spectrumAnalyzerWidth).toString());
  spectrumDivider.setAttribute('aria-valuetext', `${Math.round(spectrumAnalyzerWidth)} pixel analyzer width`);
  visualizer.setSpectrumAnalyzerOpen(spectrumAnalyzerOpen);
  scheduleViewportAnalysis(90);
}

function updateDownloadState(): void {
  screenshotButton.disabled = latestSpectrogram === null;
}

function updateSelectionDownloadState(): void {
  const hasSelection = Boolean(selection && selection.end > selection.start + 1e-9);
  selectionDownloadButton.hidden = !hasSelection;
  selectionDownloadButton.disabled = !hasSelection;
}

function downloadSpectrogramPng(): void {
  if (!latestSpectrogram || spectralCanvas.width <= 1 || spectralCanvas.height <= 1) {
    showToast('Load audio and wait for the spectrogram before downloading.');
    return;
  }

  spectralCanvas.toBlob((blob) => {
    if (!blob) {
      showToast('Could not create the spectrogram PNG.');
      return;
    }
    const sourceName = fileNameElement.textContent?.trim() || 'spectrogram';
    const baseName = sourceName.replace(/\.[^.]+$/, '') || 'spectrogram';
    triggerDownload(blob, `${baseName}-spectrogram.png`);
  }, 'image/png');
}

async function downloadSelectionWav(): Promise<void> {
  const currentSelection = selection;
  if (!currentSelection || currentSelection.end <= currentSelection.start) return;

  selectionDownloadButton.disabled = true;
  try {
    let wav: Blob;
    if (sourceFile && sourceWavHeader) {
      // This preserves source PCM/float samples byte-for-byte, including the
      // original channel count, sample rate, and bit depth.
      wav = await trimWavFile(
        sourceFile,
        sourceWavHeader,
        currentSelection.start,
        currentSelection.end,
      );
    } else if (engine.buffer) {
      wav = trimAudioBufferToFloatWav(engine.buffer, currentSelection.start, currentSelection.end);
    } else {
      throw new Error('The selected audio is not decoded enough to export yet.');
    }

    const sourceName = sourceFile?.name || fileNameElement.textContent?.trim() || 'audio';
    const baseName = sourceName.replace(/\.[^.]+$/, '') || 'audio';
    triggerDownload(wav, `${baseName}-trim.wav`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not create the selected WAV file.');
  } finally {
    updateSelectionDownloadState();
  }
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initialize(): void {
  applyTheme();
  updateFftControl();
  updateSpectrumFftControl();
  visualizer.setSpectrumFftSize(fftBins[Number(spectrumFftSlider.value)] * 2);
  visualizer.setSpectrumDrawStyle(
    isSpectrumDrawStyle(spectrumStyleSelect.value) ? spectrumStyleSelect.value : 'filled',
  );
  updateSpectrumInterpolationControl();
  visualizer.setSpectrumInterpolation(
    isSpectrumInterpolation(spectrumInterpolationSelect.value) ? spectrumInterpolationSelect.value : 'linear',
  );
  updateDbRangeControl();
  visualizer.setSpectralRange(Number(dbRangeSlider.value));
  visualizer.setColorPalette(isPaletteName(paletteSelect.value) ? paletteSelect.value : 'viridis');
  setFrequencyScale(frequencyScaleBlend);
  applySpectrumAnalyzerLayout();
  updateDownloadState();
  updateSelectionDownloadState();
  updateDropOverlayState();
  requestAnimationFrame(applyPanelRatio);
  requestAnimationFrame(animationLoop);
}

initialize();
