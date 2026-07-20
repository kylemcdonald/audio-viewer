import type { RemixSampleRange } from './ambisonic-remix.types';

const PREVIEW_COLUMN_TARGETS = [4, 16, 64, 256, 512, 1024, 2048, 4096] as const;

/**
 * Starts with a deliberately tiny time grid, then subdivides it until the
 * canvas-resolution result is ready. This keeps steering feedback responsive
 * even when the visible range spans a very large file.
 */
export function progressiveRemixColumnCounts(fullColumns: number): number[] {
  const target = Math.max(1, Math.floor(fullColumns));
  return [
    ...PREVIEW_COLUMN_TARGETS.filter((columns) => columns < target),
    target,
  ];
}

/**
 * Normalizes, merges, and caps sample ranges. The cap prevents a dense tier
 * from becoming one enormous File.slice() that cannot be interrupted when
 * the virtual microphone moves again.
 */
export function prepareRemixRanges(
  ranges: readonly RemixSampleRange[],
  sampleLength: number,
  maximumRangeLength: number,
): RemixSampleRange[] {
  const limit = Math.max(0, Math.floor(sampleLength));
  const maximum = Math.max(1, Math.floor(maximumRangeLength));
  const normalized = ranges
    .map((range) => ({
      startSample: Math.max(0, Math.min(limit, Math.floor(range.startSample))),
      endSample: Math.max(0, Math.min(limit, Math.ceil(range.endSample))),
    }))
    .filter((range) => range.endSample > range.startSample)
    .sort((left, right) => left.startSample - right.startSample || left.endSample - right.endSample);

  const merged: RemixSampleRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.startSample <= previous.endSample) {
      previous.endSample = Math.max(previous.endSample, range.endSample);
    } else {
      merged.push({ ...range });
    }
  }

  const prepared: RemixSampleRange[] = [];
  for (const range of merged) {
    for (let start = range.startSample; start < range.endSample; start += maximum) {
      prepared.push({
        startSample: start,
        endSample: Math.min(range.endSample, start + maximum),
      });
    }
  }
  return prepared;
}
