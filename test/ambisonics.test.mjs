import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectAmbisonicInputFormat,
  directionVector,
  fourChannelMixWeights,
  inferAmbisonicInputFormat,
  mixChannelData,
} from '../src/ambisonics.ts';
import {
  prepareRemixRanges,
  progressiveRemixColumnCounts,
} from '../src/ambisonic-remix.ts';

const closeTo = (actual, expected, tolerance = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);

test('azimuth and elevation use front-left-up Ambisonic coordinates', () => {
  const front = directionVector(0, 0);
  const left = directionVector(90, 0);
  const up = directionVector(0, 90);
  closeTo(front[0], 1);
  closeTo(front[1], 0);
  closeTo(left[0], 0);
  closeTo(left[1], 1);
  closeTo(up[0], 0);
  closeTo(up[2], 1);
});

test('ordinary four-channel modes preserve the existing normalized sum and first channel', () => {
  const base = { format: 'ambix', azimuth: 0, elevation: 0 };
  assert.deepEqual(fourChannelMixWeights({ ...base, mode: 'sum' }), [0.25, 0.25, 0.25, 0.25]);
  assert.deepEqual(fourChannelMixWeights({ ...base, mode: 'first' }), [1, 0, 0, 0]);
});

test('AmbiX max-DI decoder is unity forward with a -0.5 rear lobe', () => {
  const weights = fourChannelMixWeights({
    mode: 'directional', format: 'ambix', azimuth: 0, elevation: 0,
  });
  closeTo(dot(weights, [1, 0, 0, 1]), 1);
  closeTo(dot(weights, [1, 0, 0, -1]), -0.5);
  closeTo(dot(weights, [1, 1, 0, 0]), 0.25);
});

test('FuMa and canonical tetrahedral A-format normalize to the same beam pattern', () => {
  const fuma = fourChannelMixWeights({
    mode: 'directional', format: 'fuma', azimuth: 0, elevation: 0,
  });
  closeTo(dot(fuma, [1 / Math.sqrt(2), 1, 0, 0]), 1);
  closeTo(dot(fuma, [1 / Math.sqrt(2), -1, 0, 0]), -0.5);

  const aFormat = fourChannelMixWeights({
    mode: 'directional', format: 'a-format', azimuth: 0, elevation: 0,
  });
  const vertices = [
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
  ].map((vertex) => vertex.map((value) => value / Math.sqrt(3)));
  const capsuleResponse = (direction) => vertices.map((vertex) => 0.5 * (1 + dot(vertex, direction)));
  closeTo(dot(aFormat, capsuleResponse([1, 0, 0])), 1);
  closeTo(dot(aFormat, capsuleResponse([-1, 0, 0])), -0.5);
});

test('track labels and conservative filename hints identify supported layouts', () => {
  assert.equal(detectAmbisonicInputFormat(['W', 'Y', 'Z', 'X']), 'ambix');
  assert.equal(detectAmbisonicInputFormat(['W', 'X', 'Y', 'Z']), 'fuma');
  assert.equal(detectAmbisonicInputFormat(['FLU', 'FRD', 'BLD', 'BRU']), 'a-format');
  assert.equal(detectAmbisonicInputFormat(['L', 'R', 'Ls', 'Rs']), null);
  assert.equal(inferAmbisonicInputFormat('forest_take_ambix.wav'), 'ambix');
  assert.equal(inferAmbisonicInputFormat('AMBEo room.wav'), 'a-format');
});

test('channel mixing accepts arbitrary signed beamforming gains', () => {
  const channels = [
    Float32Array.from([1, 2]),
    Float32Array.from([3, 4]),
    Float32Array.from([5, 6]),
    Float32Array.from([7, 8]),
  ];
  assert.deepEqual([...mixChannelData(channels, [1, -1, 0.5, 0])], [0.5, 1]);
});

test('direction changes start with four columns and refine geometrically', () => {
  assert.deepEqual(progressiveRemixColumnCounts(1200), [4, 16, 64, 256, 512, 1024, 1200]);
  assert.deepEqual(progressiveRemixColumnCounts(64), [4, 16, 64]);
  assert.deepEqual(progressiveRemixColumnCounts(3), [3]);
});

test('priority sample windows are merged, clamped, and kept interruptible', () => {
  assert.deepEqual(
    prepareRemixRanges([
      { startSample: 40, endSample: 90 },
      { startSample: -10, endSample: 20 },
      { startSample: 15, endSample: 45 },
      { startSample: 150, endSample: 250 },
    ], 200, 64),
    [
      { startSample: 0, endSample: 64 },
      { startSample: 64, endSample: 90 },
      { startSample: 150, endSample: 200 },
    ],
  );
});
