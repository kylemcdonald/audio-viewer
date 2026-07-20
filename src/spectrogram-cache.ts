export const MAX_SPECTROGRAM_CACHE_VALUES = 32_000_000;
export const MAX_FFT_SPECTROGRAM_ROWS = 8192;
export const MINIMUM_SPECTROGRAM_STEP_MS = 0.25;

export type SpectrogramCoverage = {
  fftSize: number;
  mode: string;
  startTime: number;
  endTime: number;
  secondsPerColumn: number;
};

export type SpectrogramCoverageRequirement = {
  fftSize: number;
  mode: string;
  startTime: number;
  endTime: number;
  secondsPerColumn: number;
};

export type SpectrogramCoverageDecision =
  | 'reuse-latest'
  | 'reuse-latest-and-cancel-active'
  | 'await-active'
  | 'request';

export function spectrogramCacheFrameCapacity(rows: number): number {
  const safeRows = Math.max(1, Math.floor(rows));
  return Math.max(1, Math.floor(MAX_SPECTROGRAM_CACHE_VALUES / safeRows));
}

export function alignedSpectrogramTickCount(
  startTime: number,
  viewDuration: number,
  stepMs: number,
): number {
  const safeStepMs = Math.max(MINIMUM_SPECTROGRAM_STEP_MS, stepMs);
  const firstTick = Math.floor(Math.max(0, startTime * 1000) / safeStepMs) * safeStepMs;
  const lastTick = Math.ceil(
    Math.max(0, (startTime + viewDuration) * 1000) / safeStepMs,
  ) * safeStepMs;
  return Math.max(1, Math.round((lastTick - firstTick) / safeStepMs) + 1);
}

export function createAlignedSpectrogramTicks(
  startTime: number,
  viewDuration: number,
  stepMs: number,
): number[] {
  const safeStepMs = Math.max(MINIMUM_SPECTROGRAM_STEP_MS, stepMs);
  const firstTick = Math.floor(Math.max(0, startTime * 1000) / safeStepMs) * safeStepMs;
  const count = alignedSpectrogramTickCount(startTime, viewDuration, safeStepMs);
  return Array.from({ length: count }, (_, index) => firstTick + index * safeStepMs);
}

/**
 * Selects the shared power-of-two timeline level for a viewport. The frame
 * capacity constraint is part of the level selection: allowing a target
 * level larger than the LRU means its early columns are evicted while the
 * same result is still being assembled, which turns them into repeated edge
 * columns and guarantees cache thrashing on the next request.
 */
export function selectSpectrogramStepMs(
  startTime: number,
  viewDuration: number,
  columns: number,
  minimumSecondsPerColumn: number,
  maximumFrames: number,
): number {
  const minimumStepMs = Math.max(
    MINIMUM_SPECTROGRAM_STEP_MS,
    minimumSecondsPerColumn * 1000,
  );
  const desiredStepMs = Math.max(
    minimumStepMs,
    (viewDuration * 1000) / Math.max(1, Math.round(columns)),
  );
  const exponent = Math.max(0, Math.floor(Math.log2(desiredStepMs / minimumStepMs)));
  let stepMs = minimumStepMs * 2 ** exponent;
  const frameCapacity = Math.max(2, Math.floor(maximumFrames));

  while (alignedSpectrogramTickCount(startTime, viewDuration, stepMs) > frameCapacity) {
    stepMs *= 2;
  }
  return stepMs;
}

export function spectrogramCoverageIncludes(
  coverage: SpectrogramCoverage | null,
  requirement: SpectrogramCoverageRequirement,
): boolean {
  if (
    !coverage ||
    coverage.fftSize !== requirement.fftSize ||
    coverage.mode !== requirement.mode
  ) return false;
  const tolerance = Math.max(0.001, coverage.secondsPerColumn * 1.1);
  return coverage.secondsPerColumn <= requirement.secondsPerColumn * 1.01 &&
    coverage.startTime <= requirement.startTime + tolerance &&
    coverage.endTime >= requirement.endTime - tolerance;
}

export function decideSpectrogramCoverage(
  latest: SpectrogramCoverage | null,
  latestComplete: boolean,
  active: SpectrogramCoverage | null,
  requirement: SpectrogramCoverageRequirement,
): SpectrogramCoverageDecision {
  const activeCovers = spectrogramCoverageIncludes(active, requirement);
  if (latestComplete && spectrogramCoverageIncludes(latest, requirement)) {
    return active && !activeCovers
      ? 'reuse-latest-and-cancel-active'
      : 'reuse-latest';
  }
  return activeCovers ? 'await-active' : 'request';
}

export function availableSpectrogramEndTime(
  availableSamples: number,
  sampleRate: number,
  segmentSize: number,
): number {
  return Math.max(0, (availableSamples - segmentSize / 2) / Math.max(1, sampleRate));
}

export function spectrogramCoverageBounds(
  startTime: number,
  endTime: number,
  secondsPerColumn: number,
): readonly [start: number, end: number] {
  const inset = secondsPerColumn * 0.51;
  return [startTime - inset, endTime + inset];
}
