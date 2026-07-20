import type { AnalysisMode } from './types';

export type DirectionalCompositionConfigure = {
  type: 'configure';
  generation: number;
  part: number;
  startColumn: number;
  columns: number;
  rows: number;
  binsPerCell: number;
  fftSize: number;
  mode: AnalysisMode;
  basis: ArrayBuffer;
};

export type DirectionalCompositionDirection = {
  type: 'direction';
  id: number;
  generation: number;
  weights: number[];
};

export type DirectionalCompositionInput =
  | DirectionalCompositionConfigure
  | DirectionalCompositionDirection;

export type DirectionalCompositionResult = {
  type: 'result';
  id: number;
  generation: number;
  part: number;
  startColumn: number;
  columns: number;
  values: ArrayBuffer;
};
