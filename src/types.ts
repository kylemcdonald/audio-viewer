export type AnalysisMode = 'fft' | 'cqt';

export type SpectrogramData = {
  values: Int16Array;
  columns: number;
  rows: number;
  fftSize: number;
  sampleRate: number;
  duration: number;
  startTime: number;
  endTime: number;
  secondsPerColumn: number;
  /** Rows are linear FFT bins ('fft') or log-spaced constant-Q bands ('cqt'). */
  mode: AnalysisMode;
  /** CQT band grid (mode 'cqt'): f_k = cqtFmin * 2^(k / cqtBinsPerOctave). */
  cqtFmin?: number;
  cqtBinsPerOctave?: number;
};

export type AnalysisInitialize = {
  type: 'initialize';
  samples: ArrayBuffer;
  sampleRate: number;
};

export type AnalysisStreamInitialize = {
  type: 'initialize-stream';
  sampleLength: number;
  sampleRate: number;
};

export type AnalysisAppend = {
  type: 'append';
  startSample: number;
  samples: ArrayBuffer;
  /** The overlap contains the same source values and cannot stale cached frames. */
  preserveCachedFrames?: boolean;
  /** Finalizes unwritten stream gaps as silence and makes end-padded frames available. */
  complete?: boolean;
};

export type AnalysisCancel = {
  type: 'cancel';
  id: number;
};

export type AnalysisRequest = {
  type: 'analyze';
  id: number;
  fftSize: number;
  analysisMode: AnalysisMode;
  startTime: number;
  viewDuration: number;
  columns: number;
  minimumSecondsPerColumn: number;
  intermediateResults: boolean;
  prefetchFiner: boolean;
};

export type AnalysisBackend = {
  type: 'backend';
  id: number;
  backend: 'webgpu' | 'cpu';
};

export type AnalysisProgress = {
  type: 'progress';
  id: number;
  progress: number;
};

export type AnalysisPartial = {
  type: 'partial';
  id: number;
  level: number;
  complete: boolean;
  computedColumns: number;
  reusedColumns: number;
  data: Omit<SpectrogramData, 'values'> & {
    values: ArrayBuffer;
  };
};

export type AnalysisFailure = {
  type: 'error';
  id: number;
  message: string;
};

export type AnalysisUnavailable = {
  type: 'unavailable';
  id: number;
};

export type AnalysisInput =
  | AnalysisInitialize
  | AnalysisStreamInitialize
  | AnalysisAppend
  | AnalysisCancel
  | AnalysisRequest;
export type AnalysisMessage =
  | AnalysisBackend
  | AnalysisProgress
  | AnalysisPartial
  | AnalysisFailure
  | AnalysisUnavailable;
