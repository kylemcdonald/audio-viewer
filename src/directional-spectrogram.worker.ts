/// <reference lib="webworker" />

import FFT from 'fft.js';
import { buildCqtPlan, type CqtPlan } from './cqt';
import type {
  DirectionalSpectralConfigure,
  DirectionalSpectralDirection,
  DirectionalSpectralFrames,
  DirectionalSpectralInput,
  DirectionalSpectralMessage,
  DirectionalSpectralPlan,
} from './directional-display.types';

const worker = self as unknown as DedicatedWorkerGlobalScope;
const CHANNELS = 4;
const COMPLEX_VALUES_PER_CELL = CHANNELS * 2;
const FLOOR_DB = -200;
const DB_QUANTIZATION = 10;
const WORKGROUP_SIZE = 256;
const PREVIEW_BINS_PER_FFT_CELL = 2;
const MAX_FRAME_CACHE_BYTES = 256 * 1024 * 1024;

let configuration: DirectionalSpectralConfigure | null = null;
let analysisKey = '';
let transform: FFT | null = null;
let cqtPlan: CqtPlan | null = null;
let windowValues = new Float64Array(0);
let sourceBins = 0;
let binsPerCell = 1;
let frameValues = 0;
let maximumCachedFrames = 1;
const frameCache = new Map<number, Float32Array>();
const yieldChannel = new MessageChannel();
const yieldResolvers: Array<() => void> = [];
yieldChannel.port1.onmessage = () => yieldResolvers.shift()?.();
let plannedGeneration = -1;
let plannedTier = -1;
let plannedTicks: number[] = [];
let plannedMissingFrames = 0;
let generationComputedFrames = 0;
let generationReusedFrames = 0;
let displayTicks: number[] = [];
let denseBasis: Float32Array | null = null;
let latestDirection: DirectionalSpectralDirection | null = null;
let composing = false;
let gpuPromise: Promise<GpuState> | null = null;
let gpuCache: GpuCache | null = null;

type GpuState = {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  layout: GPUBindGroupLayout;
};

type GpuCache = {
  generation: number;
  columns: number;
  rows: number;
  binsPerCell: number;
  mode: 0 | 1;
  input: GPUBuffer;
  state: GpuState;
};

worker.onmessage = (event: MessageEvent<DirectionalSpectralInput>) => {
  const message = event.data;
  if (message.type === 'configure') {
    configure(message);
    return;
  }
  if (message.type === 'plan') {
    planTier(message);
    return;
  }
  if (message.type === 'frames') {
    void processFrames(message);
    return;
  }
  if (!configuration || message.generation !== configuration.generation) return;
  latestDirection = message;
  void pumpComposition();
};

function configure(message: DirectionalSpectralConfigure): void {
  const nextCqtPlan = message.mode === 'cqt'
    ? buildCqtPlan(message.sampleRate, message.fftSize)
    : null;
  const segmentSize = nextCqtPlan?.L ?? message.fftSize;
  const nextSourceBins = nextCqtPlan?.nBands ?? segmentSize / 2;
  const nextBinsPerCell = message.mode === 'cqt' || message.rows >= nextSourceBins
    ? 1
    : Math.min(PREVIEW_BINS_PER_FFT_CELL, Math.ceil(nextSourceBins / message.rows));
  const nextKey = [
    message.mode,
    message.sampleRate,
    message.fftSize,
    message.rows,
    segmentSize,
    nextBinsPerCell,
  ].join(':');

  configuration = message;
  if (analysisKey !== nextKey) {
    analysisKey = nextKey;
    frameCache.clear();
    transform = new FFT(segmentSize);
    cqtPlan = nextCqtPlan;
    windowValues = new Float64Array(segmentSize);
    for (let index = 0; index < segmentSize; index += 1) {
      windowValues[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / Math.max(1, segmentSize - 1));
    }
  }
  sourceBins = nextSourceBins;
  binsPerCell = nextBinsPerCell;
  frameValues = message.rows * binsPerCell * COMPLEX_VALUES_PER_CELL;
  maximumCachedFrames = Math.max(
    1,
    Math.floor(MAX_FRAME_CACHE_BYTES / Math.max(4, frameValues * Float32Array.BYTES_PER_ELEMENT)),
  );
  trimFrameCache();
  plannedGeneration = -1;
  plannedTier = -1;
  plannedTicks = [];
  plannedMissingFrames = 0;
  generationComputedFrames = 0;
  generationReusedFrames = 0;
  displayTicks = [];
  denseBasis = null;
  latestDirection = null;
  const retired = gpuCache;
  gpuCache = null;
  if (retired) setTimeout(() => retired.input.destroy(), 1000);
}

function planTier(message: DirectionalSpectralPlan): void {
  if (!configuration || message.generation !== configuration.generation) return;
  plannedGeneration = message.generation;
  plannedTier = message.tier;
  plannedTicks = [...message.targetTicks];
  touchCachedFrames(plannedTicks);
  const missingTicks = plannedTicks.filter((tick) => !frameCache.has(tick));
  plannedMissingFrames = missingTicks.length;
  generationReusedFrames += Math.max(0, plannedTicks.length - missingTicks.length);
  if (missingTicks.length === 0) {
    publishPrepared(message.generation, message.tier);
    return;
  }
  const response: DirectionalSpectralMessage = {
    type: 'missing',
    generation: message.generation,
    tier: message.tier,
    ticks: missingTicks,
  };
  worker.postMessage(response);
}

async function processFrames(message: DirectionalSpectralFrames): Promise<void> {
  const config = configuration;
  const fft = transform;
  if (
    !config || !fft || message.generation !== config.generation ||
    message.generation !== plannedGeneration || message.tier !== plannedTier
  ) return;
  const packed = new Float32Array(message.samples);
  const segmentSize = message.segmentSize;
  const expected = message.ticks.length * CHANNELS * segmentSize;
  if (packed.length < expected) {
    postError(message.generation, 'Directional spectral frame buffer was incomplete.');
    return;
  }

  const input = new Float64Array(segmentSize);
  const spectrum = fft.createComplexArray();
  for (let frame = 0; frame < message.ticks.length; frame += 1) {
    if (
      configuration?.generation !== message.generation ||
      plannedTier !== message.tier
    ) return;
    const tick = message.ticks[frame];
    if (!frameCache.has(tick)) {
      const fullBasis = new Float32Array(sourceBins * COMPLEX_VALUES_PER_CELL);
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        const sourceOffset = (frame * CHANNELS + channel) * segmentSize;
        for (let sample = 0; sample < segmentSize; sample += 1) {
          input[sample] = packed[sourceOffset + sample] * windowValues[sample];
        }
        fft.realTransform(spectrum, input);
        if (cqtPlan) writeCqtChannelBasis(fullBasis, channel, spectrum, cqtPlan);
        else writeFftChannelBasis(fullBasis, channel, spectrum, sourceBins);
      }
      cacheFrame(tick, compactFrameBasis(fullBasis, config.rows));
      generationComputedFrames += 1;
    } else {
      touchCachedFrames([tick]);
    }
    await yieldToWorker();
  }

  if (configuration?.generation !== message.generation || plannedTier !== message.tier) return;
  if (message.completeTier) {
    publishPrepared(message.generation, message.tier);
    return;
  }
  const response: DirectionalSpectralMessage = {
    type: 'batch-complete',
    generation: message.generation,
    tier: message.tier,
    batch: message.batch,
  };
  worker.postMessage(response);
}

function writeFftChannelBasis(
  target: Float32Array,
  channel: number,
  spectrum: number[] | Float64Array,
  bins: number,
): void {
  for (let bin = 0; bin < bins; bin += 1) {
    const targetOffset = bin * COMPLEX_VALUES_PER_CELL + channel * 2;
    target[targetOffset] = spectrum[bin * 2];
    target[targetOffset + 1] = spectrum[bin * 2 + 1];
  }
}

function writeCqtChannelBasis(
  target: Float32Array,
  channel: number,
  spectrum: number[] | Float64Array,
  plan: CqtPlan,
): void {
  for (let band = 0; band < plan.nBands; band += 1) {
    const start = plan.bandMeta[band * 4];
    const support = plan.bandMeta[band * 4 + 1];
    const winOffset = plan.bandMeta[band * 4 + 2];
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < support; index += 1) {
      const bin = start + index;
      const weight = plan.winValues[winOffset + index] * (bin & 1 ? -1 : 1);
      real += spectrum[bin * 2] * weight;
      imaginary += spectrum[bin * 2 + 1] * weight;
    }
    const offset = band * COMPLEX_VALUES_PER_CELL + channel * 2;
    target[offset] = real;
    target[offset + 1] = imaginary;
  }
}

function compactFrameBasis(source: Float32Array, rows: number): Float32Array<ArrayBuffer> {
  if (binsPerCell === 1 && rows >= sourceBins) return source.slice();
  const compact = new Float32Array(frameValues);
  const strongestBins = new Uint32Array(binsPerCell);
  const strongestEnergy = new Float64Array(binsPerCell);
  for (let row = 0; row < rows; row += 1) {
    strongestBins.fill(0);
    strongestEnergy.fill(-1);
    const binStart = Math.floor(row * sourceBins / rows);
    const binEnd = Math.max(binStart + 1, Math.floor((row + 1) * sourceBins / rows));
    for (let bin = binStart; bin < binEnd; bin += 1) {
      const offset = bin * COMPLEX_VALUES_PER_CELL;
      let energy = 0;
      for (let value = 0; value < COMPLEX_VALUES_PER_CELL; value += 1) {
        energy += source[offset + value] * source[offset + value];
      }
      for (let candidate = 0; candidate < binsPerCell; candidate += 1) {
        if (energy <= strongestEnergy[candidate]) continue;
        for (let shift = binsPerCell - 1; shift > candidate; shift -= 1) {
          strongestEnergy[shift] = strongestEnergy[shift - 1];
          strongestBins[shift] = strongestBins[shift - 1];
        }
        strongestEnergy[candidate] = energy;
        strongestBins[candidate] = bin;
        break;
      }
    }
    const target = row * binsPerCell * COMPLEX_VALUES_PER_CELL;
    for (let candidate = 0; candidate < binsPerCell; candidate += 1) {
      const sourceOffset = strongestBins[candidate] * COMPLEX_VALUES_PER_CELL;
      compact.set(
        source.subarray(sourceOffset, sourceOffset + COMPLEX_VALUES_PER_CELL),
        target + candidate * COMPLEX_VALUES_PER_CELL,
      );
    }
  }
  return compact;
}

function cacheFrame(tick: number, frame: Float32Array): void {
  if (frameCache.has(tick)) frameCache.delete(tick);
  frameCache.set(tick, frame);
  trimFrameCache();
}

function trimFrameCache(): void {
  while (frameCache.size > maximumCachedFrames) {
    const oldest = frameCache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    frameCache.delete(oldest);
  }
}

function touchCachedFrames(ticks: readonly number[]): void {
  for (const tick of ticks) {
    const frame = frameCache.get(tick);
    if (!frame) continue;
    frameCache.delete(tick);
    frameCache.set(tick, frame);
  }
}

function publishPrepared(generation: number, tier: number): void {
  const config = configuration;
  if (
    !config || generation !== config.generation || generation !== plannedGeneration ||
    tier !== plannedTier || plannedTicks.length === 0
  ) return;
  displayTicks = [...plannedTicks];
  denseBasis = assembleDenseBasis(displayTicks);
  void installGpuCache(generation, denseBasis, displayTicks.length, config.rows, binsPerCell);
  const displayBasis = denseBasis.slice();
  const response: DirectionalSpectralMessage = {
    type: 'prepared',
    generation,
    tier,
    ticks: [...displayTicks],
    computedFrames: plannedMissingFrames,
    reusedFrames: Math.max(0, displayTicks.length - plannedMissingFrames),
    generationComputedFrames,
    generationReusedFrames,
    cachedFrames: frameCache.size,
    rows: config.rows,
    bins: sourceBins,
    previewBinsPerCell: binsPerCell,
    basis: displayBasis.buffer,
  };
  worker.postMessage(response, [displayBasis.buffer]);
  void pumpComposition();
}

function assembleDenseBasis(ticks: readonly number[]): Float32Array<ArrayBuffer> {
  const result = new Float32Array(ticks.length * frameValues);
  const cachedTicks = [...frameCache.keys()].sort((left, right) => left - right);
  for (let column = 0; column < ticks.length; column += 1) {
    const tick = ticks[column];
    const frame = frameCache.get(tick) ?? nearestCachedFrame(tick, cachedTicks);
    if (frame) result.set(frame, column * frameValues);
  }
  touchCachedFrames(ticks);
  return result;
}

function nearestCachedFrame(tick: number, ticks: readonly number[]): Float32Array | null {
  if (ticks.length === 0) return null;
  let low = 0;
  let high = ticks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ticks[middle] < tick) low = middle + 1;
    else high = middle;
  }
  const upper = Math.min(ticks.length - 1, low);
  const lower = Math.max(0, upper - 1);
  const selected = Math.abs(ticks[lower] - tick) <= Math.abs(ticks[upper] - tick)
    ? ticks[lower]
    : ticks[upper];
  return frameCache.get(selected) ?? null;
}

async function pumpComposition(): Promise<void> {
  if (composing) return;
  composing = true;
  try {
    while (latestDirection) {
      const direction = latestDirection;
      latestDirection = null;
      const result = gpuCache?.generation === direction.generation
        ? await composeWithGpu(direction, gpuCache)
        : composeWithCpu(direction);
      if (!result || configuration?.generation !== direction.generation) continue;
      const pendingDirection = latestDirection as DirectionalSpectralDirection | null;
      if (pendingDirection && pendingDirection.id > direction.id) continue;
      worker.postMessage(result, [result.data.values]);
    }
  } catch (error) {
    const generation = configuration?.generation ?? -1;
    gpuCache = null;
    postError(generation, error instanceof Error ? error.message : 'Directional composition failed.');
  } finally {
    composing = false;
    if (latestDirection) void pumpComposition();
  }
}

function composeWithCpu(direction: DirectionalSpectralDirection) {
  const config = configuration;
  const basis = denseBasis;
  if (!config || !basis || displayTicks.length === 0) return null;
  const columns = displayTicks.length;
  const weights = normalizeWeights(direction.weights);
  const rows = config.rows;
  const values = new Int16Array(columns * rows);
  const w0 = weights[0];
  const w1 = weights[1];
  const w2 = weights[2];
  const w3 = weights[3];
  const fftPowerScale = config.mode === 'cqt' ? 1 : (16 / (config.fftSize * config.fftSize));
  let basisOffset = 0;
  let outputOffset = 0;
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      let peakPower = 0;
      for (let bin = 0; bin < binsPerCell; bin += 1) {
        const real = basis[basisOffset] * w0 + basis[basisOffset + 2] * w1 +
          basis[basisOffset + 4] * w2 + basis[basisOffset + 6] * w3;
        const imaginary = basis[basisOffset + 1] * w0 + basis[basisOffset + 3] * w1 +
          basis[basisOffset + 5] * w2 + basis[basisOffset + 7] * w3;
        const power = (real * real + imaginary * imaginary) * fftPowerScale;
        if (power > peakPower) peakPower = power;
        basisOffset += COMPLEX_VALUES_PER_CELL;
      }
      values[outputOffset] = quantizeDb(10 * Math.log10(Math.max(peakPower, 1e-20)));
      outputOffset += 1;
    }
  }
  return createResult(direction, values, 'cpu');
}

async function installGpuCache(
  generation: number,
  basis: Float32Array,
  columns: number,
  rows: number,
  cellBins: number,
): Promise<void> {
  try {
    const state = await getGpuState();
    if (configuration?.generation !== generation || denseBasis !== basis) return;
    const input = createMappedBuffer(state.device, basis, GPUBufferUsage.STORAGE);
    const previous = gpuCache;
    gpuCache = {
      generation,
      columns,
      rows,
      binsPerCell: cellBins,
      mode: configuration.mode === 'cqt' ? 1 : 0,
      input,
      state,
    };
    if (previous) setTimeout(() => previous.input.destroy(), 1000);
    void pumpComposition();
  } catch {
    // CPU composition remains available when WebGPU is unavailable.
  }
}

async function getGpuState(): Promise<GpuState> {
  if (!navigator.gpu) throw new Error('WebGPU unavailable');
  if (!gpuPromise) {
    gpuPromise = (async () => {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('No WebGPU adapter');
      const device = await adapter.requestDevice();
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
      });
      const pipeline = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: {
          module: device.createShaderModule({ code: COMPOSE_SHADER }),
          entryPoint: 'main',
        },
      });
      void device.lost.then(() => {
        gpuPromise = null;
        gpuCache = null;
      });
      return { device, pipeline, layout };
    })();
  }
  return gpuPromise;
}

async function composeWithGpu(direction: DirectionalSpectralDirection, cache: GpuCache) {
  const config = configuration;
  if (!config || displayTicks.length === 0) return null;
  const { device, pipeline, layout } = cache.state;
  const outputCount = cache.columns * cache.rows;
  const output = device.createBuffer({
    size: outputCount * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: outputCount * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const parameters = createComposeParameters(direction.weights, cache, config.fftSize);
  const parameterBuffer = createMappedBuffer(device, parameters, GPUBufferUsage.UNIFORM);
  const group = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: cache.input } },
      { binding: 1, resource: { buffer: output } },
      { binding: 2, resource: { buffer: parameterBuffer } },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.ceil(outputCount / WORKGROUP_SIZE));
  pass.end();
  encoder.copyBufferToBuffer(output, 0, readback, 0, outputCount * 4);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const dbValues = new Float32Array(readback.getMappedRange());
  const values = new Int16Array(outputCount);
  for (let index = 0; index < outputCount; index += 1) values[index] = quantizeDb(dbValues[index]);
  readback.unmap();
  output.destroy();
  readback.destroy();
  parameterBuffer.destroy();
  return createResult(direction, values, 'webgpu');
}

function createResult(
  direction: DirectionalSpectralDirection,
  values: Int16Array<ArrayBuffer>,
  backend: 'webgpu' | 'cpu',
) {
  const config = configuration!;
  const secondsPerColumn = displayTicks.length > 1
    ? (displayTicks[displayTicks.length - 1] - displayTicks[0]) / 1000 / (displayTicks.length - 1)
    : Math.max(0.001, config.duration);
  return {
    type: 'spectrogram' as const,
    id: direction.id,
    generation: direction.generation,
    backend,
    data: {
      values: values.buffer,
      columns: displayTicks.length,
      rows: config.rows,
      fftSize: config.fftSize,
      sampleRate: config.sampleRate,
      duration: config.duration,
      startTime: displayTicks[0] / 1000,
      endTime: displayTicks[displayTicks.length - 1] / 1000,
      secondsPerColumn,
      mode: config.mode,
      cqtFmin: cqtPlan?.fMin,
      cqtBinsPerOctave: cqtPlan?.binsPerOctave,
    },
  };
}

function createComposeParameters(weights: readonly number[], cache: GpuCache, fftSize: number): Uint32Array {
  const buffer = new ArrayBuffer(48);
  const view = new DataView(buffer);
  for (let index = 0; index < CHANNELS; index += 1) view.setFloat32(index * 4, weights[index] ?? 0, true);
  view.setUint32(16, cache.columns, true);
  view.setUint32(20, cache.rows, true);
  view.setUint32(24, cache.binsPerCell, true);
  view.setUint32(28, fftSize, true);
  view.setUint32(32, cache.mode, true);
  return new Uint32Array(buffer);
}

function createMappedBuffer(
  device: GPUDevice,
  data: Float32Array | Uint32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = device.createBuffer({
    size: Math.max(4, Math.ceil(data.byteLength / 4) * 4),
    usage,
    mappedAtCreation: true,
  });
  if (data instanceof Float32Array) new Float32Array(buffer.getMappedRange()).set(data);
  else new Uint32Array(buffer.getMappedRange()).set(data);
  buffer.unmap();
  return buffer;
}

function quantizeDb(value: number): number {
  const safe = Number.isFinite(value) ? value : FLOOR_DB;
  return Math.round(Math.max(FLOOR_DB, Math.min(20, safe)) * DB_QUANTIZATION);
}

function normalizeWeights(weights: readonly number[]): readonly [number, number, number, number] {
  return [weights[0] ?? 0, weights[1] ?? 0, weights[2] ?? 0, weights[3] ?? 0];
}

function postError(generation: number, message: string): void {
  worker.postMessage({ type: 'error', generation, message } satisfies DirectionalSpectralMessage);
}

function yieldToWorker(): Promise<void> {
  return new Promise((resolve) => {
    yieldResolvers.push(resolve);
    yieldChannel.port2.postMessage(0);
  });
}

const COMPOSE_SHADER = /* wgsl */ `
struct Parameters {
  weights: vec4<f32>,
  columns: u32,
  rows: u32,
  bins_per_cell: u32,
  fft_size: u32,
  mode: u32,
  padding_0: u32,
  padding_1: u32,
  padding_2: u32,
}

@group(0) @binding(0) var<storage, read> basis: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  let total = parameters.columns * parameters.rows;
  if (index >= total) { return; }
  let cell = index * parameters.bins_per_cell;
  var peak_power = 0.0;
  for (var bin = 0u; bin < parameters.bins_per_cell; bin += 1u) {
    let base = (cell + bin) * 4u;
    let mixed = basis[base] * parameters.weights.x +
      basis[base + 1u] * parameters.weights.y +
      basis[base + 2u] * parameters.weights.z +
      basis[base + 3u] * parameters.weights.w;
    var power = dot(mixed, mixed);
    if (parameters.mode == 0u) {
      let scale = 4.0 / f32(parameters.fft_size);
      power *= scale * scale;
    }
    peak_power = max(peak_power, power);
  }
  output[index] = clamp(log2(max(peak_power, 0.00000000000000000001)) * 3.0102999566, -200.0, 20.0);
}
`;
