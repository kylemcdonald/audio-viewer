import './style.css';
import { AudioEngine } from './audio-engine';
import {
  clampElevation,
  fourChannelMixWeights,
  inferAmbisonicInputFormat,
  mixChannelData,
  type AmbisonicInputFormat,
  type FourChannelWeights,
  type MonoMixMode,
} from './ambisonics';
import type {
  AmbisonicRemixInput,
  AmbisonicRemixMessage,
  RemixPriorityTier,
  RemixSampleRange,
} from './ambisonic-remix.types';
import { prepareRemixRanges, progressiveRemixColumnCounts } from './ambisonic-remix';
import { CQT_FMIN, cqtBandCount, cqtBinsPerOctave, cqtSegmentSize } from './cqt';
import type {
  DirectionalCompositionConfigure,
  DirectionalCompositionDirection,
  DirectionalCompositionResult,
} from './directional-composition.types';
import type {
  DirectionalSpectralInput,
  DirectionalSpectralMessage,
  DirectionalWaveInput,
  DirectionalWaveMessage,
} from './directional-display.types';
import { isPaletteName, type PaletteName } from './palettes';
import {
  availableSpectrogramEndTime,
  createAlignedSpectrogramTicks,
  decideSpectrogramCoverage,
  MAX_FFT_SPECTROGRAM_ROWS,
  selectSpectrogramStepMs,
  spectrogramCacheFrameCapacity,
} from './spectrogram-cache';
import type {
  AnalysisAppend,
  AnalysisCancel,
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
import { encodeAudioBufferToMp3, encodeAudioBufferToWav, trimWavFile } from './wav-export';
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

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="workbench">
    <header class="topbar">
      <div class="header-leading">
        <button class="header-icon-button" id="settings-button" type="button" aria-label="Show settings" aria-controls="settings-pane" aria-expanded="false" title="Show settings">${gearIcon}</button>
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
        <button class="header-icon-button" id="selection-download-button" type="button" aria-label="Download selected audio" title="Download selection" hidden>${downloadIcon}</button>
      </div>
    </header>

    <aside class="settings-pane" id="settings-pane" aria-label="Settings" hidden>
      <div class="settings-controls">
        <div class="ambisonic-mix-section" id="ambisonic-mix-section" hidden>
          <div class="control-group ambisonic-mix-control">
            <div class="control-heading">
              <label for="mono-mix-select">Four-channel mono mix</label>
              <output id="mono-mix-status" aria-live="polite"></output>
            </div>
            <div class="palette-select-row">
              <select id="mono-mix-select" class="palette-select" aria-label="Four-channel mono mix">
                <option value="sum" selected>Add channels (normalized)</option>
                <option value="first">First channel only</option>
                <option value="directional">Directional virtual microphone</option>
              </select>
            </div>
          </div>
          <div class="virtual-mic-controls" id="virtual-mic-controls" hidden>
            <div class="control-group ambisonic-format-control">
              <div class="control-heading">
                <label for="ambisonic-format-select">Channel layout</label>
              </div>
              <div class="palette-select-row">
                <select id="ambisonic-format-select" class="palette-select" aria-label="Ambisonic channel layout">
                  <option value="ambix" selected>AmbiX B-format · W Y Z X</option>
                  <option value="fuma">FuMa B-format · W X Y Z</option>
                  <option value="a-format">Tetrahedral A-format · FLU FRD BLD BRU</option>
                </select>
              </div>
              <p class="virtual-mic-help ambisonic-format-note" id="ambisonic-format-note" hidden>Uses an ideal scalar tetrahedral matrix. A manufacturer-calibrated A→B converter may be more accurate.</p>
            </div>
            <div class="control-group virtual-mic-direction-control">
              <div class="control-heading">
                <label id="virtual-mic-direction-label">Virtual microphone direction</label>
                <output id="virtual-mic-direction-output">0° az · 0° el</output>
              </div>
              <div
                class="virtual-mic-pad"
                id="virtual-mic-pad"
                role="slider"
                aria-labelledby="virtual-mic-direction-label"
                aria-valuemin="-180"
                aria-valuemax="180"
                aria-valuenow="0"
                aria-valuetext="0 degrees azimuth, 0 degrees elevation"
                tabindex="0"
              >
                <span class="virtual-mic-pad-equator" aria-hidden="true"></span>
                <span class="virtual-mic-pad-meridian" aria-hidden="true"></span>
                <span class="virtual-mic-dot" id="virtual-mic-dot" aria-hidden="true"></span>
              </div>
              <div class="virtual-mic-axis-labels" aria-hidden="true">
                <span>−180°</span><span>0° FRONT</span><span>+180°</span>
              </div>
              <p class="virtual-mic-help">+90° azimuth points left; elevation runs +90° up to −90° down. Max-DI has a small rear lobe.</p>
            </div>
          </div>
          <div class="settings-divider" aria-hidden="true"></div>
        </div>
        <div class="control-group analysis-mode-control">
          <div class="control-heading">
            <label for="analysis-mode-select">Spectrogram analysis</label>
          </div>
          <div class="palette-select-row">
            <select id="analysis-mode-select" class="palette-select" aria-label="Spectrogram analysis mode">
              <option value="fft">FFT — linear bins</option>
              <option value="cqt" selected>CQT — constant-Q log bands</option>
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
            <input id="fft-slider" class="range-input stepped" type="range" min="0" max="5" step="1" value="2" aria-label="Spectrogram resolution" />
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
        <div class="control-group output-format-control">
          <div class="control-heading">
            <label for="output-format-select">Download format</label>
          </div>
          <div class="palette-select-row">
            <select id="output-format-select" class="palette-select" aria-label="Selection download format">
              <option value="auto" selected>Auto (MP3 for .mp3; WAV otherwise)</option>
              <option value="wav">.wav</option>
              <option value="mp3">.mp3</option>
            </select>
          </div>
        </div>
        <div class="settings-divider" aria-hidden="true"></div>
        <div class="control-group normalize-output-control">
          <div class="control-heading">
            <label for="normalize-output-toggle">Peak normalize</label>
          </div>
          <div class="theme-toggle-row">
            <span>Off</span>
            <label class="theme-switch">
              <input id="normalize-output-toggle" type="checkbox" role="switch" aria-label="Peak normalize downloaded selections" />
              <span aria-hidden="true"></span>
            </label>
            <span>On</span>
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
    </aside>

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
const outputFormatSelect = get<HTMLSelectElement>('output-format-select');
const normalizeOutputToggle = get<HTMLInputElement>('normalize-output-toggle');
const themeToggle = get<HTMLInputElement>('theme-toggle');
const ambisonicMixSection = get<HTMLElement>('ambisonic-mix-section');
const monoMixSelect = get<HTMLSelectElement>('mono-mix-select');
const monoMixStatus = get<HTMLOutputElement>('mono-mix-status');
const virtualMicControls = get<HTMLElement>('virtual-mic-controls');
const ambisonicFormatSelect = get<HTMLSelectElement>('ambisonic-format-select');
const ambisonicFormatNote = get<HTMLElement>('ambisonic-format-note');
const virtualMicPad = get<HTMLElement>('virtual-mic-pad');
const virtualMicDot = get<HTMLElement>('virtual-mic-dot');
const virtualMicDirectionOutput = get<HTMLOutputElement>('virtual-mic-direction-output');
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
const settingsPane = get<HTMLElement>('settings-pane');
const settingsButton = get<HTMLButtonElement>('settings-button');
const spectrumButton = get<HTMLButtonElement>('spectrum-button');
const screenshotButton = get<HTMLButtonElement>('screenshot-button');
const selectionDownloadButton = get<HTMLButtonElement>('selection-download-button');
const spectrumDivider = get<HTMLElement>('spectrum-divider');
const spectrumAnalyzer = get<HTMLElement>('spectrum-analyzer');

const SETTINGS_STORAGE_KEY = 'audio-spectrogram.settings.v1';
const persistedSettings = readPersistedSettings();
// Default: CQT at 24 bands/octave with a 16,384-sample analysis segment
// (slider index 2; 341 ms at 48 kHz).
fftSlider.value = Math.round(clampNumber(persistedSettings?.fftIndex, 2, 0, 5)).toString();
spectrumFftSlider.value = Math.round(clampNumber(persistedSettings?.spectrumFftIndex, 4, 0, 8)).toString();
dbRangeSlider.value = clampNumber(persistedSettings?.dbRange, 120, 60, 140).toString();
spectrumStyleSelect.value = isSpectrumDrawStyle(persistedSettings?.spectrumDrawStyle)
  ? persistedSettings.spectrumDrawStyle
  : 'filled';
spectrumInterpolationSelect.value = isSpectrumInterpolation(persistedSettings?.spectrumInterpolation)
  ? persistedSettings.spectrumInterpolation
  : 'linear';
analysisModeSelect.value = persistedSettings?.analysisMode === 'fft' ? 'fft' : 'cqt';
paletteSelect.value = isPaletteName(persistedSettings?.palette) ? persistedSettings.palette : 'viridis';
playbackFollowSelect.value = isPlaybackFollowMode(persistedSettings?.playbackFollowMode)
  ? persistedSettings.playbackFollowMode
  : 'page';
outputFormatSelect.value = isDownloadOutputFormat(persistedSettings?.downloadFormat)
  ? persistedSettings.downloadFormat
  : 'auto';
normalizeOutputToggle.checked = persistedSettings?.normalizeOutput === true;
themeToggle.checked = isThemeMode(persistedSettings?.theme) && persistedSettings.theme === 'light';
monoMixSelect.value = isMonoMixMode(persistedSettings?.monoMixMode)
  ? persistedSettings.monoMixMode
  : 'sum';
ambisonicFormatSelect.value = isAmbisonicInputFormat(persistedSettings?.ambisonicFormat)
  ? persistedSettings.ambisonicFormat
  : 'ambix';

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
let latestSpectrogramComplete = false;
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
let downloadFormat = outputFormatSelect.value as DownloadOutputFormat;
let normalizeOutput = normalizeOutputToggle.checked;
let themeMode: ThemeMode = themeToggle.checked ? 'light' : 'dark';
let settingsPaneOpen = persistedSettings?.settingsPaneOpen === true;
let lastPlaybackAnalysisCheck = 0;
let sourceChannelCount = 0;
let fourChannelMixSource: 'wav' | 'buffer' | null = null;
let monoMixMode = monoMixSelect.value as MonoMixMode;
let ambisonicInputFormat = ambisonicFormatSelect.value as AmbisonicInputFormat;
let virtualMicAzimuth = clampNumber(persistedSettings?.virtualMicAzimuth, 0, -180, 180);
let virtualMicElevation = clampElevation(clampNumber(persistedSettings?.virtualMicElevation, 0, -90, 90));
let virtualMicPointer: number | null = null;
let ambisonicRemixWorker: Worker | null = null;
let ambisonicRemixId = 0;
let ambisonicRemixActive = false;
let ambisonicRemixTimer = 0;
let lastAmbisonicRemixAt = 0;
let ambisonicPriorityTimer = 0;
let remixTierToken = 0;
const remixTierColumns = new Map<number, number>();
let remixAnalysisQueue: number[] = [];
let remixAnalysisRequest: { id: number; columns: number } | null = null;
let remixAnalysisFrame = 0;
let decodedBufferRemixId = 0;
let directionalWaveWorker: Worker | null = null;
let directionalSpectralWorker: Worker | null = null;
let directionalWaveReady = false;
let directionalViewVersion = 0;
let directionalWaveRequestId = 0;
let directionalSpectralGeneration = 0;
let directionalSpectralDirectionId = 0;
let directionalSpectralRenderedDirectionId = 0;
let directionalSpectralDirectionStartedAt = 0;
let directionalDisplayQueued = false;
let directionalViewportTimer = 0;
let directionalSpectralTier = 0;
let directionalSpectralTierTargets: number[] = [];
let directionalSpectralDisplayCache: {
  generation: number;
  ticks: number[];
  binsPerCell: number;
  rows: number;
  fftSize: number;
  sampleRate: number;
  duration: number;
  mode: AnalysisMode;
} | null = null;
let directionalCompositionWorkers: Worker[] = [];
let directionalCompositionActiveWorkers = 0;
let directionalCompositionActiveId = 0;
let directionalCompositionQueuedWeights: FourChannelWeights | null = null;
let directionalCompositionPending: {
  id: number;
  generation: number;
  values: Int16Array<ArrayBuffer>;
  received: Uint8Array;
} | null = null;
let directionalSpectralViewport: {
  generation: number;
  startTime: number;
  duration: number;
  segmentSize: number;
  fftSize: number;
  rows: number;
  mode: AnalysisMode;
  sourceViewStart: number;
  sourceViewDuration: number;
} | null = null;
let directionalSpectralPendingTier: {
  generation: number;
  tier: number;
  segmentSize: number;
  targetTicks: number[];
  missingTicks: number[] | null;
  cursor: number;
  batch: number;
  buffer: AudioBuffer;
} | null = null;
let directionalStreamingRefreshPending = false;
const DIRECTIONAL_WAVE_BLOCK_SIZE = 64;
const MAX_RAW_DIRECTIONAL_WAVE_SAMPLES = 262_144;
const MAX_DIRECTIONAL_FFT_ROWS = 1024;
const MAX_DIRECTIONAL_WAVE_BLOCKS = 524_288;
const MAX_DIRECTIONAL_SPECTRAL_BATCH_VALUES = 2_097_152;

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
    directionalViewVersion += 1;
    scheduleDirectionalViewportPreparation(engine.isPlaying ? 90 : 0);
    scheduleAmbisonicViewportPriority();
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
selectionDownloadButton.addEventListener('click', () => void downloadSelectionAudio());
spectrumButton.addEventListener('click', () => {
  spectrumAnalyzerOpen = !spectrumAnalyzerOpen;
  applySpectrumAnalyzerLayout();
  scheduleSettingsSave();
});

settingsButton.addEventListener('click', () => {
  if (!settingsPaneOpen) {
    // CQT labels include the segment duration, which depends on the loaded
    // file's sample rate — refresh when the pane opens.
    updateFftControl();
    updateSpectrumFftControl();
  }
  setSettingsPaneOpen(!settingsPaneOpen);
  scheduleSettingsSave();
});

fftSlider.addEventListener('input', () => {
  updateFftControl();
  scheduleSettingsSave();
  invalidateSpectrogramAnalysis();
  prepareDirectionalSpectralViewportOnly(true);
  window.clearTimeout(fftDebounce);
  fftDebounce = window.setTimeout(() => analyzeCurrentAudio(), 220);
});

analysisModeSelect.addEventListener('change', () => {
  updateFftControl();
  updateSpectrumFftControl();
  visualizer.setAnalysisMode(analysisModeSelect.value === 'cqt' ? 'cqt' : 'fft');
  scheduleSettingsSave();
  invalidateSpectrogramAnalysis();
  prepareDirectionalSpectralViewportOnly(true);
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

outputFormatSelect.addEventListener('change', () => {
  if (!isDownloadOutputFormat(outputFormatSelect.value)) return;
  downloadFormat = outputFormatSelect.value;
  scheduleSettingsSave();
});

normalizeOutputToggle.addEventListener('change', () => {
  normalizeOutput = normalizeOutputToggle.checked;
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

monoMixSelect.addEventListener('change', () => {
  if (!isMonoMixMode(monoMixSelect.value)) return;
  monoMixMode = monoMixSelect.value;
  updateAmbisonicMixControls();
  applyFourChannelMixWeights();
  updateDirectionalDisplayMode();
  scheduleSettingsSave();
  scheduleAmbisonicRemix(true);
});

ambisonicFormatSelect.addEventListener('change', () => {
  if (!isAmbisonicInputFormat(ambisonicFormatSelect.value)) return;
  ambisonicInputFormat = ambisonicFormatSelect.value;
  updateAmbisonicMixControls();
  applyFourChannelMixWeights();
  scheduleDirectionalDisplayUpdate();
  scheduleSettingsSave();
  scheduleAmbisonicRemix(true);
});

virtualMicPad.addEventListener('pointerdown', (event) => {
  if (event.button > 0) return;
  event.preventDefault();
  virtualMicPointer = event.pointerId;
  virtualMicPad.setPointerCapture(event.pointerId);
  virtualMicPad.classList.add('is-dragging');
  setVirtualMicDirectionFromPointer(event, false);
});

virtualMicPad.addEventListener('pointermove', (event) => {
  if (virtualMicPointer !== event.pointerId) return;
  event.preventDefault();
  setVirtualMicDirectionFromPointer(event, false);
});

const finishVirtualMicDrag = (event: PointerEvent) => {
  if (virtualMicPointer !== event.pointerId) return;
  event.preventDefault();
  virtualMicPointer = null;
  virtualMicPad.classList.remove('is-dragging');
  scheduleAmbisonicRemix(true);
};

virtualMicPad.addEventListener('pointerup', finishVirtualMicDrag);
virtualMicPad.addEventListener('pointercancel', finishVirtualMicDrag);
virtualMicPad.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') {
    setVirtualMicDirection(0, 0, true);
    return;
  }
  const step = event.shiftKey ? 1 : 5;
  const azimuth = virtualMicAzimuth + (
    event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
  );
  const elevation = virtualMicElevation + (
    event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0
  );
  setVirtualMicDirection(azimuth, elevation, true);
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
  directionalViewVersion += 1;
  scheduleDirectionalViewportPreparation(45);
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
    clearFourChannelMixSource();
    engine.clear();
    analysisWorker?.terminate();
    analysisWorker = null;
    latestSpectrogram = null;
    latestSpectrogramComplete = false;
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
  clearFourChannelMixSource();
  selection = null;
  updateSelectionDownloadState();
  availableAudioSamples = 0;
  audioDuration = 0;
  monoSamples = null;
  latestSpectrogram = null;
  latestSpectrogramComplete = false;
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
  configureFourChannelMix(file, header.channels, header.ambisonicFormat ?? null, 'wav');
  totalTimeElement.textContent = formatClock(header.duration);

  monoSamples = new Float32Array(header.frameCount);
  visualizer.beginProgressiveAudio(monoSamples, header.sampleRate, header.duration);
  initializeStreamingAnalysisWorker(header.frameCount, header.sampleRate);
  if (header.channels === 4) initializeDirectionalDisplay(header.frameCount, header.sampleRate);
  await nextPaint();
  if (loadId !== fileLoadId) return;

  const playbackBuffer = engine.createBuffer(header.channels, header.frameCount, header.sampleRate);
  // Install the final-sized buffer immediately. Its unfilled tail is never
  // scheduled by AudioEngine, allowing users to play (or queue playback for)
  // the decoded prefix while the remainder streams in from disk.
  engine.setProgressiveBuffer(playbackBuffer);
  installFourChannelSpectrumSource(playbackBuffer);
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

    const decoded = decodeWavChunk(
      encoded,
      header,
      header.channels === 4 ? currentFourChannelWeights() ?? undefined : undefined,
    );
    monoSamples.set(decoded.mono, frameStart);
    for (let channel = 0; channel < decoded.channels.length; channel += 1) {
      playbackBuffer.copyToChannel(decoded.channels[channel], channel, frameStart);
    }
    if (decoded.channels.length === 4) {
      appendDirectionalWaveSource(frameStart, decoded.channels);
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
    scheduleDirectionalViewportPreparation(frameStart === decoded.frameCount ? 0 : 90);
    scheduleViewportAnalysis(90);
  }

  if (loadId !== fileLoadId) return;
  availableAudioSamples = header.frameCount;
  completeDirectionalWaveSource(header.frameCount);
  engine.completeProgressiveBuffer();
  isReadingFile = false;
  fileSizeElement.textContent = formatFileSize(file.size);
  updateTransportState();
  scheduleDirectionalViewportPreparation(0, true);
  analyzeCurrentAudio({ stableUpdate: true, force: true });
}

async function loadProgressiveMp4(file: File, session: Mp4AudioSession, loadId: number): Promise<void> {
  activeMp4Session = session;
  audioSampleRate = session.sampleRate;
  audioDuration = session.duration;
  availableAudioSamples = 0;
  setFileFormat(session.sampleRate, session.channels);
  configureFourChannelMix(file, session.channels, null, null);
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
      complete: true,
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

  configureFourChannelMix(file, buffer.numberOfChannels, null, 'buffer');
  engine.setBuffer(buffer);
  engine.setChannelMix(buffer.numberOfChannels === 4 ? currentFourChannelWeights() : null);
  monoSamples = downmix(
    buffer,
    buffer.numberOfChannels === 4 ? currentFourChannelWeights() ?? undefined : undefined,
  );
  audioSampleRate = buffer.sampleRate;
  audioDuration = buffer.duration;
  availableAudioSamples = monoSamples.length;
  latestSpectrogram = null;
  latestSpectrogramComplete = false;
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
  if (buffer.numberOfChannels === 4) {
    initializeDirectionalDisplay(buffer.length, buffer.sampleRate);
    scheduleDirectionalViewportPreparation(0, true);
    void preprocessDecodedDirectionalSource(buffer, loadId);
  }
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

function restartStreamingAnalysisWorker(sampleLength: number, sampleRate: number): void {
  const worker = analysisWorker;
  if (!worker) {
    initializeStreamingAnalysisWorker(sampleLength, sampleRate);
    return;
  }

  // Ignore any result from the previous mono direction immediately, while
  // retaining the worker's initialized WebGPU device and CQT plans.
  analysisId += 1;
  activeAnalysisRequest = null;
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
  const worker = new Worker(new URL('./spectrogram.worker.ts', import.meta.url), { type: 'module' });
  analysisWorker = worker;
  worker.onmessage = (event) => {
    if (analysisWorker === worker) handleAnalysisMessage(event);
  };
  worker.onerror = () => {
    if (analysisWorker !== worker) return;
    analysisId += 1;
    activeAnalysisRequest = null;
    analysisWorker = null;
    worker.terminate();
    hideAnalysisOverlay();
    showToast('The spectral analysis worker stopped unexpectedly.');
  };
  return worker;
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

function cancelSpectrogramAnalysis(): void {
  activeAnalysisRequest = null;
  if (!analysisWorker) return;
  analysisId += 1;
  const cancel: AnalysisCancel = { type: 'cancel', id: analysisId };
  analysisWorker.postMessage(cancel);
  hideAnalysisOverlay();
}

function invalidateSpectrogramAnalysis(): void {
  const preserveVisibleSpectrogram = directionalDisplayOwnsSpectrogram();
  cancelSpectrogramAnalysis();
  latestSpectrogram = null;
  latestSpectrogramComplete = false;
  if (!preserveVisibleSpectrogram) visualizer.setSpectrogram(null);
  updateDownloadState();
}

function analyzeCurrentAudio(options: {
  stableUpdate?: boolean;
  force?: boolean;
  columns?: number;
  visibleOnly?: boolean;
  suppressOverlay?: boolean;
} = {}): number | null {
  if (!analysisWorker || audioDuration <= 0) return null;
  if (directionalDisplayOwnsSpectrogram()) return null;
  if (!options.force && (remixAnalysisRequest || remixAnalysisQueue.length > 0)) return null;
  window.clearTimeout(fftDebounce);
  window.clearTimeout(viewportAnalysisTimer);
  viewportAnalysisTimer = 0;
  const bins = fftBins[Number(fftSlider.value)];
  const fftSize = bins * 2;
  const analysisMode: AnalysisMode = analysisModeSelect.value === 'cqt' ? 'cqt' : 'fft';
  const visibleColumns = options.columns ?? visualizer.analysisColumnCount;
  const viewDuration = Math.max(0.001, analysisViewDuration);
  let requestStart = analysisViewStart;
  let requestEnd = analysisViewStart + viewDuration;
  let requiredEnd = requestEnd;

  if (isReadingFile && !(options.visibleOnly && ambisonicRemixActive)) {
    const segmentSize = analysisMode === 'cqt' ? cqtSegmentSize(fftSize) : fftSize;
    const safeEnd = availableSpectrogramEndTime(
      availableAudioSamples,
      audioSampleRate,
      segmentSize,
    );
    requestEnd = Math.min(requestEnd, safeEnd);
    requiredEnd = requestEnd;
  } else if (engine.isPlaying && !options.visibleOnly) {
    const requestedScreens = playbackFollowMode === 'page' ? 3 : 2;
    const requiredScreens = playbackFollowMode === 'page' ? 2.75 : 1.55;
    requestEnd = Math.min(audioDuration, requestStart + viewDuration * requestedScreens);
    requiredEnd = Math.min(audioDuration, requestStart + viewDuration * requiredScreens);
  }

  if (requestEnd <= requestStart) return null;
  const requestDuration = requestEnd - requestStart;
  const requestColumns = Math.max(1, Math.round(visibleColumns * (requestDuration / viewDuration)));
  const secondsPerColumn = analysisTargetStep(
    requestStart,
    requestDuration,
    requestColumns,
    fftSize,
    analysisMode,
  );

  if (!options.force) {
    const coverageDecision = decideSpectrogramCoverage(
      latestSpectrogram,
      latestSpectrogramComplete,
      activeAnalysisRequest,
      {
        fftSize,
        mode: analysisMode,
        startTime: requestStart,
        endTime: requiredEnd,
        secondsPerColumn,
      },
    );
    if (coverageDecision === 'reuse-latest-and-cancel-active') {
      // A pan can return to the last completed view while a request for the
      // abandoned view is still running. Ignore/cancel that request so its
      // eventual result cannot overwrite the valid map now on screen.
      cancelSpectrogramAnalysis();
      return null;
    }
    if (coverageDecision !== 'request') return null;
  }

  lastViewportAnalysisAt = performance.now();
  analysisId += 1;
  // Analysis is deliberately non-modal. The previous pixels remain visible
  // until an intermediate or completed replacement is ready.
  if (!isReadingFile && !engine.isPlaying && !options.suppressOverlay) analysisProgress.style.width = '2%';

  const request: AnalysisRequest = {
    type: 'analyze',
    id: analysisId,
    fftSize,
    analysisMode,
    startTime: requestStart,
    viewDuration: requestDuration,
    columns: requestColumns,
    minimumSecondsPerColumn: 0.001,
    intermediateResults: options.columns === undefined && !isReadingFile && !options.stableUpdate,
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
  return request.id;
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
    finishRemixSpectrogramAnalysis(message.id);
    hideAnalysisOverlay();
    showToast(`Spectral analysis failed: ${message.message}`);
    return;
  }
  if (message.type === 'unavailable') {
    if (activeAnalysisRequest?.id === message.id) activeAnalysisRequest = null;
    finishRemixSpectrogramAnalysis(message.id);
    hideAnalysisOverlay();
    return;
  }

  if (directionalDisplayOwnsSpectrogram()) {
    if (message.complete) {
      if (activeAnalysisRequest?.id === message.id) activeAnalysisRequest = null;
      finishRemixSpectrogramAnalysis(message.id);
    }
    hideAnalysisOverlay();
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
  latestSpectrogramComplete = message.complete;
  updateDownloadState();
  visualizer.setSpectrogram(data);
  if (message.complete) {
    analysisProgress.style.width = '100%';
    if (activeAnalysisRequest?.id === message.id) activeAnalysisRequest = null;
    finishRemixSpectrogramAnalysis(message.id);
  }
  hideAnalysisOverlay();
}

function analysisTargetStep(
  startTime: number,
  duration: number,
  columns: number,
  fftSize: number,
  mode: AnalysisMode,
  minimumSecondsPerColumn = 0.001,
  rowCount?: number,
): number {
  const rows = rowCount ?? (mode === 'cqt'
    ? cqtBandCount(audioSampleRate, fftSize)
    : Math.min(fftSize / 2, MAX_FFT_SPECTROGRAM_ROWS));
  return selectSpectrogramStepMs(
    startTime,
    duration,
    columns,
    minimumSecondsPerColumn,
    spectrogramCacheFrameCapacity(rows),
  ) / 1000;
}

function cqtSettingLabel(fftSize: number): string {
  // B alone is degenerate across the lowest slider positions; the segment
  // duration is what still changes there (time vs low-end resolution).
  const ms = (cqtSegmentSize(fftSize) / audioSampleRate) * 1000;
  const duration = ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
  return `${cqtBinsPerOctave(fftSize)} bands/oct · ${duration}`;
}

function updateFftControl(): void {
  const bins = fftBins[Number(fftSlider.value)];
  fftOutput.value = analysisModeSelect.value === 'cqt'
    ? cqtSettingLabel(bins * 2)
    : `${bins.toLocaleString()} bins`;
  fftSlider.setAttribute('aria-valuetext', fftOutput.value);
  updateRangeFill(fftSlider);
}

function updateSpectrumFftControl(): void {
  const bins = fftBins[Number(spectrumFftSlider.value)];
  spectrumFftOutput.value = analysisModeSelect.value === 'cqt'
    ? cqtSettingLabel(bins * 2)
    : `${bins.toLocaleString()} bins`;
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

function setSettingsPaneOpen(open: boolean): void {
  settingsPaneOpen = open;
  settingsPane.hidden = !open;
  settingsButton.classList.toggle('is-active', open);
  settingsButton.setAttribute('aria-expanded', open.toString());
  settingsButton.setAttribute('aria-label', open ? 'Hide settings' : 'Show settings');
  settingsButton.title = open ? 'Hide settings' : 'Show settings';
}

function updateRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const progress = ((Number(input.value) - min) / Math.max(1, max - min)) * 100;
  input.style.setProperty('--fill', `${progress}%`);
}

type DownloadOutputFormat = 'auto' | 'wav' | 'mp3';

type AnalysisCoverage = {
  id: number;
  fftSize: number;
  mode: AnalysisMode;
  startTime: number;
  endTime: number;
  secondsPerColumn: number;
};

type PersistedSettings = {
  version: 8;
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
  settingsPaneOpen?: boolean;
  downloadFormat?: DownloadOutputFormat;
  normalizeOutput?: boolean;
  monoMixMode?: MonoMixMode;
  ambisonicFormat?: AmbisonicInputFormat;
  virtualMicAzimuth?: number;
  virtualMicElevation?: number;
};

function readPersistedSettings(): PersistedSettings | null {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null') as Partial<PersistedSettings> | null;
    if (value?.version === 8) return value as PersistedSettings;
    if ((value?.version as number | undefined) === 7) {
      return { ...value, version: 8 } as PersistedSettings;
    }
    if ((value?.version as number | undefined) === 6) {
      return {
        ...value,
        version: 8,
        spectrumDrawStyle: value?.spectrumDrawStyle === 'lines' ? 'points' : value?.spectrumDrawStyle,
      } as PersistedSettings;
    }
    if ((value?.version as number | undefined) === 5) {
      return {
        ...value,
        version: 8,
        theme: 'dark',
      } as PersistedSettings;
    }
    if ((value?.version as number | undefined) === 4) {
      return {
        ...value,
        version: 8,
        spectrumFftIndex: clampNumber(value?.fftIndex, 2, 0, 8),
        spectrumDrawStyle: 'filled',
        spectrumInterpolation: 'nearest',
        theme: 'dark',
      } as PersistedSettings;
    }
    if ((value?.version as number | undefined) === 3) {
      return {
        ...value,
        version: 8,
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
        version: 8,
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
        version: 8,
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
    version: 8,
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
    settingsPaneOpen,
    downloadFormat,
    normalizeOutput,
    monoMixMode,
    ambisonicFormat: ambisonicInputFormat,
    virtualMicAzimuth,
    virtualMicElevation,
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

function isDownloadOutputFormat(value: unknown): value is DownloadOutputFormat {
  return value === 'auto' || value === 'wav' || value === 'mp3';
}

function isMonoMixMode(value: unknown): value is MonoMixMode {
  return value === 'sum' || value === 'first' || value === 'directional';
}

function isAmbisonicInputFormat(value: unknown): value is AmbisonicInputFormat {
  return value === 'ambix' || value === 'fuma' || value === 'a-format';
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

function configureFourChannelMix(
  file: File,
  channels: number,
  detectedFormat: AmbisonicInputFormat | null,
  sourceKind: 'wav' | 'buffer' | null,
): void {
  sourceChannelCount = channels;
  fourChannelMixSource = channels === 4 ? sourceKind : null;
  const inferredFormat = detectedFormat ?? inferAmbisonicInputFormat(file.name);
  if (channels === 4 && inferredFormat) {
    ambisonicInputFormat = inferredFormat;
    ambisonicFormatSelect.value = inferredFormat;
  }
  ambisonicMixSection.hidden = channels !== 4 || !fourChannelMixSource;
  updateAmbisonicMixControls();
  visualizer.setWaveformLabel(
    channels === 4 && fourChannelMixSource
      ? monoMixMode === 'sum' ? 'SUM 4' : monoMixMode === 'first' ? 'CH 1' : 'VMIC'
      : channels === 1 ? 'MONO' : 'L+R',
  );
  applyFourChannelMixWeights();
}

function clearFourChannelMixSource(): void {
  sourceChannelCount = 0;
  fourChannelMixSource = null;
  ambisonicRemixActive = false;
  ambisonicRemixId += 1;
  decodedBufferRemixId += 1;
  window.clearTimeout(ambisonicRemixTimer);
  window.clearTimeout(ambisonicPriorityTimer);
  ambisonicRemixTimer = 0;
  ambisonicPriorityTimer = 0;
  remixTierColumns.clear();
  clearRemixAnalysisQueue();
  ambisonicRemixWorker?.terminate();
  ambisonicRemixWorker = null;
  disposeDirectionalDisplay();
  ambisonicMixSection.hidden = true;
  monoMixStatus.value = '';
  visualizer.setSpectrumChannelSource(null);
  visualizer.setSpectrumChannelWeights(null);
  engine.setChannelMix(null);
}

function initializeDirectionalDisplay(sampleLength: number, sampleRate: number): void {
  disposeDirectionalDisplay();
  if (sourceChannelCount !== 4 || !fourChannelMixSource) return;

  const waveWorker = new Worker(new URL('./directional-waveform.worker.ts', import.meta.url), {
    type: 'module',
  });
  waveWorker.onmessage = (event: MessageEvent<DirectionalWaveMessage>) => {
    if (directionalWaveWorker !== waveWorker) return;
    handleDirectionalWaveMessage(event.data);
  };
  waveWorker.onerror = () => {
    if (directionalWaveWorker !== waveWorker) return;
    directionalWaveWorker = null;
    directionalWaveReady = false;
    visualizer.setWaveformPreview(null);
    waveWorker.terminate();
  };
  directionalWaveWorker = waveWorker;
  const initializeWave: DirectionalWaveInput = {
    type: 'initialize',
    sampleLength,
    sampleRate,
    blockSize: directionalWaveBlockSize(sampleLength),
  };
  waveWorker.postMessage(initializeWave);

  const spectralWorker = new Worker(new URL('./directional-spectrogram.worker.ts', import.meta.url), {
    type: 'module',
  });
  spectralWorker.onmessage = (event: MessageEvent<DirectionalSpectralMessage>) => {
    if (directionalSpectralWorker !== spectralWorker) return;
    handleDirectionalSpectralMessage(event.data);
  };
  spectralWorker.onerror = () => {
    if (directionalSpectralWorker !== spectralWorker) return;
    directionalSpectralWorker = null;
    spectralWorker.terminate();
    // The ordinary mono analysis worker remains alive as a compatibility
    // fallback. Its next completed result may take over without blanking the
    // directional image already on screen.
    analyzeCurrentAudio({ force: true, suppressOverlay: true });
  };
  directionalSpectralWorker = spectralWorker;
  initializeDirectionalCompositionWorkers();
  const buffer = engine.buffer;
  if (buffer) installFourChannelSpectrumSource(buffer);
  updateDirectionalDisplayMode();
}

function initializeDirectionalCompositionWorkers(): void {
  for (const worker of directionalCompositionWorkers) worker.terminate();
  directionalCompositionWorkers = [];
  directionalCompositionActiveWorkers = 0;
  directionalCompositionActiveId = 0;
  directionalCompositionQueuedWeights = null;
  directionalCompositionPending = null;
  const hardwareThreads = navigator.hardwareConcurrency || 4;
  const workerCount = Math.max(1, Math.min(8, hardwareThreads - 1));
  for (let index = 0; index < workerCount; index += 1) {
    const worker = new Worker(new URL('./directional-composition.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<DirectionalCompositionResult>) => {
      if (!directionalCompositionWorkers.includes(worker)) return;
      handleDirectionalCompositionResult(event.data);
    };
    worker.onerror = () => {
      if (!directionalCompositionWorkers.includes(worker)) return;
      for (const activeWorker of directionalCompositionWorkers) activeWorker.terminate();
      directionalCompositionWorkers = [];
      directionalCompositionActiveWorkers = 0;
      directionalCompositionActiveId = 0;
      directionalCompositionQueuedWeights = null;
      directionalCompositionPending = null;
    };
    directionalCompositionWorkers.push(worker);
  }
}

function disposeDirectionalDisplay(): void {
  window.clearTimeout(directionalViewportTimer);
  directionalViewportTimer = 0;
  directionalDisplayQueued = false;
  directionalViewVersion += 1;
  directionalWaveRequestId += 1;
  directionalSpectralGeneration += 1;
  directionalSpectralDirectionId += 1;
  directionalSpectralRenderedDirectionId = directionalSpectralDirectionId;
  directionalWaveReady = false;
  directionalSpectralTier = 0;
  directionalSpectralTierTargets = [];
  directionalSpectralDisplayCache = null;
  directionalSpectralViewport = null;
  directionalSpectralPendingTier = null;
  directionalStreamingRefreshPending = false;
  directionalCompositionPending = null;
  directionalCompositionActiveWorkers = 0;
  directionalCompositionActiveId = 0;
  directionalCompositionQueuedWeights = null;
  for (const worker of directionalCompositionWorkers) worker.terminate();
  directionalCompositionWorkers = [];
  directionalWaveWorker?.terminate();
  directionalSpectralWorker?.terminate();
  directionalWaveWorker = null;
  directionalSpectralWorker = null;
  visualizer.setWaveformPreview(null);
}

function directionalWaveBlockSize(sampleLength: number): number {
  let blockSize = DIRECTIONAL_WAVE_BLOCK_SIZE;
  while (Math.ceil(Math.max(0, sampleLength) / blockSize) > MAX_DIRECTIONAL_WAVE_BLOCKS) {
    blockSize *= 4;
  }
  return blockSize;
}

function appendDirectionalWaveSource(
  startSample: number,
  channels: readonly Float32Array<ArrayBuffer>[],
): void {
  const worker = directionalWaveWorker;
  if (!worker || channels.length < 4) return;
  const buffers = channels.slice(0, 4).map((channel) => channel.buffer);
  const append: DirectionalWaveInput = {
    type: 'append',
    startSample,
    channels: buffers,
  };
  worker.postMessage(append, buffers);
}

function completeDirectionalWaveSource(startSample: number): void {
  const complete: DirectionalWaveInput = {
    type: 'append',
    startSample,
    channels: [],
    complete: true,
  };
  directionalWaveWorker?.postMessage(complete);
}

async function preprocessDecodedDirectionalSource(buffer: AudioBuffer, loadId: number): Promise<void> {
  const worker = directionalWaveWorker;
  if (!worker || buffer.numberOfChannels !== 4) return;
  const chunkFrames = 262_144;
  for (let start = 0; start < buffer.length; start += chunkFrames) {
    if (loadId !== fileLoadId || directionalWaveWorker !== worker) return;
    const end = Math.min(buffer.length, start + chunkFrames);
    const channels = Array.from(
      { length: 4 },
      (_, channel) => buffer.getChannelData(channel).slice(start, end),
    );
    appendDirectionalWaveSource(start, channels);
    await yieldToMainThread();
  }
  if (loadId !== fileLoadId || directionalWaveWorker !== worker) return;
  completeDirectionalWaveSource(buffer.length);
}

function isDirectionalDisplaySelected(): boolean {
  return monoMixMode === 'directional' && sourceChannelCount === 4 && Boolean(fourChannelMixSource);
}

function directionalDisplayOwnsWaveform(): boolean {
  return isDirectionalDisplaySelected() && directionalWaveWorker !== null;
}

function directionalDisplayOwnsSpectrogram(): boolean {
  return isDirectionalDisplaySelected() && directionalSpectralWorker !== null;
}

function directionalDisplayOwnsVisuals(): boolean {
  return directionalDisplayOwnsWaveform() || directionalDisplayOwnsSpectrogram();
}

function updateDirectionalDisplayMode(): void {
  if (!isDirectionalDisplaySelected()) {
    window.clearTimeout(directionalViewportTimer);
    directionalViewportTimer = 0;
    directionalDisplayQueued = false;
    visualizer.setWaveformPreview(null);
    return;
  }
  hideAnalysisOverlay();
  directionalViewVersion += 1;
  scheduleDirectionalViewportPreparation(0, true);
  scheduleDirectionalDisplayUpdate();
}

function scheduleDirectionalViewportPreparation(delay = 0, force = false): void {
  if (!isDirectionalDisplaySelected() || (!directionalWaveWorker && !directionalSpectralWorker)) return;
  if (force || delay <= 0) {
    if (force) directionalSpectralViewport = null;
    window.clearTimeout(directionalViewportTimer);
    directionalViewportTimer = 0;
    prepareDirectionalViewport();
    return;
  }
  if (directionalViewportTimer) return;
  directionalViewportTimer = window.setTimeout(() => {
    directionalViewportTimer = 0;
    prepareDirectionalViewport();
  }, delay);
}

function prepareDirectionalViewport(): void {
  if (!isDirectionalDisplaySelected()) return;
  const buffer = engine.buffer;
  if (!buffer || buffer.numberOfChannels !== 4 || audioDuration <= 0) return;

  prepareDirectionalWaveViewport(buffer);
  prepareDirectionalSpectralViewport(buffer);
  scheduleDirectionalDisplayUpdate();
}

function prepareDirectionalSpectralViewportOnly(force = false): void {
  if (!isDirectionalDisplaySelected() || !directionalSpectralWorker) return;
  const buffer = engine.buffer;
  if (!buffer || buffer.numberOfChannels !== 4 || audioDuration <= 0) return;
  if (force) directionalSpectralViewport = null;
  prepareDirectionalSpectralViewport(buffer);
}

function prepareDirectionalWaveViewport(buffer: AudioBuffer): void {
  const worker = directionalWaveWorker;
  if (!worker) return;
  const startSample = Math.max(0, Math.floor(analysisViewStart * buffer.sampleRate));
  const requestedEnd = Math.min(
    buffer.length,
    Math.ceil((analysisViewStart + analysisViewDuration) * buffer.sampleRate),
  );
  const availableEnd = isReadingFile ? Math.min(buffer.length, availableAudioSamples) : buffer.length;
  const canUseRaw = requestedEnd > startSample && requestedEnd <= availableEnd &&
    requestedEnd - startSample <= MAX_RAW_DIRECTIONAL_WAVE_SAMPLES;
  if (!canUseRaw) {
    const clear: DirectionalWaveInput = {
      type: 'clear-raw-view',
      viewVersion: directionalViewVersion,
    };
    worker.postMessage(clear);
    return;
  }

  const channels = Array.from(
    { length: 4 },
    (_, channel) => buffer.getChannelData(channel).slice(startSample, requestedEnd),
  );
  const buffers = channels.map((channel) => channel.buffer);
  const raw: DirectionalWaveInput = {
    type: 'raw-view',
    viewVersion: directionalViewVersion,
    startSample,
    channels: buffers,
  };
  worker.postMessage(raw, buffers);
}

function prepareDirectionalSpectralViewport(buffer: AudioBuffer): void {
  const worker = directionalSpectralWorker;
  if (!worker) return;
  const fftSize = fftBins[Number(fftSlider.value)] * 2;
  const mode: AnalysisMode = analysisModeSelect.value === 'cqt' ? 'cqt' : 'fft';
  const rows = mode === 'cqt'
    ? cqtBandCount(buffer.sampleRate, fftSize)
    : Math.min(fftSize / 2, MAX_DIRECTIONAL_FFT_ROWS, visualizer.analysisRowCount);
  const segmentSize = mode === 'cqt' ? cqtSegmentSize(fftSize) : fftSize;
  const visibleStart = Math.max(0, analysisViewStart);
  const maximumEnd = isReadingFile
    ? Math.min(
      audioDuration,
      availableSpectrogramEndTime(availableAudioSamples, buffer.sampleRate, segmentSize),
    )
    : audioDuration;
  const visibleEnd = Math.min(
    maximumEnd,
    visibleStart + Math.max(0.001, analysisViewDuration),
  );
  if (visibleEnd <= visibleStart) return;

  const existingViewport = directionalSpectralViewport;
  const sameSourceView = Boolean(
    existingViewport && existingViewport.fftSize === fftSize && existingViewport.rows === rows &&
    existingViewport.mode === mode &&
    Math.abs(existingViewport.sourceViewStart - analysisViewStart) < 1e-6 &&
    Math.abs(existingViewport.sourceViewDuration - analysisViewDuration) < 1e-6,
  );
  const spectralWorkInProgress = Boolean(
    directionalSpectralPendingTier ||
    directionalSpectralTier < directionalSpectralTierTargets.length,
  );
  if (isReadingFile && sameSourceView && spectralWorkInProgress) {
    // Sequential WAV chunks expand the available right edge very quickly.
    // Let the current sparse tier reach the screen before replanning that
    // larger extent; otherwise every chunk cancels the same four transforms.
    directionalStreamingRefreshPending = true;
    return;
  }
  if (
    engine.isPlaying && existingViewport && existingViewport.fftSize === fftSize &&
    existingViewport.rows === rows && existingViewport.mode === mode
  ) {
    const desiredAhead = Math.min(
      Math.max(0, maximumEnd - visibleEnd),
      analysisViewDuration * 0.5,
    );
    const tolerance = Math.max(0.001, analysisViewDuration * 0.01);
    if (
      existingViewport.startTime <= visibleStart + tolerance &&
      existingViewport.startTime + existingViewport.duration >= visibleEnd + desiredAhead - tolerance
    ) return;
  }

  const viewStart = visibleStart;
  let viewEnd = visibleEnd;
  if (engine.isPlaying) {
    viewEnd = Math.min(maximumEnd, visibleEnd + analysisViewDuration * 1.25);
  }

  // Match the physical canvas density. During a sequential load the covered
  // time range is only a fraction of the full viewport, so request the same
  // fraction of its pixels; this keeps every tick on the final global grid.
  const targetColumns = Math.max(1, Math.round(
    visualizer.analysisColumnCount *
    ((viewEnd - viewStart) / Math.max(0.001, analysisViewDuration)),
  ));
  const generation = ++directionalSpectralGeneration;
  directionalSpectralTier = 0;
  directionalSpectralTierTargets = directionalSpectralTargetsForViewport(
    viewStart,
    viewEnd - viewStart,
    targetColumns,
    fftSize,
    mode,
    rows,
  );
  directionalSpectralPendingTier = null;
  directionalStreamingRefreshPending = false;
  directionalSpectralViewport = {
    generation,
    startTime: viewStart,
    duration: viewEnd - viewStart,
    segmentSize,
    fftSize,
    rows,
    mode,
    sourceViewStart: analysisViewStart,
    sourceViewDuration: analysisViewDuration,
  };
  monoMixStatus.value = 'Refining viewport…';
  const configure: DirectionalSpectralInput = {
    type: 'configure',
    generation,
    sampleRate: buffer.sampleRate,
    duration: audioDuration,
    fftSize,
    mode,
    rows,
  };
  worker.postMessage(configure);
  prepareNextDirectionalSpectralTier(
    buffer,
    viewStart,
    viewEnd - viewStart,
    segmentSize,
    rows,
    generation,
  );
}

function directionalSpectralTargetsForViewport(
  viewStart: number,
  viewDuration: number,
  targetColumns: number,
  fftSize: number,
  mode: AnalysisMode,
  rows: number,
): number[] {
  const candidates = progressiveRemixColumnCounts(targetColumns);
  const visible = latestSpectrogram;
  const compatibleVisibleCache = Boolean(
    visible && visible.mode === mode && visible.fftSize === fftSize &&
    visible.sampleRate === audioSampleRate && visible.secondsPerColumn > 0 &&
    visible.endTime >= viewStart - visible.secondsPerColumn &&
    visible.startTime <= viewStart + viewDuration + visible.secondsPerColumn,
  );
  const visibleStep = compatibleVisibleCache ? visible!.secondsPerColumn : Number.POSITIVE_INFINITY;
  const targets: number[] = [];
  let previousStep = Number.POSITIVE_INFINITY;

  for (const columns of candidates) {
    const step = analysisTargetStep(
      viewStart,
      viewDuration,
      columns,
      fftSize,
      mode,
      0.00025,
      rows,
    );
    // A new generation must never replace the visible map with a coarser
    // one. This is what made streaming loads and pans appear to rebuild from
    // scratch even though their FFT frames were already in the worker LRU.
    if (step >= visibleStep * (1 - 1e-6)) continue;
    // Several nominal column targets can select the same power-of-two time
    // level. Request that shared grid once instead of repainting it twice.
    if (step >= previousStep * (1 - 1e-6)) continue;
    targets.push(columns);
    previousStep = step;
  }

  // Equal-resolution pans and streaming extensions still need a request so
  // the worker can assemble cached overlap plus only the missing edge ticks.
  return targets.length > 0 ? targets : [candidates.at(-1) ?? targetColumns];
}

function prepareNextDirectionalSpectralTier(
  buffer: AudioBuffer,
  viewStart: number,
  viewDuration: number,
  segmentSize: number,
  rows: number,
  generation: number,
): void {
  const worker = directionalSpectralWorker;
  if (
    !worker || generation !== directionalSpectralGeneration ||
    directionalSpectralTier >= directionalSpectralTierTargets.length
  ) return;
  const tier = directionalSpectralTier;
  const columns = directionalSpectralTierTargets[tier];
  const fftSize = fftBins[Number(fftSlider.value)] * 2;
  const mode: AnalysisMode = analysisModeSelect.value === 'cqt' ? 'cqt' : 'fft';
  const stepSeconds = analysisTargetStep(
    viewStart,
    viewDuration,
    columns,
    fftSize,
    mode,
    0.00025,
    rows,
  );
  const maximumTick = isReadingFile
    ? availableSpectrogramEndTime(availableAudioSamples, buffer.sampleRate, segmentSize) * 1000
    : Number.POSITIVE_INFINITY;
  const targetTicks = createAlignedSpectrogramTicks(viewStart, viewDuration, stepSeconds * 1000)
    .filter((tick) => tick <= maximumTick + 1e-6);
  if (targetTicks.length === 0) return;
  directionalSpectralPendingTier = {
    generation,
    tier,
    segmentSize,
    targetTicks,
    missingTicks: null,
    cursor: 0,
    batch: 0,
    buffer,
  };
  const plan: DirectionalSpectralInput = {
    type: 'plan',
    generation,
    tier,
    targetTicks,
  };
  worker.postMessage(plan);
}

function sendNextDirectionalSpectralBatch(): void {
  const pending = directionalSpectralPendingTier;
  const worker = directionalSpectralWorker;
  if (
    !pending || !worker || !pending.missingTicks ||
    pending.generation !== directionalSpectralGeneration ||
    pending.tier !== directionalSpectralTier
  ) return;
  const maximumFrames = Math.max(
    1,
    Math.floor(MAX_DIRECTIONAL_SPECTRAL_BATCH_VALUES / (4 * pending.segmentSize)),
  );
  const end = Math.min(pending.missingTicks.length, pending.cursor + maximumFrames);
  const ticks = pending.missingTicks.slice(pending.cursor, end);
  if (ticks.length === 0) return;
  const batch = pending.batch;
  pending.batch += 1;
  pending.cursor = end;
  const availableEnd = isReadingFile
    ? Math.min(pending.buffer.length, availableAudioSamples)
    : pending.buffer.length;
  const samples = packDirectionalSpectralFrames(
    pending.buffer,
    ticks,
    pending.segmentSize,
    availableEnd,
  );
  const frames: DirectionalSpectralInput = {
    type: 'frames',
    generation: pending.generation,
    tier: pending.tier,
    batch,
    completeTier: end >= pending.missingTicks.length,
    segmentSize: pending.segmentSize,
    ticks,
    samples: samples.buffer,
  };
  worker.postMessage(frames, [frames.samples]);
}

function packDirectionalSpectralFrames(
  buffer: AudioBuffer,
  ticks: readonly number[],
  segmentSize: number,
  availableEnd: number,
): Float32Array<ArrayBuffer> {
  const packed = new Float32Array(ticks.length * 4 * segmentSize);
  for (let frame = 0; frame < ticks.length; frame += 1) {
    const center = Math.round((ticks[frame] / 1000) * buffer.sampleRate);
    const windowStart = center - Math.floor(segmentSize / 2);
    const sourceStart = Math.max(0, windowStart);
    const sourceEnd = Math.min(buffer.length, availableEnd, windowStart + segmentSize);
    if (sourceEnd <= sourceStart) continue;
    const destinationInset = sourceStart - windowStart;
    for (let channel = 0; channel < 4; channel += 1) {
      const destination = (frame * 4 + channel) * segmentSize + destinationInset;
      packed.set(buffer.getChannelData(channel).subarray(sourceStart, sourceEnd), destination);
    }
  }
  return packed;
}

function scheduleDirectionalDisplayUpdate(): void {
  if (!isDirectionalDisplaySelected()) return;
  if (directionalDisplayQueued) return;
  directionalDisplayQueued = true;
  queueMicrotask(() => {
    directionalDisplayQueued = false;
    publishDirectionalDisplayUpdate();
  });
}

function publishDirectionalDisplayUpdate(): void {
  const weights = currentFourChannelWeights();
  if (!weights || !isDirectionalDisplaySelected()) return;
  const waveformPreview = createImmediateDirectionalWaveform(weights);
  if (waveformPreview) visualizer.setWaveformPreview(waveformPreview);
  const waveWorker = directionalWaveWorker;
  if (waveWorker && directionalWaveReady) {
    const query: DirectionalWaveInput = {
      type: 'query',
      id: ++directionalWaveRequestId,
      viewVersion: directionalViewVersion,
      startTime: analysisViewStart,
      duration: analysisViewDuration,
      pixels: visualizer.analysisColumnCount,
      weights: [...weights],
    };
    waveWorker.postMessage(query);
  }
  publishDirectionalSpectralDisplayUpdate(weights);
}

function publishDirectionalSpectralDisplayUpdate(weights: FourChannelWeights): void {
  directionalCompositionQueuedWeights = [...weights] as FourChannelWeights;
  pumpDirectionalComposition();
}

function pumpDirectionalComposition(): void {
  const weights = directionalCompositionQueuedWeights;
  if (!weights || directionalCompositionActiveId) return;
  directionalCompositionQueuedWeights = null;
  const id = ++directionalSpectralDirectionId;
  directionalCompositionActiveId = id;
  directionalSpectralDirectionStartedAt = performance.now();
  requestDirectionalComposition(weights, id);
  const spectralWorker = directionalSpectralWorker;
  const requestSpectralWorker = Boolean(
    spectralWorker && (directionalCompositionActiveWorkers === 0 || navigator.gpu),
  );
  // Race the parallel CPU pool with the existing WebGPU path. Avoid running
  // the spectral worker's serial CPU fallback at the same time as the pool.
  if (spectralWorker && requestSpectralWorker) {
    const direction: DirectionalSpectralInput = {
      type: 'direction',
      id,
      generation: directionalSpectralGeneration,
      weights: [...weights],
    };
    spectralWorker.postMessage(direction);
  }
  if (!directionalCompositionPending && !requestSpectralWorker) {
    directionalCompositionActiveId = 0;
  }
}

function installDirectionalCompositionBasis(
  cache: NonNullable<typeof directionalSpectralDisplayCache>,
  basisBuffer: ArrayBuffer,
): void {
  const workers = directionalCompositionWorkers;
  const activeWorkers = Math.min(workers.length, cache.ticks.length);
  directionalCompositionActiveWorkers = activeWorkers;
  directionalCompositionActiveId = 0;
  directionalCompositionQueuedWeights = null;
  directionalCompositionPending = null;
  if (activeWorkers === 0) return;
  const basis = new Float32Array(basisBuffer);
  const valuesPerColumn = cache.rows * cache.binsPerCell * 8;

  for (let part = 0; part < activeWorkers; part += 1) {
    const startColumn = Math.floor(part * cache.ticks.length / activeWorkers);
    const endColumn = Math.floor((part + 1) * cache.ticks.length / activeWorkers);
    const partBasis = basis.slice(
      startColumn * valuesPerColumn,
      endColumn * valuesPerColumn,
    );
    const configure: DirectionalCompositionConfigure = {
      type: 'configure',
      generation: cache.generation,
      part,
      startColumn,
      columns: endColumn - startColumn,
      rows: cache.rows,
      binsPerCell: cache.binsPerCell,
      fftSize: cache.fftSize,
      mode: cache.mode,
      basis: partBasis.buffer,
    };
    workers[part].postMessage(configure, [configure.basis]);
  }
}

function requestDirectionalComposition(weights: FourChannelWeights, id: number): void {
  const cache = directionalSpectralDisplayCache;
  const activeWorkers = directionalCompositionActiveWorkers;
  if (!cache || activeWorkers === 0) return;
  directionalCompositionPending = {
    id,
    generation: cache.generation,
    values: new Int16Array(cache.ticks.length * cache.rows),
    received: new Uint8Array(activeWorkers),
  };
  const direction: DirectionalCompositionDirection = {
    type: 'direction',
    id,
    generation: cache.generation,
    weights: [...weights],
  };
  for (let part = 0; part < activeWorkers; part += 1) {
    directionalCompositionWorkers[part].postMessage(direction);
  }
}

function handleDirectionalCompositionResult(message: DirectionalCompositionResult): void {
  const pending = directionalCompositionPending;
  const cache = directionalSpectralDisplayCache;
  if (
    !pending || !cache || message.id !== pending.id || message.id !== directionalCompositionActiveId ||
    message.generation !== pending.generation || message.generation !== cache.generation ||
    message.part >= pending.received.length || pending.received[message.part]
  ) return;
  pending.values.set(new Int16Array(message.values), message.startColumn * cache.rows);
  pending.received[message.part] = 1;
  for (const received of pending.received) {
    if (!received) return;
  }
  directionalCompositionPending = null;
  finishDirectionalComposition(
    message.id,
    directionalSpectrogramFromValues(cache, pending.values),
    cache.generation === directionalSpectralGeneration ? 'parallel CPU' : 'cached CPU',
  );
}

function finishDirectionalComposition(id: number, data: SpectrogramData, backend: string): void {
  if (id !== directionalCompositionActiveId || id <= directionalSpectralRenderedDirectionId) return;
  directionalSpectralRenderedDirectionId = id;
  directionalCompositionActiveId = 0;
  directionalCompositionPending = null;
  spectralCanvas.dataset.directionComposeMs = (
    performance.now() - directionalSpectralDirectionStartedAt
  ).toFixed(2);
  publishDirectionalSpectrogram(data, backend);
  pumpDirectionalComposition();
}

function createImmediateDirectionalWaveform(
  weights: FourChannelWeights,
): {
  minimum: Float32Array<ArrayBuffer>;
  maximum: Float32Array<ArrayBuffer>;
  startTime: number;
  duration: number;
  exact: boolean;
} | null {
  const buffer = engine.buffer;
  if (!buffer || buffer.numberOfChannels !== 4) return null;
  const startTime = Math.max(0, analysisViewStart);
  const duration = Math.max(0.001, Math.min(audioDuration - startTime, analysisViewDuration));
  const startSample = Math.max(0, Math.floor(startTime * buffer.sampleRate));
  const endSample = Math.min(buffer.length, Math.ceil((startTime + duration) * buffer.sampleRate));
  const availableEnd = isReadingFile ? Math.min(buffer.length, availableAudioSamples) : buffer.length;
  if (endSample <= startSample || endSample > availableEnd) return null;
  const pixels = Math.max(1, visualizer.analysisColumnCount);
  const minimum = new Float32Array(pixels);
  const maximum = new Float32Array(pixels);
  const channels = Array.from({ length: 4 }, (_, channel) => buffer.getChannelData(channel));
  let exact = true;

  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const from = Math.max(startSample, Math.floor(startSample + pixel * (endSample - startSample) / pixels));
    const to = Math.min(endSample, Math.max(from + 1, Math.ceil(startSample + (pixel + 1) * (endSample - startSample) / pixels)));
    const count = Math.max(1, to - from);
    const stride = Math.max(1, Math.ceil(count / 64));
    const approximate = stride > 1;
    if (approximate) exact = false;
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    let squared = 0;
    let sampled = 0;
    for (let sample = from + Math.floor((stride - 1) / 2); sample < to; sample += stride) {
      const value = channels[0][sample] * weights[0] + channels[1][sample] * weights[1] +
        channels[2][sample] * weights[2] + channels[3][sample] * weights[3];
      low = Math.min(low, value);
      high = Math.max(high, value);
      squared += value * value;
      sampled += 1;
    }
    if (!sampled) continue;
    if (approximate) {
      const rmsEnvelope = Math.sqrt(squared / sampled) * Math.SQRT2;
      low = Math.min(low, -rmsEnvelope);
      high = Math.max(high, rmsEnvelope);
    }
    minimum[pixel] = Number.isFinite(low) ? low : 0;
    maximum[pixel] = Number.isFinite(high) ? high : 0;
  }
  return { minimum, maximum, startTime, duration, exact };
}

function directionalSpectrogramFromValues(
  cache: NonNullable<typeof directionalSpectralDisplayCache>,
  values: Int16Array<ArrayBuffer>,
): SpectrogramData {
  const columns = cache.ticks.length;
  const rows = cache.rows;
  const secondsPerColumn = columns > 1
    ? (cache.ticks[columns - 1] - cache.ticks[0]) / 1000 / (columns - 1)
    : Math.max(0.001, cache.duration);
  return {
    values,
    columns,
    rows,
    fftSize: cache.fftSize,
    sampleRate: cache.sampleRate,
    duration: cache.duration,
    startTime: cache.ticks[0] / 1000,
    endTime: cache.ticks[columns - 1] / 1000,
    secondsPerColumn,
    mode: cache.mode,
    cqtFmin: cache.mode === 'cqt' ? CQT_FMIN : undefined,
    cqtBinsPerOctave: cache.mode === 'cqt' ? cqtBinsPerOctave(cache.fftSize) : undefined,
  };
}

function publishDirectionalSpectrogram(data: SpectrogramData, backend: string): void {
  latestSpectrogram = data;
  latestSpectrogramComplete = directionalSpectralTier >= directionalSpectralTierTargets.length;
  visualizer.setSpectrogram(data);
  spectralCanvas.dataset.directionBackend = backend;
  spectralCanvas.dataset.directionColumns = String(data.columns);
  updateDownloadState();
  if (latestSpectrogramComplete) monoMixStatus.value = `Viewport ready · ${backend}`;
}

function handleDirectionalWaveMessage(message: DirectionalWaveMessage): void {
  if (message.type === 'wave-ready') {
    directionalWaveReady = true;
    scheduleDirectionalDisplayUpdate();
    return;
  }
  if (
    !directionalDisplayOwnsWaveform() || message.id !== directionalWaveRequestId ||
    message.viewVersion !== directionalViewVersion
  ) return;
  visualizer.setWaveformPreview({
    minimum: new Float32Array(message.minimum),
    maximum: new Float32Array(message.maximum),
    startTime: message.startTime,
    duration: message.duration,
    exact: message.exact,
  });
}

function handleDirectionalSpectralMessage(message: DirectionalSpectralMessage): void {
  if (message.generation !== directionalSpectralGeneration) return;
  if (message.type === 'error') {
    directionalSpectralPendingTier = null;
    console.warn(`Directional spectral cache: ${message.message}`);
    return;
  }
  if (message.type === 'missing') {
    const pending = directionalSpectralPendingTier;
    if (!pending || message.tier !== pending.tier) return;
    pending.missingTicks = message.ticks;
    pending.cursor = 0;
    pending.batch = 0;
    sendNextDirectionalSpectralBatch();
    return;
  }
  if (message.type === 'batch-complete') {
    const pending = directionalSpectralPendingTier;
    if (
      !pending || message.tier !== pending.tier ||
      message.batch !== pending.batch - 1
    ) return;
    sendNextDirectionalSpectralBatch();
    return;
  }
  if (message.type === 'prepared') {
    if (message.tier !== directionalSpectralTier) return;
    directionalSpectralPendingTier = null;
    spectralCanvas.dataset.directionalGeneration = String(message.generation);
    spectralCanvas.dataset.directionalTier = String(message.tier);
    spectralCanvas.dataset.computedFrames = String(message.computedFrames);
    spectralCanvas.dataset.reusedFrames = String(message.reusedFrames);
    spectralCanvas.dataset.generationComputedFrames = String(message.generationComputedFrames);
    spectralCanvas.dataset.generationReusedFrames = String(message.generationReusedFrames);
    spectralCanvas.dataset.cachedFrames = String(message.cachedFrames);
    const fftSize = fftBins[Number(fftSlider.value)] * 2;
    const mode: AnalysisMode = analysisModeSelect.value === 'cqt' ? 'cqt' : 'fft';
    const displayCache: NonNullable<typeof directionalSpectralDisplayCache> = {
      generation: message.generation,
      ticks: message.ticks,
      binsPerCell: message.previewBinsPerCell,
      rows: message.rows,
      fftSize,
      sampleRate: audioSampleRate,
      duration: audioDuration,
      mode,
    };
    directionalSpectralDisplayCache = displayCache;
    installDirectionalCompositionBasis(displayCache, message.basis);
    directionalSpectralTier += 1;
    const weights = currentFourChannelWeights();
    if (weights) publishDirectionalSpectralDisplayUpdate(weights);
    const generation = message.generation;
    const buffer = engine.buffer;
    const viewport = directionalSpectralViewport;
    const refreshStreamingViewport = isReadingFile && directionalStreamingRefreshPending;
    directionalStreamingRefreshPending = false;
    window.requestAnimationFrame(() => {
      if (!buffer || !viewport || viewport.generation !== generation) return;
      if (refreshStreamingViewport) {
        // More of a sequentially decoded file became available while this
        // tier was running. Preserve the tier we just painted, then extend
        // the viewport. configure() keeps matching cached timeline frames.
        directionalSpectralViewport = null;
        prepareDirectionalSpectralViewport(buffer);
        return;
      }
      prepareNextDirectionalSpectralTier(
        buffer,
        viewport.startTime,
        viewport.duration,
        viewport.segmentSize,
        viewport.rows,
        generation,
      );
    });
    return;
  }
  if (
    !directionalDisplayOwnsSpectrogram() || message.id !== directionalCompositionActiveId ||
    message.id <= directionalSpectralRenderedDirectionId
  ) return;
  const data: SpectrogramData = {
    ...message.data,
    values: new Int16Array(message.data.values),
  };
  finishDirectionalComposition(message.id, data, message.backend === 'webgpu' ? 'GPU' : 'CPU');
}

function currentFourChannelWeights(): FourChannelWeights | null {
  if (sourceChannelCount !== 4) return null;
  return fourChannelMixWeights({
    mode: monoMixMode,
    format: ambisonicInputFormat,
    azimuth: virtualMicAzimuth,
    elevation: virtualMicElevation,
  });
}

function applyFourChannelMixWeights(): FourChannelWeights | null {
  const weights = currentFourChannelWeights();
  engine.setChannelMix(weights);
  visualizer.setSpectrumChannelWeights(weights);
  return weights;
}

function installFourChannelSpectrumSource(buffer: AudioBuffer): void {
  if (sourceChannelCount !== 4 || buffer.numberOfChannels !== 4) {
    visualizer.setSpectrumChannelSource(null);
    return;
  }
  visualizer.setSpectrumChannelSource(buffer);
  visualizer.setSpectrumChannelWeights(currentFourChannelWeights());
}

function updateAmbisonicMixControls(): void {
  monoMixSelect.value = monoMixMode;
  ambisonicFormatSelect.value = ambisonicInputFormat;
  ambisonicFormatNote.hidden = ambisonicInputFormat !== 'a-format';
  virtualMicControls.hidden = monoMixMode !== 'directional';
  if (sourceChannelCount === 4 && fourChannelMixSource) {
    visualizer.setWaveformLabel(
      monoMixMode === 'sum' ? 'SUM 4' : monoMixMode === 'first' ? 'CH 1' : 'VMIC',
    );
  }
  const horizontal = ((virtualMicAzimuth + 180) / 360) * 100;
  const vertical = ((90 - virtualMicElevation) / 180) * 100;
  virtualMicDot.style.left = `${horizontal}%`;
  virtualMicDot.style.top = `${vertical}%`;
  const azimuth = Math.round(virtualMicAzimuth);
  const elevation = Math.round(virtualMicElevation);
  virtualMicDirectionOutput.value = `${formatSignedAngle(azimuth)} az · ${formatSignedAngle(elevation)} el`;
  virtualMicPad.setAttribute('aria-valuenow', azimuth.toString());
  virtualMicPad.setAttribute(
    'aria-valuetext',
    `${azimuth} degrees azimuth, ${elevation} degrees elevation`,
  );
}

function setVirtualMicDirectionFromPointer(event: PointerEvent, rebuildBackground = true): void {
  const rect = virtualMicPad.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
  const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
  setVirtualMicDirection(x * 360 - 180, 90 - y * 180, rebuildBackground);
}

function setVirtualMicDirection(
  azimuth: number,
  elevation: number,
  rebuildBackground = true,
): void {
  virtualMicAzimuth = Math.max(-180, Math.min(180, Number.isFinite(azimuth) ? azimuth : 0));
  virtualMicElevation = clampElevation(elevation);
  updateAmbisonicMixControls();
  applyFourChannelMixWeights();
  scheduleDirectionalDisplayUpdate();
  scheduleSettingsSave();
  if (rebuildBackground) scheduleAmbisonicRemix();
}

function formatSignedAngle(value: number): string {
  if (value > 0) return `+${value}°`;
  if (value < 0) return `−${Math.abs(value)}°`;
  return '0°';
}

function scheduleAmbisonicRemix(immediate = false): void {
  if (!fourChannelMixSource || sourceChannelCount !== 4 || !monoSamples) return;
  // Pointer events can arrive faster than paint. Coalesce them to roughly one
  // remix per frame without adding the perceptible 90 ms steering lag that
  // the original background-oriented scheduler used.
  const interval = 16;
  const remaining = interval - (performance.now() - lastAmbisonicRemixAt);
  if (immediate || remaining <= 0) {
    window.clearTimeout(ambisonicRemixTimer);
    ambisonicRemixTimer = 0;
    startAmbisonicRemix();
    return;
  }
  if (ambisonicRemixTimer) return;
  ambisonicRemixTimer = window.setTimeout(() => {
    ambisonicRemixTimer = 0;
    startAmbisonicRemix();
  }, remaining);
}

function startAmbisonicRemix(): void {
  const weights = currentFourChannelWeights();
  if (!weights || !monoSamples || !fourChannelMixSource) return;
  lastAmbisonicRemixAt = performance.now();
  const id = ++ambisonicRemixId;
  decodedBufferRemixId = id;
  ambisonicRemixActive = true;
  remixTierColumns.clear();
  clearRemixAnalysisQueue();
  const displayOwnsViewport = directionalDisplayOwnsVisuals();
  monoMixStatus.value = displayOwnsViewport ? 'Updating audio in background…' : 'Updating viewport…';

  // Keep the previous waveform and spectral pixels on screen. The mono array
  // is updated in place and its peak pyramid is refreshed range-by-range, so
  // untouched regions remain a useful stale image instead of flashing black.
  hideAnalysisOverlay();
  if (!displayOwnsViewport) restartStreamingAnalysisWorker(monoSamples.length, audioSampleRate);
  let priorityTiers = displayOwnsViewport ? [] : createRemixPriorityTiers();
  const sourceBuffer = engine.buffer;
  const previewTier = priorityTiers[0];
  if (
    previewTier &&
    sourceBuffer?.numberOfChannels === 4 &&
    (fourChannelMixSource === 'buffer' || previewTier.ranges.every(
      (range) => range.endSample <= availableAudioSamples,
    ))
  ) {
    // AudioBuffer already contains the decoded source channels. Mixing only
    // the handful of first-tier analysis windows here avoids a file read and
    // lets the waveform change on the next paint while the warm analysis
    // worker builds the four-column spectral preview.
    publishDecodedBufferTier(sourceBuffer, weights, previewTier);
    priorityTiers = priorityTiers.slice(1);
    handleAmbisonicRemixMessage({ type: 'tier-complete', id, token: previewTier.token });
  }

  if (fourChannelMixSource === 'wav' && sourceFile && sourceWavHeader) {
    const worker = ensureAmbisonicRemixWorker();
    const chunkFrames = Math.max(
      1,
      Math.floor(preferredWavChunkBytes(sourceWavHeader) / sourceWavHeader.blockAlign),
    );
    const request: AmbisonicRemixInput = {
      type: 'start',
      id,
      file: sourceFile,
      header: sourceWavHeader,
      weights: [...weights],
      chunkFrames,
      priorityTiers,
    };
    worker.postMessage(request);
    return;
  }

  const buffer = engine.buffer;
  if (fourChannelMixSource === 'buffer' && buffer?.numberOfChannels === 4) {
    void remixDecodedBuffer(buffer, weights, id, priorityTiers);
    return;
  }

  ambisonicRemixActive = false;
}

function ensureAmbisonicRemixWorker(): Worker {
  if (ambisonicRemixWorker) return ambisonicRemixWorker;
  const worker = new Worker(new URL('./ambisonic-remix.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<AmbisonicRemixMessage>) => {
    if (ambisonicRemixWorker === worker) handleAmbisonicRemixMessage(event.data);
  };
  worker.onerror = () => {
    if (ambisonicRemixWorker !== worker) return;
    ambisonicRemixWorker = null;
    ambisonicRemixActive = false;
    worker.terminate();
    monoMixStatus.value = 'Remix failed';
    showToast('The four-channel remix worker stopped unexpectedly.');
  };
  ambisonicRemixWorker = worker;
  return worker;
}

function handleAmbisonicRemixMessage(message: AmbisonicRemixMessage): void {
  if (message.id !== ambisonicRemixId) return;
  if (message.type === 'chunk') {
    publishRemixedSamples(message.startSample, new Float32Array(message.samples));
    return;
  }
  if (message.type === 'tier-complete') {
    const columns = remixTierColumns.get(message.token);
    remixTierColumns.delete(message.token);
    if (columns === undefined) return;
    monoMixStatus.value = columns < visualizer.analysisColumnCount
      ? 'Refining viewport…'
      : 'Viewport ready';
    queueRemixSpectrogramAnalysis(columns);
    return;
  }
  if (message.type === 'progress') {
    const percent = Math.round(Math.max(0, Math.min(1, message.progress)) * 100);
    if (remixTierColumns.size === 0) monoMixStatus.value = `Background ${percent}%`;
    return;
  }
  if (message.type === 'complete') {
    finishAmbisonicRemix(message.id);
    return;
  }
  ambisonicRemixActive = false;
  monoMixStatus.value = 'Remix failed';
  showToast(`Could not update the mono mix: ${message.message}`);
}

function publishRemixedSamples(startSample: number, samples: Float32Array<ArrayBuffer>): void {
  if (!monoSamples || samples.length === 0) return;
  const start = Math.max(0, Math.min(monoSamples.length, Math.floor(startSample)));
  const count = Math.min(samples.length, monoSamples.length - start);
  if (count <= 0) return;
  const usable = count === samples.length ? samples : samples.subarray(0, count);
  monoSamples.set(usable, start);
  visualizer.updateProgressiveAudio(start, start + count);
  if (directionalDisplayOwnsVisuals()) return;
  const analysisSamples = usable.byteOffset === 0 && usable.byteLength === usable.buffer.byteLength
    ? usable
    : usable.slice();
  const append: AnalysisAppend = {
    type: 'append',
    startSample: start,
    samples: analysisSamples.buffer,
    preserveCachedFrames: true,
  };
  analysisWorker?.postMessage(append, [append.samples]);
}

function finishAmbisonicRemix(id: number): void {
  if (id !== ambisonicRemixId) return;
  ambisonicRemixActive = false;
  if (!directionalDisplayOwnsVisuals()) {
    const complete: AnalysisAppend = {
      type: 'append',
      startSample: monoSamples?.length ?? 0,
      samples: new ArrayBuffer(0),
      complete: true,
    };
    analysisWorker?.postMessage(complete, [complete.samples]);
  }
  monoMixStatus.value = remixAnalysisRequest || remixAnalysisQueue.length > 0
    ? 'Refining viewport…'
    : 'Ready';
}

function queueRemixSpectrogramAnalysis(columns: number): void {
  const target = Math.max(1, Math.floor(columns));
  if (
    remixAnalysisRequest?.columns === target ||
    remixAnalysisQueue.includes(target)
  ) return;
  remixAnalysisQueue.push(target);
  remixAnalysisQueue.sort((left, right) => left - right);
  pumpRemixSpectrogramAnalysis();
}

function pumpRemixSpectrogramAnalysis(): void {
  if (remixAnalysisRequest || remixAnalysisQueue.length === 0) return;
  const columns = remixAnalysisQueue.shift()!;
  const id = analyzeCurrentAudio({
    force: true,
    stableUpdate: true,
    columns,
    visibleOnly: true,
    suppressOverlay: true,
  });
  if (id === null) {
    pumpRemixSpectrogramAnalysis();
    return;
  }
  remixAnalysisRequest = { id, columns };
}

function finishRemixSpectrogramAnalysis(id: number): void {
  if (remixAnalysisRequest?.id !== id) return;
  const columns = remixAnalysisRequest.columns;
  remixAnalysisRequest = null;
  monoMixStatus.value = columns < visualizer.analysisColumnCount
    ? 'Refining viewport…'
    : 'Viewport ready';

  // setSpectrogram() has already queued its render. Registering this callback
  // afterwards guarantees the coarse map gets a paint before the next worker
  // request can replace it.
  window.cancelAnimationFrame(remixAnalysisFrame);
  remixAnalysisFrame = window.requestAnimationFrame(() => {
    remixAnalysisFrame = 0;
    pumpRemixSpectrogramAnalysis();
  });
}

function clearRemixAnalysisQueue(): void {
  remixAnalysisQueue = [];
  remixAnalysisRequest = null;
  window.cancelAnimationFrame(remixAnalysisFrame);
  remixAnalysisFrame = 0;
}

function createRemixPriorityTiers(): RemixPriorityTier[] {
  const fullColumns = visualizer.analysisColumnCount;
  return progressiveRemixColumnCounts(fullColumns).map((columns) => {
    const token = ++remixTierToken;
    remixTierColumns.set(token, columns);
    return { token, ranges: createRemixRanges(columns) };
  });
}

function createRemixRanges(columns: number): RemixSampleRange[] {
  const bins = fftBins[Number(fftSlider.value)];
  const fftSize = bins * 2;
  const mode: AnalysisMode = analysisModeSelect.value === 'cqt' ? 'cqt' : 'fft';
  const segmentSize = mode === 'cqt' ? cqtSegmentSize(fftSize) : fftSize;
  const startTime = Math.max(0, analysisViewStart);
  const duration = Math.max(0.001, Math.min(audioDuration - startTime, analysisViewDuration));
  const stepSeconds = analysisTargetStep(startTime, duration, columns, fftSize, mode);
  const ticks = createAlignedSpectrogramTicks(startTime, duration, stepSeconds * 1000);
  const ranges: RemixSampleRange[] = [];

  const halfWindow = segmentSize / 2;
  for (const tick of ticks) {
    const center = Math.round((tick / 1000) * audioSampleRate);
    ranges.push({
      startSample: Math.max(0, Math.floor(center - halfWindow)),
      endSample: Math.min(monoSamples?.length ?? 0, Math.ceil(center + halfWindow)),
    });
  }
  return ranges.filter((range) => range.endSample > range.startSample);
}

function scheduleAmbisonicViewportPriority(): void {
  if (
    directionalDisplayOwnsVisuals() || !ambisonicRemixActive ||
    fourChannelMixSource !== 'wav' || !ambisonicRemixWorker
  ) return;
  window.clearTimeout(ambisonicPriorityTimer);
  ambisonicPriorityTimer = window.setTimeout(() => {
    ambisonicPriorityTimer = 0;
    if (!ambisonicRemixActive || !ambisonicRemixWorker) return;
    const priorityTiers = createRemixPriorityTiers();
    const request: AmbisonicRemixInput = {
      type: 'prioritize',
      id: ambisonicRemixId,
      priorityTiers,
    };
    ambisonicRemixWorker.postMessage(request);
  }, 45);
}

async function remixDecodedBuffer(
  buffer: AudioBuffer,
  weights: FourChannelWeights,
  id: number,
  tiers: RemixPriorityTier[],
): Promise<void> {
  const chunkFrames = Math.max(4096, Math.floor((2 * 1024 * 1024) / (4 * Float32Array.BYTES_PER_ELEMENT)));
  const totalChunks = Math.ceil(buffer.length / chunkFrames);

  for (const tier of tiers) {
    const ranges = prepareRemixRanges(tier.ranges, buffer.length, chunkFrames);
    for (const range of ranges) {
      if (id !== decodedBufferRemixId) return;
      publishDecodedBufferRange(buffer, weights, range.startSample, range.endSample);
      await yieldToMainThread();
    }
    if (id !== decodedBufferRemixId) return;
    handleAmbisonicRemixMessage({ type: 'tier-complete', id, token: tier.token });
  }

  for (let chunk = 0; chunk < totalChunks; chunk += 1) {
    if (id !== decodedBufferRemixId) return;
    publishDecodedBufferChunk(buffer, weights, chunk, chunkFrames);
    if (chunk % 4 === 0) {
      handleAmbisonicRemixMessage({ type: 'progress', id, progress: chunk / Math.max(1, totalChunks) });
      await yieldToMainThread();
    }
  }
  if (id === decodedBufferRemixId) finishAmbisonicRemix(id);
}

function publishDecodedBufferChunk(
  buffer: AudioBuffer,
  weights: FourChannelWeights,
  chunk: number,
  chunkFrames: number,
): void {
  const start = chunk * chunkFrames;
  const end = Math.min(buffer.length, start + chunkFrames);
  publishDecodedBufferRange(buffer, weights, start, end);
}

function publishDecodedBufferTier(
  buffer: AudioBuffer,
  weights: FourChannelWeights,
  tier: RemixPriorityTier,
): void {
  const maximumRangeLength = Math.max(
    4096,
    Math.floor((2 * 1024 * 1024) / (4 * Float32Array.BYTES_PER_ELEMENT)),
  );
  for (const range of prepareRemixRanges(tier.ranges, buffer.length, maximumRangeLength)) {
    publishDecodedBufferRange(buffer, weights, range.startSample, range.endSample);
  }
}

function publishDecodedBufferRange(
  buffer: AudioBuffer,
  weights: FourChannelWeights,
  start: number,
  end: number,
): void {
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel).subarray(start, end),
  );
  publishRemixedSamples(start, mixChannelData(channels, weights));
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function downmix(buffer: AudioBuffer, weights?: readonly number[]): Float32Array {
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel),
  );
  return mixChannelData(channels, weights);
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

async function downloadSelectionAudio(): Promise<void> {
  const currentSelection = selection;
  if (!currentSelection || currentSelection.end <= currentSelection.start) return;
  // Snapshot source metadata before the first await. An export can take long
  // enough for the user to begin loading another file in the meantime.
  const exportSourceFile = sourceFile;
  const exportSourceHeader = sourceWavHeader;
  const exportFormat = downloadFormat;
  const exportNormalize = normalizeOutput;

  selectionDownloadButton.disabled = true;
  try {
    const format = resolvedDownloadFormat(exportSourceFile, exportFormat);
    let output: Blob;
    if (format === 'wav' && !exportNormalize && exportSourceFile && exportSourceHeader) {
      // This preserves source PCM/float samples byte-for-byte, including the
      // original channel count, sample rate, and bit depth.
      output = await trimWavFile(
        exportSourceFile,
        exportSourceHeader,
        currentSelection.start,
        currentSelection.end,
      );
    } else {
      const buffer = await audioBufferForSelectionExport(currentSelection, exportSourceFile);
      output = format === 'mp3'
        ? await encodeAudioBufferToMp3(buffer, currentSelection.start, currentSelection.end, {
          normalizePeak: exportNormalize,
        })
        : encodeAudioBufferToWav(buffer, currentSelection.start, currentSelection.end, {
          sourceHeader: exportSourceHeader,
          normalizePeak: exportNormalize,
        });
    }

    const sourceName = exportSourceFile?.name || fileNameElement.textContent?.trim() || 'audio';
    const baseName = sourceName.replace(/\.[^.]+$/, '') || 'audio';
    triggerDownload(output, `${baseName}-trim.${format}`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not create the selected audio file.');
  } finally {
    updateSelectionDownloadState();
  }
}

function resolvedDownloadFormat(
  file: File | null,
  outputFormat: DownloadOutputFormat,
): Exclude<DownloadOutputFormat, 'auto'> {
  if (outputFormat !== 'auto') return outputFormat;
  return /\.mp3$/i.test(file?.name ?? '') ? 'mp3' : 'wav';
}

async function audioBufferForSelectionExport(
  currentSelection: SelectionRange,
  file: File | null,
): Promise<AudioBuffer> {
  const buffer = engine.buffer;
  if (buffer) {
    const decodedDuration = availableAudioSamples / Math.max(1, audioSampleRate);
    if (isReadingFile && currentSelection.end > decodedDuration + 1e-6) {
      throw new Error('Wait for the selected audio to finish loading before re-encoding it.');
    }
    return buffer;
  }

  // Progressive MP4 playback uses an HTML media element rather than an
  // AudioBuffer. Decode a temporary buffer only when an export needs it, so
  // Auto/WAV/MP3 downloads also work for that path and other media sources.
  if (!file) {
    throw new Error('The selected audio is not available for re-encoding yet.');
  }
  const decoded = await engine.decode(await file.arrayBuffer());
  if (currentSelection.end > decoded.duration + 1e-6) {
    throw new Error('The selected range is outside the decoded audio.');
  }
  return decoded;
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
  updateAmbisonicMixControls();
  updateFftControl();
  updateSpectrumFftControl();
  visualizer.setAnalysisMode(analysisModeSelect.value === 'cqt' ? 'cqt' : 'fft');
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
  setSettingsPaneOpen(settingsPaneOpen);
  updateDownloadState();
  updateSelectionDownloadState();
  updateDropOverlayState();
  requestAnimationFrame(applyPanelRatio);
  requestAnimationFrame(animationLoop);
}

initialize();
