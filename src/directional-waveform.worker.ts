/// <reference lib="webworker" />

import type {
  DirectionalWaveInput,
  DirectionalWaveMessage,
  DirectionalWaveQuery,
} from './directional-display.types';

const worker = self as unknown as DedicatedWorkerGlobalScope;
const CHANNELS = 4;
const COVARIANCE_TERMS = 10;
const SQRT_TWO = Math.SQRT2;

type CovarianceLevel = {
  blockSize: number;
  values: Float32Array;
  counts: Uint32Array;
};

let sampleLength = 0;
let sampleRate = 48_000;
let baseBlockSize = 64;
let baseSums = new Float32Array(0);
let baseCounts = new Uint32Array(0);
let levels: CovarianceLevel[] = [];
let complete = false;
let rawViewVersion = -1;
let rawViewStart = 0;
let rawViewChannels: Float32Array[] | null = null;
let latestQueryId = 0;

worker.onmessage = (event: MessageEvent<DirectionalWaveInput>) => {
  const message = event.data;
  if (message.type === 'initialize') {
    sampleLength = Math.max(0, Math.floor(message.sampleLength));
    sampleRate = Math.max(1, message.sampleRate);
    baseBlockSize = Math.max(1, Math.floor(message.blockSize));
    const blocks = Math.ceil(sampleLength / baseBlockSize);
    baseSums = new Float32Array(blocks * COVARIANCE_TERMS);
    baseCounts = new Uint32Array(blocks);
    levels = [];
    complete = sampleLength === 0;
    rawViewVersion = -1;
    rawViewStart = 0;
    rawViewChannels = null;
    latestQueryId = 0;
    return;
  }

  if (message.type === 'append') {
    appendSource(message.startSample, message.channels.map((buffer) => new Float32Array(buffer)));
    if (message.complete) finalizePyramid();
    return;
  }

  if (message.type === 'raw-view') {
    rawViewVersion = message.viewVersion;
    rawViewStart = Math.max(0, Math.floor(message.startSample));
    rawViewChannels = message.channels.map((buffer) => new Float32Array(buffer));
    return;
  }

  if (message.type === 'clear-raw-view') {
    if (message.viewVersion >= rawViewVersion) {
      rawViewVersion = message.viewVersion;
      rawViewStart = 0;
      rawViewChannels = null;
    }
    return;
  }

  latestQueryId = message.id;
  const result = queryWaveform(message);
  if (!result || message.id !== latestQueryId) return;
  const response: DirectionalWaveMessage = result;
  worker.postMessage(response, [result.minimum, result.maximum]);
};

function appendSource(startSample: number, channels: Float32Array[]): void {
  if (channels.length < CHANNELS || baseCounts.length === 0) return;
  const length = Math.min(...channels.slice(0, CHANNELS).map((channel) => channel.length));
  const start = Math.max(0, Math.floor(startSample));
  const end = Math.min(sampleLength, start + length);
  // Huge recordings use larger base blocks to keep the pyramid bounded. At
  // most 256 evenly spaced source frames per block are enough for a stable
  // RMS envelope, so preprocessing throughput is bounded as well as memory.
  const stride = Math.max(1, Math.ceil(baseBlockSize / 256));
  const first = start + ((stride - (start % stride)) % stride);
  for (let sample = first; sample < end; sample += stride) {
    const local = sample - start;
    const a = channels[0][local];
    const b = channels[1][local];
    const c = channels[2][local];
    const d = channels[3][local];
    const block = Math.floor(sample / baseBlockSize);
    const offset = block * COVARIANCE_TERMS;
    baseSums[offset] += a * a;
    baseSums[offset + 1] += a * b;
    baseSums[offset + 2] += a * c;
    baseSums[offset + 3] += a * d;
    baseSums[offset + 4] += b * b;
    baseSums[offset + 5] += b * c;
    baseSums[offset + 6] += b * d;
    baseSums[offset + 7] += c * c;
    baseSums[offset + 8] += c * d;
    baseSums[offset + 9] += d * d;
    baseCounts[block] += 1;
  }
}

function finalizePyramid(): void {
  if (complete) return;
  complete = true;
  const baseValues = new Float32Array(baseSums.length);
  for (let block = 0; block < baseCounts.length; block += 1) {
    const count = baseCounts[block];
    if (count === 0) continue;
    const offset = block * COVARIANCE_TERMS;
    for (let term = 0; term < COVARIANCE_TERMS; term += 1) {
      baseValues[offset + term] = baseSums[offset + term] / count;
    }
  }
  levels = [{ blockSize: baseBlockSize, values: baseValues, counts: baseCounts }];
  let previous = levels[0];
  while (previous.counts.length > 1) {
    const parentCount = Math.ceil(previous.counts.length / 4);
    const values = new Float32Array(parentCount * COVARIANCE_TERMS);
    const counts = new Uint32Array(parentCount);
    for (let parent = 0; parent < parentCount; parent += 1) {
      const first = parent * 4;
      const last = Math.min(previous.counts.length, first + 4);
      let count = 0;
      for (let child = first; child < last; child += 1) count += previous.counts[child];
      counts[parent] = count;
      if (count === 0) continue;
      const parentOffset = parent * COVARIANCE_TERMS;
      for (let child = first; child < last; child += 1) {
        const childCount = previous.counts[child];
        if (childCount === 0) continue;
        const childOffset = child * COVARIANCE_TERMS;
        const ratio = childCount / count;
        for (let term = 0; term < COVARIANCE_TERMS; term += 1) {
          values[parentOffset + term] += previous.values[childOffset + term] * ratio;
        }
      }
    }
    previous = { blockSize: previous.blockSize * 4, values, counts };
    levels.push(previous);
  }
  baseSums = new Float32Array(0);
  worker.postMessage({ type: 'wave-ready' } satisfies DirectionalWaveMessage);
}

function queryWaveform(message: DirectionalWaveQuery) {
  const pixels = Math.max(1, Math.floor(message.pixels));
  const minimum = new Float32Array(pixels);
  const maximum = new Float32Array(pixels);
  const startSample = Math.max(0, message.startTime * sampleRate);
  const viewSamples = Math.max(1, message.duration * sampleRate);
  const endSample = Math.min(sampleLength, startSample + viewSamples);
  const weights = normalizeWeights(message.weights);
  const raw = rawViewChannels;
  const rawLength = raw ? Math.min(...raw.map((channel) => channel.length)) : 0;
  const rawEnd = rawViewStart + rawLength;
  const useRaw = Boolean(
    raw && rawViewVersion === message.viewVersion &&
    rawViewStart <= Math.floor(startSample) && rawEnd >= Math.ceil(endSample),
  );

  if (useRaw && raw) {
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      const from = Math.max(Math.floor(startSample), Math.floor(startSample + pixel * viewSamples / pixels));
      const to = Math.min(Math.ceil(endSample), Math.max(from + 1, Math.ceil(startSample + (pixel + 1) * viewSamples / pixels)));
      let low = Number.POSITIVE_INFINITY;
      let high = Number.NEGATIVE_INFINITY;
      for (let sample = from; sample < to; sample += 1) {
        const local = sample - rawViewStart;
        const value = raw[0][local] * weights[0] + raw[1][local] * weights[1] +
          raw[2][local] * weights[2] + raw[3][local] * weights[3];
        if (value < low) low = value;
        if (value > high) high = value;
      }
      minimum[pixel] = Number.isFinite(low) ? low : 0;
      maximum[pixel] = Number.isFinite(high) ? high : 0;
    }
  } else if (complete && levels.length > 0) {
    const samplesPerPixel = viewSamples / pixels;
    let level = levels[0];
    for (const candidate of levels) {
      if (candidate.blockSize <= samplesPerPixel * 1.5) level = candidate;
      else break;
    }
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      const pixelStart = startSample + pixel * viewSamples / pixels;
      const pixelEnd = Math.min(endSample, startSample + (pixel + 1) * viewSamples / pixels);
      const firstBlock = Math.max(0, Math.floor(pixelStart / level.blockSize));
      const lastBlock = Math.min(level.counts.length - 1, Math.floor(Math.max(pixelStart, pixelEnd - 1) / level.blockSize));
      let count = 0;
      let power = 0;
      for (let block = firstBlock; block <= lastBlock; block += 1) {
        const blockCount = level.counts[block];
        if (!blockCount) continue;
        power += covariancePower(level.values, block * COVARIANCE_TERMS, weights) * blockCount;
        count += blockCount;
      }
      if (!count) continue;
      power /= count;
      const amplitude = Math.sqrt(Math.max(0, power)) * SQRT_TWO;
      minimum[pixel] = -amplitude;
      maximum[pixel] = amplitude;
    }
  } else {
    return null;
  }

  return {
    type: 'waveform' as const,
    id: message.id,
    viewVersion: message.viewVersion,
    startTime: message.startTime,
    duration: message.duration,
    minimum: minimum.buffer,
    maximum: maximum.buffer,
    exact: useRaw,
  };
}

function covariancePower(values: Float32Array, offset: number, weights: readonly number[]): number {
  const [a, b, c, d] = weights;
  return a * a * values[offset] +
    2 * a * b * values[offset + 1] +
    2 * a * c * values[offset + 2] +
    2 * a * d * values[offset + 3] +
    b * b * values[offset + 4] +
    2 * b * c * values[offset + 5] +
    2 * b * d * values[offset + 6] +
    c * c * values[offset + 7] +
    2 * c * d * values[offset + 8] +
    d * d * values[offset + 9];
}

function normalizeWeights(weights: readonly number[]): readonly [number, number, number, number] {
  return [weights[0] ?? 0, weights[1] ?? 0, weights[2] ?? 0, weights[3] ?? 0];
}
