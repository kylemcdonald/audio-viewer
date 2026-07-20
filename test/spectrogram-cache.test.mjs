import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCqtPlan, cqtBandCount } from '../src/cqt.ts';
import {
  alignedSpectrogramTickCount,
  availableSpectrogramEndTime,
  createAlignedSpectrogramTicks,
  decideSpectrogramCoverage,
  MAX_SPECTROGRAM_CACHE_VALUES,
  selectSpectrogramStepMs,
  spectrogramCacheFrameCapacity,
  spectrogramCoverageBounds,
} from '../src/spectrogram-cache.ts';

test('aligned ticks share columns across pans and zoom levels', () => {
  assert.deepEqual(createAlignedSpectrogramTicks(0.013, 0.021, 8), [8, 16, 24, 32, 40]);
  assert.deepEqual(createAlignedSpectrogramTicks(0.016, 0.008, 4), [16, 20, 24]);
});

test('the temporal level never exceeds the cache frame capacity', () => {
  const rows = 8192;
  const capacity = spectrogramCacheFrameCapacity(rows);
  assert.equal(capacity, Math.floor(MAX_SPECTROGRAM_CACHE_VALUES / rows));

  const stepMs = selectSpectrogramStepMs(12.345, 30, 18_000, 0.001, capacity);
  assert.ok(alignedSpectrogramTickCount(12.345, 30, stepMs) <= capacity);
  assert.ok(alignedSpectrogramTickCount(12.345, 30, stepMs / 2) > capacity);
});

test('capacity limiting preserves the existing power-of-two level when it fits', () => {
  const stepMs = selectSpectrogramStepMs(0, 10, 1000, 0.001, 100_000);
  assert.equal(stepMs, 8);
  assert.equal(alignedSpectrogramTickCount(0, 10, stepMs), 1251);
});

test('fractional-millisecond levels can reach display density at sub-second zoom', () => {
  const stepMs = selectSpectrogramStepMs(0, 0.8, 1200, 0.00025, 100_000);
  assert.equal(stepMs, 0.5);
  assert.ok(alignedSpectrogramTickCount(0, 0.8, stepMs) >= 1200);
});

test('partial maps never satisfy final cache coverage', () => {
  const coverage = {
    fftSize: 4096,
    mode: 'fft',
    startTime: 0,
    endTime: 10,
    secondsPerColumn: 0.008,
  };
  assert.equal(decideSpectrogramCoverage(coverage, false, null, coverage), 'request');
  assert.equal(decideSpectrogramCoverage(coverage, true, null, coverage), 'reuse-latest');
});

test('returning to a completed view cancels an unrelated active request', () => {
  const latest = {
    fftSize: 4096,
    mode: 'fft',
    startTime: 0,
    endTime: 10,
    secondsPerColumn: 0.008,
  };
  const active = { ...latest, startTime: 20, endTime: 30 };
  assert.equal(
    decideSpectrogramCoverage(latest, true, active, latest),
    'reuse-latest-and-cancel-active',
  );
  assert.equal(decideSpectrogramCoverage(null, false, active, active), 'await-active');
});

test('streaming and rendering bounds use the analysis window and cached extent', () => {
  assert.equal(availableSpectrogramEndTime(96_000, 48_000, 16_384), 1.8293333333333333);
  assert.equal(availableSpectrogramEndTime(96_000, 48_000, 131_072), 0.6346666666666667);
  assert.deepEqual(spectrogramCoverageBounds(1, 2, 0.01), [0.9949, 2.0051]);
});

test('the UI and worker derive the same CQT cache row count', () => {
  for (const fftSize of [512, 1024, 2048, 4096, 8192, 16_384]) {
    assert.equal(cqtBandCount(48_000, fftSize), buildCqtPlan(48_000, fftSize).nBands);
  }
});
