/// <reference lib="webworker" />

import FFT from 'fft.js';
import type { AnalysisInput, AnalysisRequest } from './types';

const worker = self as unknown as DedicatedWorkerGlobalScope;
const WORKGROUP_SIZE = 256;
const MAX_COMPLEX_VALUES_PER_BATCH = 1_048_576;
const MAX_CACHE_VALUES = 32_000_000;
const DB_QUANTIZATION = 10;
const INITIAL_COLUMN_TARGET = 64;
const MINIMUM_TEMPORAL_STEP_MS = 1;

let audioSamples: Float32Array | null = null;
let audioSampleRate = 48000;
let audioAvailableSamples = 0;
let audioComplete = true;
let latestJobId = -1;
let gpuContextPromise: Promise<GpuContext> | null = null;
let cachedFftSize = 0;
let cachedRows = 0;
let maximumCachedFrames = 1;
const frameCache = new Map<number, Int16Array>();

type AnalysisLayout = {
  bins: number;
  rows: number;
};

type GpuContext = {
  device: GPUDevice;
  pipelines: GpuPipelines;
};

type AnalysisPlan = {
  targetStepMs: number;
  targetTicks: number[];
  stages: number[];
};

type FrameComputer = (
  ticks: readonly number[],
  report: (progress: number) => void,
) => Promise<boolean>;

worker.onmessage = (event: MessageEvent<AnalysisInput>) => {
  if (event.data.type === 'initialize') {
    latestJobId = -1;
    audioSamples = new Float32Array(event.data.samples);
    audioSampleRate = event.data.sampleRate;
    audioAvailableSamples = audioSamples.length;
    audioComplete = true;
    clearFrameCache();
    return;
  }
  if (event.data.type === 'initialize-stream') {
    latestJobId = -1;
    audioSamples = new Float32Array(event.data.sampleLength);
    audioSampleRate = event.data.sampleRate;
    audioAvailableSamples = 0;
    audioComplete = audioSamples.length === 0;
    clearFrameCache();
    return;
  }
  if (event.data.type === 'append') {
    if (!audioSamples) return;
    const incoming = new Float32Array(event.data.samples);
    const start = Math.max(0, Math.min(audioSamples.length, event.data.startSample));
    const count = Math.min(incoming.length, audioSamples.length - start);
    audioSamples.set(incoming.subarray(0, count), start);
    audioAvailableSamples = Math.max(audioAvailableSamples, start + count);
    audioComplete = audioAvailableSamples >= audioSamples.length;
    return;
  }
  latestJobId = event.data.id;
  void analyzeViewport(event.data);
};

async function analyzeViewport(request: AnalysisRequest): Promise<void> {
  if (!audioSamples) return;
  const layout: AnalysisLayout = {
    bins: request.fftSize / 2,
    rows: Math.min(request.fftSize / 2, 1024),
  };
  prepareFrameCache(request.fftSize, layout.rows);
  const plan = createAnalysisPlan(request);
  if (plan.targetTicks.length === 0) return;
  const fullyCached = plan.targetTicks.every((tick) => frameCache.has(tick));

  if (fullyCached) {
    postViewport(request, layout, plan, plan.targetStepMs, 0, true, 0, plan.targetTicks.length);
    await yieldToWorker();
    if (request.id !== latestJobId) return;
  }

  try {
    const gpu = await getGpuContext();
    if (request.id !== latestJobId) return;
    worker.postMessage({ type: 'backend', id: request.id, backend: 'webgpu' });
    await computeCachedViewport(
      request,
      layout,
      plan,
      fullyCached,
      (ticks, report) => analyzeFramesWithGpu(gpu, ticks, request.fftSize, layout, request.id, report),
    );
  } catch {
    if (request.id !== latestJobId) return;
    worker.postMessage({ type: 'backend', id: request.id, backend: 'cpu' });
    try {
      const cachedAfterGpu = plan.targetTicks.every((tick) => frameCache.has(tick));
      await computeCachedViewport(
        request,
        layout,
        plan,
        fullyCached || cachedAfterGpu,
        (ticks, report) => analyzeFramesWithCpu(ticks, request.fftSize, layout, request.id, report),
      );
    } catch (error) {
      if (request.id !== latestJobId) return;
      worker.postMessage({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : 'Unknown analysis error',
      });
    }
  }
}

function createAnalysisPlan(request: AnalysisRequest): AnalysisPlan {
  const minimumStepMs = Math.max(
    MINIMUM_TEMPORAL_STEP_MS,
    Math.round(request.minimumSecondsPerColumn * 1000),
  );
  const desiredStepMs = Math.max(
    minimumStepMs,
    (request.viewDuration * 1000) / Math.max(1, Math.round(request.columns)),
  );
  const exponent = Math.max(0, Math.floor(Math.log2(desiredStepMs / minimumStepMs)));
  const targetStepMs = minimumStepMs * 2 ** exponent;
  const targetTicks = createAlignedTicks(request.startTime, request.viewDuration, targetStepMs)
    .filter((tick) => isFrameAvailable(tick, request.fftSize));
  const stages: number[] = [];
  if (request.intermediateResults) {
    let initialStepMs = targetStepMs;
    while ((request.viewDuration * 1000) / initialStepMs + 1 > INITIAL_COLUMN_TARGET) {
      initialStepMs *= 2;
    }
    for (let step = initialStepMs; step >= targetStepMs; step /= 2) stages.push(step);
  } else {
    stages.push(targetStepMs);
  }
  return { targetStepMs, targetTicks, stages };
}

async function computeCachedViewport(
  request: AnalysisRequest,
  layout: AnalysisLayout,
  plan: AnalysisPlan,
  visibleResultAlreadySent: boolean,
  compute: FrameComputer,
): Promise<void> {
  if (!visibleResultAlreadySent) {
    let visibleResultSent = false;
    let finestReadyStepMs: number | null = null;
    for (let level = 0; level < plan.stages.length; level += 1) {
      if (request.id !== latestJobId) return;
      touchCachedFrames(plan.targetTicks);
      const stageStepMs = plan.stages[level];
      const stageTicks = createAlignedTicks(request.startTime, request.viewDuration, stageStepMs)
        .filter((tick) => isFrameAvailable(tick, request.fftSize));
      const missingTicks = stageTicks.filter((tick) => !frameCache.has(tick));
      const reusedColumns = countCachedFrames(plan.targetTicks);

      if (missingTicks.length === 0) {
        finestReadyStepMs = stageStepMs;
        continue;
      }

      if (!visibleResultSent && finestReadyStepMs !== null) {
        postViewport(
          request,
          layout,
          plan,
          finestReadyStepMs,
          level,
          false,
          0,
          reusedColumns,
        );
        visibleResultSent = true;
        await yieldToWorker();
        if (request.id !== latestJobId) return;
      }

      const completed = await compute(missingTicks, (progress) => {
        if (request.id === latestJobId) {
          worker.postMessage({ type: 'progress', id: request.id, progress });
        }
      });
      if (!completed || request.id !== latestJobId) return;

      postViewport(
        request,
        layout,
        plan,
        stageStepMs,
        level,
        stageStepMs === plan.targetStepMs,
        missingTicks.length,
        reusedColumns,
      );
      visibleResultSent = true;
      finestReadyStepMs = stageStepMs;
      await yieldToWorker();
    }
  }

  if (request.id !== latestJobId || !request.prefetchFiner) return;
  await prefetchFinerLevels(request, plan.targetStepMs, compute);
}

async function prefetchFinerLevels(
  request: AnalysisRequest,
  targetStepMs: number,
  compute: FrameComputer,
): Promise<void> {
  for (let stepMs = targetStepMs / 2; stepMs >= MINIMUM_TEMPORAL_STEP_MS; stepMs /= 2) {
    if (request.id !== latestJobId) return;
    const ticks = createAlignedTicks(request.startTime, request.viewDuration, stepMs)
      .filter((tick) => isFrameAvailable(tick, request.fftSize));
    if (ticks.length > maximumCachedFrames) return;
    touchCachedFrames(ticks);
    const missingTicks = ticks.filter((tick) => !frameCache.has(tick));
    if (missingTicks.length > 0) {
      const completed = await compute(missingTicks, () => undefined);
      if (!completed || request.id !== latestJobId) return;
    }
    await yieldToWorker();
  }
}

function postViewport(
  request: AnalysisRequest,
  layout: AnalysisLayout,
  plan: AnalysisPlan,
  availableStepMs: number,
  level: number,
  complete: boolean,
  computedColumns: number,
  reusedColumns: number,
): void {
  if (request.id !== latestJobId || plan.targetTicks.length === 0) return;
  const values = assembleViewport(plan.targetTicks, availableStepMs, layout.rows);
  const payload = {
    type: 'partial' as const,
    id: request.id,
    level,
    complete,
    computedColumns,
    reusedColumns,
    data: {
      values: values.buffer,
      columns: plan.targetTicks.length,
      rows: layout.rows,
      fftSize: request.fftSize,
      sampleRate: audioSampleRate,
      duration: (audioSamples?.length ?? 0) / audioSampleRate,
      startTime: plan.targetTicks[0] / 1000,
      endTime: plan.targetTicks[plan.targetTicks.length - 1] / 1000,
      secondsPerColumn: plan.targetStepMs / 1000,
    },
  };
  worker.postMessage(payload, [values.buffer]);
}

function assembleViewport(targetTicks: readonly number[], availableStepMs: number, rows: number): Int16Array {
  const values = new Int16Array(targetTicks.length * rows);
  for (let column = 0; column < targetTicks.length; column += 1) {
    const tick = targetTicks[column];
    let frame = frameCache.get(tick);
    if (!frame) {
      const nearest = Math.round(tick / availableStepMs) * availableStepMs;
      const lower = Math.floor(tick / availableStepMs) * availableStepMs;
      const upper = Math.ceil(tick / availableStepMs) * availableStepMs;
      frame = frameCache.get(nearest) ?? frameCache.get(lower) ?? frameCache.get(upper);
    }
    if (frame) values.set(frame, column * rows);
  }
  return values;
}

function createAlignedTicks(startTime: number, viewDuration: number, stepMs: number): number[] {
  const firstTick = Math.floor(Math.max(0, startTime * 1000) / stepMs) * stepMs;
  const lastTick = Math.ceil(Math.max(0, (startTime + viewDuration) * 1000) / stepMs) * stepMs;
  const count = Math.max(1, Math.round((lastTick - firstTick) / stepMs) + 1);
  return Array.from({ length: count }, (_, index) => firstTick + index * stepMs);
}

function isFrameAvailable(tick: number, fftSize: number): boolean {
  if (audioComplete) return true;
  const centerSample = Math.round((tick / 1000) * audioSampleRate);
  return centerSample + fftSize / 2 <= audioAvailableSamples;
}

function createFrameStarts(ticks: readonly number[], sampleRate: number, fftSize: number): Int32Array {
  const starts = new Int32Array(ticks.length);
  const halfWindow = fftSize / 2;
  for (let index = 0; index < ticks.length; index += 1) {
    starts[index] = Math.round((ticks[index] / 1000) * sampleRate - halfWindow);
  }
  return starts;
}

function prepareFrameCache(fftSize: number, rows: number): void {
  if (cachedFftSize !== fftSize || cachedRows !== rows) {
    clearFrameCache();
    cachedFftSize = fftSize;
    cachedRows = rows;
  }
  maximumCachedFrames = Math.max(1, Math.floor(MAX_CACHE_VALUES / rows));
}

function clearFrameCache(): void {
  frameCache.clear();
  cachedFftSize = 0;
  cachedRows = 0;
  maximumCachedFrames = 1;
}

function cacheFrame(tick: number, frame: Int16Array): void {
  if (frameCache.has(tick)) frameCache.delete(tick);
  frameCache.set(tick, frame);
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

function countCachedFrames(ticks: readonly number[]): number {
  let count = 0;
  for (const tick of ticks) if (frameCache.has(tick)) count += 1;
  return count;
}

async function getGpuContext(): Promise<GpuContext> {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable');
  if (!gpuContextPromise) {
    gpuContextPromise = (async () => {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('No WebGPU adapter is available');
      const device = await adapter.requestDevice();
      const pipelines = await createGpuPipelines(device);
      void device.lost.then(() => { gpuContextPromise = null; });
      return { device, pipelines };
    })();
  }
  return gpuContextPromise;
}

async function analyzeFramesWithGpu(
  gpu: GpuContext,
  ticks: readonly number[],
  fftSize: number,
  layout: AnalysisLayout,
  id: number,
  report: (progress: number) => void,
): Promise<boolean> {
  if (!audioSamples || ticks.length === 0) return true;
  const { device, pipelines } = gpu;
  const stageParameters = createStageParameterBuffers(device, fftSize);
  const maxBatchFrames = Math.max(1, Math.floor(MAX_COMPLEX_VALUES_PER_BATCH / fftSize));

  try {
    for (let frameStart = 0; frameStart < ticks.length; frameStart += maxBatchFrames) {
      if (id !== latestJobId) return false;
      const batchTicks = ticks.slice(frameStart, frameStart + maxBatchFrames);
      const globalStarts = createFrameStarts(batchTicks, audioSampleRate, fftSize);
      const frameCount = globalStarts.length;
      const chunkStart = Math.max(0, globalStarts[0]);
      const chunkEnd = Math.max(
        chunkStart,
        Math.min(audioSamples.length, globalStarts[globalStarts.length - 1] + fftSize),
      );
      const sampleChunk = audioSamples.slice(chunkStart, chunkEnd);
      const localStarts = new Int32Array(frameCount);
      for (let index = 0; index < frameCount; index += 1) {
        localStarts[index] = globalStarts[index] - chunkStart;
      }
      const batch = await runGpuBatch(
        device,
        pipelines,
        stageParameters,
        sampleChunk,
        localStarts,
        fftSize,
        layout,
      );
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        const frame = new Int16Array(layout.rows);
        const source = frameIndex * layout.rows;
        for (let row = 0; row < layout.rows; row += 1) {
          frame[row] = quantizeDb(batch[source + row]);
        }
        cacheFrame(batchTicks[frameIndex], frame);
      }
      if (id !== latestJobId) return false;
      report((frameStart + frameCount) / ticks.length);
    }
  } finally {
    for (const buffer of stageParameters) buffer.destroy();
  }
  return true;
}

async function analyzeFramesWithCpu(
  ticks: readonly number[],
  fftSize: number,
  layout: AnalysisLayout,
  id: number,
  report: (progress: number) => void,
): Promise<boolean> {
  if (!audioSamples || ticks.length === 0) return true;
  const input = new Float64Array(fftSize);
  const transform = new FFT(fftSize);
  const spectrum = transform.createComplexArray();
  const frameStarts = createFrameStarts(ticks, audioSampleRate, fftSize);
  const window = new Float64Array(fftSize);
  for (let index = 0; index < fftSize; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (fftSize - 1));
  }

  for (let column = 0; column < frameStarts.length; column += 1) {
    if (column % 24 === 0) {
      if (id !== latestJobId) return false;
      report(column / frameStarts.length);
      await yieldToWorker();
    }
    input.fill(0);
    const start = frameStarts[column];
    for (let index = 0; index < fftSize; index += 1) {
      const source = start + index;
      input[index] = (source >= 0 && source < audioSamples.length ? audioSamples[source] : 0) * window[index];
    }
    transform.realTransform(spectrum, input);
    const frame = new Int16Array(layout.rows);
    for (let row = 0; row < layout.rows; row += 1) {
      const binStart = Math.floor((row * layout.bins) / layout.rows);
      const binEnd = Math.max(binStart + 1, Math.floor(((row + 1) * layout.bins) / layout.rows));
      let peak = 0;
      for (let bin = binStart; bin < binEnd; bin += 1) {
        const real = spectrum[bin * 2];
        const imaginary = spectrum[bin * 2 + 1];
        peak = Math.max(peak, Math.sqrt(real * real + imaginary * imaginary) * (4 / fftSize));
      }
      frame[row] = quantizeDb(20 * Math.log10(Math.max(peak, 1e-10)));
    }
    cacheFrame(ticks[column], frame);
  }
  report(1);
  return true;
}

function quantizeDb(value: number): number {
  return Math.round(Math.max(-200, Math.min(20, value)) * DB_QUANTIZATION);
}

type GpuPipelines = {
  initialize: GPUComputePipeline;
  stage: GPUComputePipeline;
  magnitude: GPUComputePipeline;
  initializeLayout: GPUBindGroupLayout;
  stageLayout: GPUBindGroupLayout;
  magnitudeLayout: GPUBindGroupLayout;
};

async function createGpuPipelines(device: GPUDevice): Promise<GpuPipelines> {
  const initializeLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  });
  const stageLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const magnitudeLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const [initialize, stage, magnitude] = await Promise.all([
    device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [initializeLayout] }),
      compute: { module: device.createShaderModule({ code: INITIALIZE_SHADER }), entryPoint: 'main' },
    }),
    device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [stageLayout] }),
      compute: { module: device.createShaderModule({ code: FFT_STAGE_SHADER }), entryPoint: 'main' },
    }),
    device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [magnitudeLayout] }),
      compute: { module: device.createShaderModule({ code: MAGNITUDE_SHADER }), entryPoint: 'main' },
    }),
  ]);
  return { initialize, stage, magnitude, initializeLayout, stageLayout, magnitudeLayout };
}

function createStageParameterBuffers(device: GPUDevice, fftSize: number): GPUBuffer[] {
  const buffers: GPUBuffer[] = [];
  for (let halfSize = 1; halfSize < fftSize; halfSize *= 2) {
    const data = new Uint32Array([fftSize, halfSize, 0, 0]);
    const buffer = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data);
    buffers.push(buffer);
  }
  return buffers;
}

async function runGpuBatch(
  device: GPUDevice,
  pipelines: GpuPipelines,
  stageParameters: GPUBuffer[],
  samples: Float32Array,
  frameStarts: Int32Array,
  fftSize: number,
  layout: AnalysisLayout,
): Promise<Float32Array> {
  const frameCount = frameStarts.length;
  const complexCount = frameCount * fftSize;
  const outputCount = frameCount * layout.rows;
  const sampleBuffer = createMappedBuffer(device, samples, GPUBufferUsage.STORAGE);
  const startBuffer = createMappedBuffer(device, frameStarts, GPUBufferUsage.STORAGE);
  const complexBuffer = device.createBuffer({ size: complexCount * 8, usage: GPUBufferUsage.STORAGE });
  const outputBuffer = device.createBuffer({
    size: outputCount * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuffer = device.createBuffer({
    size: outputCount * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const parameters = createAnalysisParameters(fftSize, frameCount, layout.rows, layout.bins, samples.length);
  const parameterBuffer = createMappedBuffer(device, parameters, GPUBufferUsage.UNIFORM);
  const frameCountValue = new Uint32Array([frameCount]);
  for (const stageParameter of stageParameters) device.queue.writeBuffer(stageParameter, 8, frameCountValue);

  const initializeGroup = device.createBindGroup({
    layout: pipelines.initializeLayout,
    entries: [
      { binding: 0, resource: { buffer: sampleBuffer } },
      { binding: 1, resource: { buffer: complexBuffer } },
      { binding: 2, resource: { buffer: parameterBuffer } },
      { binding: 3, resource: { buffer: startBuffer } },
    ],
  });
  const magnitudeGroup = device.createBindGroup({
    layout: pipelines.magnitudeLayout,
    entries: [
      { binding: 0, resource: { buffer: complexBuffer } },
      { binding: 1, resource: { buffer: outputBuffer } },
      { binding: 2, resource: { buffer: parameterBuffer } },
    ],
  });
  const encoder = device.createCommandEncoder();
  let pass = encoder.beginComputePass();
  pass.setPipeline(pipelines.initialize);
  pass.setBindGroup(0, initializeGroup);
  pass.dispatchWorkgroups(Math.ceil(complexCount / WORKGROUP_SIZE));
  pass.end();
  for (const stageParameter of stageParameters) {
    const stageGroup = device.createBindGroup({
      layout: pipelines.stageLayout,
      entries: [
        { binding: 0, resource: { buffer: complexBuffer } },
        { binding: 1, resource: { buffer: stageParameter } },
      ],
    });
    pass = encoder.beginComputePass();
    pass.setPipeline(pipelines.stage);
    pass.setBindGroup(0, stageGroup);
    pass.dispatchWorkgroups(Math.ceil((complexCount / 2) / WORKGROUP_SIZE));
    pass.end();
  }
  pass = encoder.beginComputePass();
  pass.setPipeline(pipelines.magnitude);
  pass.setBindGroup(0, magnitudeGroup);
  pass.dispatchWorkgroups(Math.ceil(outputCount / WORKGROUP_SIZE));
  pass.end();
  encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, outputCount * 4);
  device.queue.submit([encoder.finish()]);
  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(new Float32Array(readbackBuffer.getMappedRange()).slice());
  readbackBuffer.unmap();
  sampleBuffer.destroy();
  startBuffer.destroy();
  complexBuffer.destroy();
  outputBuffer.destroy();
  readbackBuffer.destroy();
  parameterBuffer.destroy();
  return result;
}

function createMappedBuffer(
  device: GPUDevice,
  data: Float32Array | Uint32Array | Int32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const size = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
  const buffer = device.createBuffer({ size, usage, mappedAtCreation: true });
  const range = buffer.getMappedRange();
  if (data instanceof Float32Array) new Float32Array(range).set(data);
  else if (data instanceof Int32Array) new Int32Array(range).set(data);
  else new Uint32Array(range).set(data);
  buffer.unmap();
  return buffer;
}

function createAnalysisParameters(
  fftSize: number,
  frameCount: number,
  rows: number,
  bins: number,
  sampleCount: number,
): Uint32Array {
  const buffer = new ArrayBuffer(48);
  const view = new DataView(buffer);
  view.setUint32(0, fftSize, true);
  view.setUint32(8, frameCount, true);
  view.setUint32(12, rows, true);
  view.setUint32(16, Math.log2(fftSize), true);
  view.setUint32(20, bins, true);
  view.setUint32(24, sampleCount, true);
  return new Uint32Array(buffer);
}

function yieldToWorker(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const PARAMETER_STRUCT = /* wgsl */ `
struct Parameters {
  fft_size: u32,
  unused: u32,
  frame_count: u32,
  rows: u32,
  log_n: u32,
  bins: u32,
  sample_count: u32,
  padding_0: u32,
  padding_1: vec4<f32>,
}
`;

const INITIALIZE_SHADER = /* wgsl */ `
${PARAMETER_STRUCT}
@group(0) @binding(0) var<storage, read> samples: array<f32>;
@group(0) @binding(1) var<storage, read_write> complex_values: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> parameters: Parameters;
@group(0) @binding(3) var<storage, read> frame_starts: array<i32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  let total = parameters.frame_count * parameters.fft_size;
  if (index >= total) { return; }
  let frame = index / parameters.fft_size;
  let local = index % parameters.fft_size;
  let source_index = frame_starts[frame] + i32(local);
  var sample_value = 0.0;
  if (source_index >= 0 && source_index < i32(parameters.sample_count)) {
    sample_value = samples[u32(source_index)];
  }
  let phase = 6.283185307179586 * f32(local) / f32(parameters.fft_size - 1u);
  let window = 0.5 - 0.5 * cos(phase);
  let reversed = reverseBits(local) >> (32u - parameters.log_n);
  complex_values[frame * parameters.fft_size + reversed] = vec2<f32>(sample_value * window, 0.0);
}
`;

const FFT_STAGE_SHADER = /* wgsl */ `
struct StageParameters { fft_size: u32, half_size: u32, frame_count: u32, padding: u32 }
@group(0) @binding(0) var<storage, read_write> values: array<vec2<f32>>;
@group(0) @binding(1) var<uniform> stage: StageParameters;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  let butterflies_per_frame = stage.fft_size / 2u;
  let total = stage.frame_count * butterflies_per_frame;
  if (index >= total) { return; }
  let frame = index / butterflies_per_frame;
  let local = index % butterflies_per_frame;
  let group = local / stage.half_size;
  let offset = local % stage.half_size;
  let block_size = stage.half_size * 2u;
  let first = frame * stage.fft_size + group * block_size + offset;
  let second = first + stage.half_size;
  let angle = -6.283185307179586 * f32(offset) / f32(block_size);
  let twiddle = vec2<f32>(cos(angle), sin(angle));
  let even = values[first];
  let source = values[second];
  let odd = vec2<f32>(
    source.x * twiddle.x - source.y * twiddle.y,
    source.x * twiddle.y + source.y * twiddle.x,
  );
  values[first] = even + odd;
  values[second] = even - odd;
}
`;

const MAGNITUDE_SHADER = /* wgsl */ `
${PARAMETER_STRUCT}
@group(0) @binding(0) var<storage, read> complex_values: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  let total = parameters.frame_count * parameters.rows;
  if (index >= total) { return; }
  let frame = index / parameters.rows;
  let row = index % parameters.rows;
  let bin_start = row * parameters.bins / parameters.rows;
  let bin_end = max(bin_start + 1u, (row + 1u) * parameters.bins / parameters.rows);
  var peak = 0.0;
  for (var bin = bin_start; bin < bin_end; bin += 1u) {
    let value = complex_values[frame * parameters.fft_size + bin];
    peak = max(peak, sqrt(dot(value, value)) * (4.0 / f32(parameters.fft_size)));
  }
  output[index] = clamp(log2(max(peak, 0.0000000001)) * 6.020599913, -200.0, 20.0);
}
`;

export {};
