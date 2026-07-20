/// <reference lib="webworker" />

import type {
  AmbisonicRemixInput,
  AmbisonicRemixStart,
  RemixPriorityTier,
} from './ambisonic-remix.types';
import { prepareRemixRanges } from './ambisonic-remix';
import { decodeWavMonoChunk } from './wav-reader';

const worker = self as unknown as DedicatedWorkerGlobalScope;

type RemixJob = {
  request: AmbisonicRemixStart;
  totalChunks: number;
  backgroundCursor: number;
  priorityQueue: RemixPriorityTier[];
  complete: boolean;
};

let activeJob: RemixJob | null = null;

worker.onmessage = (event: MessageEvent<AmbisonicRemixInput>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (activeJob && message.id >= activeJob.request.id) activeJob = null;
    return;
  }

  if (message.type === 'prioritize') {
    const job = activeJob;
    if (!job || job.request.id !== message.id) return;
    if (job.complete) {
      for (const tier of message.priorityTiers) {
        worker.postMessage({ type: 'tier-complete', id: message.id, token: tier.token });
      }
      return;
    }
    job.priorityQueue.unshift(...message.priorityTiers);
    return;
  }

  const chunkFrames = Math.max(1, Math.floor(message.chunkFrames));
  const job: RemixJob = {
    request: { ...message, chunkFrames },
    totalChunks: Math.ceil(message.header.frameCount / chunkFrames),
    backgroundCursor: 0,
    priorityQueue: [...message.priorityTiers],
    complete: false,
  };
  activeJob = job;
  void runRemix(job);
};

async function runRemix(job: RemixJob): Promise<void> {
  try {
    while (activeJob === job) {
      const tier = job.priorityQueue.shift();
      if (tier) {
        await processPriorityTier(job, tier);
        if (activeJob !== job) return;
        worker.postMessage({ type: 'tier-complete', id: job.request.id, token: tier.token });
        continue;
      }

      if (job.backgroundCursor >= job.totalChunks) {
        job.complete = true;
        worker.postMessage({ type: 'progress', id: job.request.id, progress: 1 });
        worker.postMessage({ type: 'complete', id: job.request.id });
        return;
      }

      const chunk = job.backgroundCursor;
      job.backgroundCursor += 1;
      await processChunk(job, chunk, false);
      if (activeJob !== job) return;
      if (chunk % 4 === 0 || job.backgroundCursor === job.totalChunks) {
        worker.postMessage({
          type: 'progress',
          id: job.request.id,
          progress: job.backgroundCursor / Math.max(1, job.totalChunks),
        });
      }
    }
  } catch (error) {
    if (activeJob !== job) return;
    worker.postMessage({
      type: 'error',
      id: job.request.id,
      message: error instanceof Error ? error.message : 'Unknown remix error',
    });
  }
}

async function processPriorityTier(job: RemixJob, tier: RemixPriorityTier): Promise<void> {
  const ranges = prepareRemixRanges(
    tier.ranges,
    job.request.header.frameCount,
    job.request.chunkFrames,
  );
  for (const range of ranges) {
    if (activeJob !== job) return;
    await processRange(job, range.startSample, range.endSample, true);
  }
}

async function processChunk(job: RemixJob, chunk: number, priority: boolean): Promise<void> {
  const { header, chunkFrames } = job.request;
  const startSample = chunk * chunkFrames;
  const endSample = Math.min(header.frameCount, startSample + chunkFrames);
  await processRange(job, startSample, endSample, priority);
}

async function processRange(
  job: RemixJob,
  startSample: number,
  endSample: number,
  priority: boolean,
): Promise<void> {
  const { file, header, weights, id } = job.request;
  const frameCount = endSample - startSample;
  if (frameCount <= 0) return;
  const byteStart = header.dataOffset + startSample * header.blockAlign;
  const byteEnd = byteStart + frameCount * header.blockAlign;
  const encoded = await file.slice(byteStart, byteEnd).arrayBuffer();
  if (activeJob !== job) return;
  const decoded = decodeWavMonoChunk(encoded, header, weights);
  const samples = decoded.mono.buffer;
  worker.postMessage(
    { type: 'chunk', id, startSample, samples, priority },
    [samples],
  );
}
