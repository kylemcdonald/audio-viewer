/// <reference lib="webworker" />

import FFT from 'fft.js';
import type { AnalysisInput, AnalysisMode, AnalysisRequest } from './types';
import {
  buildCqtPlan,
  cqtBinsPerOctave,
  cqtColumnFromSpectrum,
  cqtSegmentSize,
  CQT_COLUMN_SHADER,
  type CqtPlan,
} from './cqt';

const worker = self as unknown as DedicatedWorkerGlobalScope;
const WORKGROUP_SIZE = 256;
const MAX_COMPLEX_VALUES_PER_BATCH = 1_048_576;
// CQT segments are up to 8x longer than FFT frames; a larger batch budget
// keeps the frames-per-batch count (and per-batch overhead) comparable.
const MAX_CQT_COMPLEX_VALUES_PER_BATCH = 4_194_304;
const MAX_CACHE_VALUES = 32_000_000;
const DB_QUANTIZATION = 10;
const FLOOR_DB = -200;
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
let frameCacheGeneration = 0;
const frameCache = new Map<number, Int16Array>();
const cqtPlans = new Map<string, CqtPlan>();

function getCqtPlan(sampleRate: number, fftSize: number, includeDc: boolean): CqtPlan {
  const key = `${sampleRate}:${cqtSegmentSize(fftSize)}:${cqtBinsPerOctave(fftSize)}:${includeDc ? 'dc' : 'nodc'}`;
  let plan = cqtPlans.get(key);
  if (!plan) {
    plan = buildCqtPlan(sampleRate, fftSize, includeDc);
    cqtPlans.set(key, plan);
  }
  return plan;
}

type AnalysisLayout = {
  bins: number;
  rows: number;
};

type GpuContext = {
  device: GPUDevice;
  pipelines: GpuPipelines;
  /** Static CQT band tables uploaded once per (sampleRate, segment) plan. */
  cqtPlanBuffers: Map<string, { meta: GPUBuffer; win: GPUBuffer }>;
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
  const mode: AnalysisMode = request.analysisMode === 'cqt' ? 'cqt' : 'fft';
  const cqtPlan = mode === 'cqt'
    ? getCqtPlan(audioSampleRate, request.fftSize, request.cqtIncludeDc === true)
    : null;
  // The analysis segment per column: the FFT frame, or the (longer) CQT one.
  const segmentSize = cqtPlan ? cqtPlan.L : request.fftSize;
  // FFT rows follow the transform size so higher resolution settings reach
  // the image (previously capped at 1024, which max-pooled away all bin
  // detail beyond the 1,024-bin setting). Larger frames shrink the LRU
  // cache's column count correspondingly (MAX_CACHE_VALUES is unchanged).
  const layout: AnalysisLayout = cqtPlan
    ? { bins: cqtPlan.nBands, rows: cqtPlan.nBands }
    : { bins: request.fftSize / 2, rows: Math.min(request.fftSize / 2, 4096) };
  // Negative key namespaces CQT cache entries away from FFT sizes; the +1
  // separates DC-included frames (L is a power of two, so no collision).
  const cacheGeneration = prepareFrameCache(
    cqtPlan ? -(cqtPlan.L + (cqtPlan.includeDc ? 1 : 0)) : request.fftSize,
    layout.rows,
  );
  const plan = createAnalysisPlan(request, segmentSize);
  if (plan.targetTicks.length === 0) return;
  const fullyCached = plan.targetTicks.every((tick) => frameCache.has(tick));

  if (fullyCached) {
    postViewport(request, layout, plan, plan.targetStepMs, 0, true, 0, plan.targetTicks.length, cqtPlan);
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
      segmentSize,
      cqtPlan,
      fullyCached,
      (ticks, report) => (cqtPlan
        ? analyzeCqtFramesWithGpu(gpu, ticks, cqtPlan, request.id, cacheGeneration, report)
        : analyzeFramesWithGpu(
          gpu,
          ticks,
          request.fftSize,
          layout,
          request.id,
          cacheGeneration,
          report,
        )),
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
        segmentSize,
        cqtPlan,
        fullyCached || cachedAfterGpu,
        (ticks, report) => (cqtPlan
          ? analyzeCqtFramesWithCpu(ticks, cqtPlan, request.id, cacheGeneration, report)
          : analyzeFramesWithCpu(
            ticks,
            request.fftSize,
            layout,
            request.id,
            cacheGeneration,
            report,
          )),
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

function createAnalysisPlan(request: AnalysisRequest, segmentSize: number): AnalysisPlan {
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
    .filter((tick) => isFrameAvailable(tick, segmentSize));
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
  segmentSize: number,
  cqtPlan: CqtPlan | null,
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
        .filter((tick) => isFrameAvailable(tick, segmentSize));
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
          cqtPlan,
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
        cqtPlan,
      );
      visibleResultSent = true;
      finestReadyStepMs = stageStepMs;
      await yieldToWorker();
    }
  }

  if (request.id !== latestJobId || !request.prefetchFiner) return;
  await prefetchFinerLevels(request, plan.targetStepMs, segmentSize, compute);
}

async function prefetchFinerLevels(
  request: AnalysisRequest,
  targetStepMs: number,
  segmentSize: number,
  compute: FrameComputer,
): Promise<void> {
  for (let stepMs = targetStepMs / 2; stepMs >= MINIMUM_TEMPORAL_STEP_MS; stepMs /= 2) {
    if (request.id !== latestJobId) return;
    const ticks = createAlignedTicks(request.startTime, request.viewDuration, stepMs)
      .filter((tick) => isFrameAvailable(tick, segmentSize));
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
  cqtPlan: CqtPlan | null,
): void {
  if (request.id !== latestJobId || plan.targetTicks.length === 0) return;
  const segmentSize = cqtPlan ? cqtPlan.L : request.fftSize;
  const values = assembleViewport(plan.targetTicks, availableStepMs, layout.rows, segmentSize);
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
      mode: (cqtPlan ? 'cqt' : 'fft') as AnalysisMode,
      cqtFmin: cqtPlan?.fMin,
      cqtBinsPerOctave: cqtPlan?.binsPerOctave,
    },
  };
  worker.postMessage(payload, [values.buffer]);
}

function assembleViewport(
  targetTicks: readonly number[],
  availableStepMs: number,
  rows: number,
  segmentSize: number,
): Int16Array {
  const values = new Int16Array(targetTicks.length * rows);
  values.fill(quantizeDb(FLOOR_DB));
  const resolved: Array<Int16Array | null> = new Array(targetTicks.length).fill(null);

  for (let column = 0; column < targetTicks.length; column += 1) {
    const tick = targetTicks[column];
    let frame = frameCache.get(tick);
    if (!frame) {
      const nearest = Math.round(tick / availableStepMs) * availableStepMs;
      const lower = Math.floor(tick / availableStepMs) * availableStepMs;
      const upper = Math.ceil(tick / availableStepMs) * availableStepMs;
      frame = frameCache.get(nearest) ?? frameCache.get(lower) ?? frameCache.get(upper);
    }
    if (frame) resolved[column] = frame;
  }

  const nearestLeft = new Int32Array(targetTicks.length);
  let left = -1;
  for (let column = 0; column < targetTicks.length; column += 1) {
    if (resolved[column]) left = column;
    nearestLeft[column] = left;
  }

  let right = -1;
  for (let column = targetTicks.length - 1; column >= 0; column -= 1) {
    if (resolved[column]) right = column;
    if (!resolved[column] && isFrameAvailable(targetTicks[column], segmentSize)) {
      const leftIndex = nearestLeft[column];
      const leftDistance = leftIndex < 0
        ? Number.POSITIVE_INFINITY
        : Math.abs(targetTicks[column] - targetTicks[leftIndex]);
      const rightDistance = right < 0
        ? Number.POSITIVE_INFINITY
        : Math.abs(targetTicks[right] - targetTicks[column]);
      const nearestIndex = leftDistance <= rightDistance ? leftIndex : right;
      if (nearestIndex >= 0) resolved[column] = resolved[nearestIndex];
    }
  }

  for (let column = 0; column < targetTicks.length; column += 1) {
    const frame = resolved[column];
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

function isFrameAvailable(tick: number, segmentSize: number): boolean {
  if (audioComplete) return true;
  const centerSample = Math.round((tick / 1000) * audioSampleRate);
  return centerSample + segmentSize / 2 <= audioAvailableSamples;
}

function createFrameStarts(ticks: readonly number[], sampleRate: number, fftSize: number): Int32Array {
  const starts = new Int32Array(ticks.length);
  const halfWindow = fftSize / 2;
  for (let index = 0; index < ticks.length; index += 1) {
    starts[index] = Math.round((ticks[index] / 1000) * sampleRate - halfWindow);
  }
  return starts;
}

function packFrameSamples(ticks: readonly number[], fftSize: number): Float32Array {
  const packed = new Float32Array(ticks.length * fftSize);
  if (!audioSamples) return packed;
  const starts = createFrameStarts(ticks, audioSampleRate, fftSize);
  for (let frame = 0; frame < starts.length; frame += 1) {
    const start = starts[frame];
    const sourceStart = Math.max(0, start);
    const sourceEnd = Math.min(audioSamples.length, start + fftSize);
    if (sourceEnd <= sourceStart) continue;
    const destinationStart = frame * fftSize + sourceStart - start;
    packed.set(audioSamples.subarray(sourceStart, sourceEnd), destinationStart);
  }
  return packed;
}

function prepareFrameCache(fftSize: number, rows: number): number {
  if (cachedFftSize !== fftSize || cachedRows !== rows) {
    clearFrameCache();
    cachedFftSize = fftSize;
    cachedRows = rows;
  }
  maximumCachedFrames = Math.max(1, Math.floor(MAX_CACHE_VALUES / rows));
  return frameCacheGeneration;
}

function clearFrameCache(): void {
  frameCache.clear();
  cachedFftSize = 0;
  cachedRows = 0;
  maximumCachedFrames = 1;
  frameCacheGeneration += 1;
}

function cacheFrame(tick: number, frame: Int16Array, generation: number): boolean {
  if (generation !== frameCacheGeneration) return false;
  if (frameCache.has(tick)) frameCache.delete(tick);
  frameCache.set(tick, frame);
  while (frameCache.size > maximumCachedFrames) {
    const oldest = frameCache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    frameCache.delete(oldest);
  }
  return true;
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
      return { device, pipelines, cqtPlanBuffers: new Map() };
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
  cacheGeneration: number,
  report: (progress: number) => void,
): Promise<boolean> {
  if (!audioSamples || ticks.length === 0) return true;
  const { device, pipelines } = gpu;
  const stageParameters = createStageParameterBuffers(device, fftSize);
  const maxBatchFrames = Math.max(1, Math.floor(MAX_COMPLEX_VALUES_PER_BATCH / fftSize));

  try {
    for (let frameStart = 0; frameStart < ticks.length; frameStart += maxBatchFrames) {
      if (id !== latestJobId || cacheGeneration !== frameCacheGeneration) return false;
      const batchTicks = ticks.slice(frameStart, frameStart + maxBatchFrames);
      const frameCount = batchTicks.length;
      const packedSamples = packFrameSamples(batchTicks, fftSize);
      const batch = await runGpuBatch(
        device,
        pipelines,
        stageParameters,
        packedSamples,
        fftSize,
        layout,
      );
      if (id !== latestJobId || cacheGeneration !== frameCacheGeneration) return false;
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        const frame = new Int16Array(layout.rows);
        const source = frameIndex * layout.rows;
        for (let row = 0; row < layout.rows; row += 1) {
          frame[row] = quantizeDb(batch[source + row]);
        }
        if (!cacheFrame(batchTicks[frameIndex], frame, cacheGeneration)) return false;
      }
      report((frameStart + frameCount) / ticks.length);
    }
  } finally {
    for (const buffer of stageParameters) buffer.destroy();
  }
  return true;
}

function getCqtPlanBuffers(gpu: GpuContext, plan: CqtPlan): { meta: GPUBuffer; win: GPUBuffer } {
  const key = `${plan.sampleRate}:${plan.L}:${plan.binsPerOctave}:${plan.includeDc ? 'dc' : 'nodc'}`;
  let buffers = gpu.cqtPlanBuffers.get(key);
  if (!buffers) {
    const meta = gpu.device.createBuffer({
      size: plan.bandMeta.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    gpu.device.queue.writeBuffer(meta, 0, plan.bandMeta);
    const win = gpu.device.createBuffer({
      size: plan.winValues.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    gpu.device.queue.writeBuffer(win, 0, plan.winValues);
    buffers = { meta, win };
    gpu.cqtPlanBuffers.set(key, buffers);
  }
  return buffers;
}

async function analyzeCqtFramesWithGpu(
  gpu: GpuContext,
  ticks: readonly number[],
  plan: CqtPlan,
  id: number,
  cacheGeneration: number,
  report: (progress: number) => void,
): Promise<boolean> {
  if (!audioSamples || ticks.length === 0) return true;
  const { device, pipelines } = gpu;
  const stageParameters = createStageParameterBuffers(device, plan.L);
  const planBuffers = getCqtPlanBuffers(gpu, plan);
  const maxBatchFrames = Math.max(1, Math.floor(MAX_CQT_COMPLEX_VALUES_PER_BATCH / plan.L));

  try {
    for (let frameStart = 0; frameStart < ticks.length; frameStart += maxBatchFrames) {
      if (id !== latestJobId || cacheGeneration !== frameCacheGeneration) return false;
      const batchTicks = ticks.slice(frameStart, frameStart + maxBatchFrames);
      const packedSamples = packFrameSamples(batchTicks, plan.L);
      const batch = await runCqtGpuBatch(
        device,
        pipelines,
        stageParameters,
        planBuffers,
        packedSamples,
        plan,
      );
      if (id !== latestJobId || cacheGeneration !== frameCacheGeneration) return false;
      for (let frameIndex = 0; frameIndex < batchTicks.length; frameIndex += 1) {
        const frame = new Int16Array(plan.nBands);
        const source = frameIndex * plan.nBands;
        for (let row = 0; row < plan.nBands; row += 1) {
          frame[row] = quantizeDb(batch[source + row]);
        }
        if (!cacheFrame(batchTicks[frameIndex], frame, cacheGeneration)) return false;
      }
      report((frameStart + batchTicks.length) / ticks.length);
    }
  } finally {
    for (const buffer of stageParameters) buffer.destroy();
  }
  return true;
}

async function runCqtGpuBatch(
  device: GPUDevice,
  pipelines: GpuPipelines,
  stageParameters: GPUBuffer[],
  planBuffers: { meta: GPUBuffer; win: GPUBuffer },
  samples: Float32Array,
  plan: CqtPlan,
): Promise<Float32Array> {
  const frameCount = samples.length / plan.L;
  const complexCount = frameCount * plan.L;
  const outputCount = frameCount * plan.nBands;
  const sampleBuffer = createMappedBuffer(device, samples, GPUBufferUsage.STORAGE);
  const complexBuffer = device.createBuffer({ size: complexCount * 8, usage: GPUBufferUsage.STORAGE });
  const outputBuffer = device.createBuffer({
    size: outputCount * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuffer = device.createBuffer({
    size: outputCount * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  // The initialize shader Hann-windows and bit-reverses each segment; rows
  // and bins are unused on this path.
  const parameters = createAnalysisParameters(plan.L, frameCount, 1, 1, samples.length);
  const parameterBuffer = createMappedBuffer(device, parameters, GPUBufferUsage.UNIFORM);
  const columnParameters = new Uint32Array([frameCount, plan.nBands, plan.L, 0]);
  const columnParameterBuffer = createMappedBuffer(device, columnParameters, GPUBufferUsage.UNIFORM);
  const frameCountValue = new Uint32Array([frameCount]);
  for (const stageParameter of stageParameters) device.queue.writeBuffer(stageParameter, 8, frameCountValue);

  const initializeGroup = device.createBindGroup({
    layout: pipelines.initializeLayout,
    entries: [
      { binding: 0, resource: { buffer: sampleBuffer } },
      { binding: 1, resource: { buffer: complexBuffer } },
      { binding: 2, resource: { buffer: parameterBuffer } },
    ],
  });
  const columnGroup = device.createBindGroup({
    layout: pipelines.cqtColumnLayout,
    entries: [
      { binding: 0, resource: { buffer: complexBuffer } },
      { binding: 1, resource: { buffer: planBuffers.meta } },
      { binding: 2, resource: { buffer: planBuffers.win } },
      { binding: 3, resource: { buffer: outputBuffer } },
      { binding: 4, resource: { buffer: columnParameterBuffer } },
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
  pass.setPipeline(pipelines.cqtColumn);
  pass.setBindGroup(0, columnGroup);
  pass.dispatchWorkgroups(Math.ceil(outputCount / WORKGROUP_SIZE));
  pass.end();
  encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, outputCount * 4);
  device.queue.submit([encoder.finish()]);
  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(new Float32Array(readbackBuffer.getMappedRange()).slice());
  readbackBuffer.unmap();
  sampleBuffer.destroy();
  complexBuffer.destroy();
  outputBuffer.destroy();
  readbackBuffer.destroy();
  parameterBuffer.destroy();
  columnParameterBuffer.destroy();
  return result;
}

async function analyzeCqtFramesWithCpu(
  ticks: readonly number[],
  plan: CqtPlan,
  id: number,
  cacheGeneration: number,
  report: (progress: number) => void,
): Promise<boolean> {
  if (!audioSamples || ticks.length === 0) return true;
  const input = new Float64Array(plan.L);
  const transform = new FFT(plan.L);
  const spectrum = transform.createComplexArray();
  const frameStarts = createFrameStarts(ticks, audioSampleRate, plan.L);
  const window = new Float64Array(plan.L);
  for (let index = 0; index < plan.L; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (plan.L - 1));
  }

  for (let column = 0; column < frameStarts.length; column += 1) {
    if (column % 8 === 0) {
      if (id !== latestJobId || cacheGeneration !== frameCacheGeneration) return false;
      report(column / frameStarts.length);
      await yieldToWorker();
    }
    input.fill(0);
    const start = frameStarts[column];
    for (let index = 0; index < plan.L; index += 1) {
      const source = start + index;
      input[index] = (source >= 0 && source < audioSamples.length ? audioSamples[source] : 0) * window[index];
    }
    transform.realTransform(spectrum, input);
    const db = cqtColumnFromSpectrum(plan, spectrum);
    const frame = new Int16Array(plan.nBands);
    for (let row = 0; row < plan.nBands; row += 1) frame[row] = quantizeDb(db[row]);
    if (!cacheFrame(ticks[column], frame, cacheGeneration)) return false;
  }
  report(1);
  return true;
}

async function analyzeFramesWithCpu(
  ticks: readonly number[],
  fftSize: number,
  layout: AnalysisLayout,
  id: number,
  cacheGeneration: number,
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
      if (id !== latestJobId || cacheGeneration !== frameCacheGeneration) return false;
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
    if (!cacheFrame(ticks[column], frame, cacheGeneration)) return false;
  }
  report(1);
  return true;
}

function quantizeDb(value: number): number {
  const safeValue = Number.isFinite(value) ? value : FLOOR_DB;
  return Math.round(Math.max(FLOOR_DB, Math.min(20, safeValue)) * DB_QUANTIZATION);
}

type GpuPipelines = {
  initialize: GPUComputePipeline;
  stage: GPUComputePipeline;
  magnitude: GPUComputePipeline;
  cqtColumn: GPUComputePipeline;
  initializeLayout: GPUBindGroupLayout;
  stageLayout: GPUBindGroupLayout;
  magnitudeLayout: GPUBindGroupLayout;
  cqtColumnLayout: GPUBindGroupLayout;
};

async function createGpuPipelines(device: GPUDevice): Promise<GpuPipelines> {
  const initializeLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
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
  const cqtColumnLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const [initialize, stage, magnitude, cqtColumn] = await Promise.all([
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
    device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [cqtColumnLayout] }),
      compute: { module: device.createShaderModule({ code: CQT_COLUMN_SHADER }), entryPoint: 'main' },
    }),
  ]);
  return {
    initialize, stage, magnitude, cqtColumn,
    initializeLayout, stageLayout, magnitudeLayout, cqtColumnLayout,
  };
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
  fftSize: number,
  layout: AnalysisLayout,
): Promise<Float32Array> {
  const frameCount = samples.length / fftSize;
  const complexCount = frameCount * fftSize;
  const outputCount = frameCount * layout.rows;
  const sampleBuffer = createMappedBuffer(device, samples, GPUBufferUsage.STORAGE);
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

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  let total = parameters.frame_count * parameters.fft_size;
  if (index >= total) { return; }
  let frame = index / parameters.fft_size;
  let local = index % parameters.fft_size;
  let source_index = frame * parameters.fft_size + local;
  var sample_value = 0.0;
  if (source_index < parameters.sample_count) {
    sample_value = samples[source_index];
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
