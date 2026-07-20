import type { WavHeader } from './wav-reader';

export type RemixSampleRange = {
  startSample: number;
  endSample: number;
};

export type RemixPriorityTier = {
  token: number;
  ranges: RemixSampleRange[];
};

export type AmbisonicRemixStart = {
  type: 'start';
  id: number;
  file: File;
  header: WavHeader;
  weights: number[];
  chunkFrames: number;
  priorityTiers: RemixPriorityTier[];
};

export type AmbisonicRemixPrioritize = {
  type: 'prioritize';
  id: number;
  priorityTiers: RemixPriorityTier[];
};

export type AmbisonicRemixCancel = {
  type: 'cancel';
  id: number;
};

export type AmbisonicRemixInput =
  | AmbisonicRemixStart
  | AmbisonicRemixPrioritize
  | AmbisonicRemixCancel;

export type AmbisonicRemixChunk = {
  type: 'chunk';
  id: number;
  startSample: number;
  samples: ArrayBuffer;
  priority: boolean;
};

export type AmbisonicRemixTierComplete = {
  type: 'tier-complete';
  id: number;
  token: number;
};

export type AmbisonicRemixProgress = {
  type: 'progress';
  id: number;
  progress: number;
};

export type AmbisonicRemixComplete = {
  type: 'complete';
  id: number;
};

export type AmbisonicRemixFailure = {
  type: 'error';
  id: number;
  message: string;
};

export type AmbisonicRemixMessage =
  | AmbisonicRemixChunk
  | AmbisonicRemixTierComplete
  | AmbisonicRemixProgress
  | AmbisonicRemixComplete
  | AmbisonicRemixFailure;
