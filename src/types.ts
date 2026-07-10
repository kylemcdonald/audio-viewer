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
};

export type AnalysisRequest = {
  type: 'analyze';
  id: number;
  fftSize: number;
  startTime: number;
  viewDuration: number;
  columns: number;
  minimumSecondsPerColumn: number;
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

export type AnalysisInput = AnalysisInitialize | AnalysisStreamInitialize | AnalysisAppend | AnalysisRequest;
export type AnalysisMessage = AnalysisBackend | AnalysisProgress | AnalysisPartial | AnalysisFailure;
