import type { AnalysisMode, SpectrogramData } from './types';

export type DirectionalWaveInitialize = {
  type: 'initialize';
  sampleLength: number;
  sampleRate: number;
  blockSize: number;
};

export type DirectionalWaveAppend = {
  type: 'append';
  startSample: number;
  channels: ArrayBuffer[];
  complete?: boolean;
};

export type DirectionalWaveRawView = {
  type: 'raw-view';
  viewVersion: number;
  startSample: number;
  channels: ArrayBuffer[];
};

export type DirectionalWaveClearRawView = {
  type: 'clear-raw-view';
  viewVersion: number;
};

export type DirectionalWaveQuery = {
  type: 'query';
  id: number;
  viewVersion: number;
  startTime: number;
  duration: number;
  pixels: number;
  weights: number[];
};

export type DirectionalWaveInput =
  | DirectionalWaveInitialize
  | DirectionalWaveAppend
  | DirectionalWaveRawView
  | DirectionalWaveClearRawView
  | DirectionalWaveQuery;

export type DirectionalWaveResult = {
  type: 'waveform';
  id: number;
  viewVersion: number;
  startTime: number;
  duration: number;
  minimum: ArrayBuffer;
  maximum: ArrayBuffer;
  exact: boolean;
};

export type DirectionalWaveReady = {
  type: 'wave-ready';
};

export type DirectionalWaveMessage = DirectionalWaveResult | DirectionalWaveReady;

export type DirectionalSpectralConfigure = {
  type: 'configure';
  generation: number;
  sampleRate: number;
  duration: number;
  fftSize: number;
  mode: AnalysisMode;
  rows: number;
};

export type DirectionalSpectralFrames = {
  type: 'frames';
  generation: number;
  tier: number;
  batch: number;
  completeTier: boolean;
  segmentSize: number;
  ticks: number[];
  samples: ArrayBuffer;
};

export type DirectionalSpectralPlan = {
  type: 'plan';
  generation: number;
  tier: number;
  targetTicks: number[];
};

export type DirectionalSpectralDirection = {
  type: 'direction';
  id: number;
  generation: number;
  weights: number[];
};

export type DirectionalSpectralInput =
  | DirectionalSpectralConfigure
  | DirectionalSpectralPlan
  | DirectionalSpectralFrames
  | DirectionalSpectralDirection;

export type DirectionalSpectralMissing = {
  type: 'missing';
  generation: number;
  tier: number;
  ticks: number[];
};

export type DirectionalSpectralBatchComplete = {
  type: 'batch-complete';
  generation: number;
  tier: number;
  batch: number;
};

export type DirectionalSpectralPrepared = {
  type: 'prepared';
  generation: number;
  tier: number;
  ticks: number[];
  computedFrames: number;
  reusedFrames: number;
  generationComputedFrames: number;
  generationReusedFrames: number;
  cachedFrames: number;
  rows: number;
  bins: number;
  previewBinsPerCell: number;
  basis: ArrayBuffer;
};

export type DirectionalSpectralResult = {
  type: 'spectrogram';
  id: number;
  generation: number;
  backend: 'webgpu' | 'cpu';
  data: Omit<SpectrogramData, 'values'> & { values: ArrayBuffer };
};

export type DirectionalSpectralFailure = {
  type: 'error';
  generation: number;
  message: string;
};

export type DirectionalSpectralMessage =
  | DirectionalSpectralMissing
  | DirectionalSpectralBatchComplete
  | DirectionalSpectralPrepared
  | DirectionalSpectralResult
  | DirectionalSpectralFailure;
