/// <reference lib="webworker" />

import type {
  DirectionalCompositionConfigure,
  DirectionalCompositionDirection,
  DirectionalCompositionInput,
  DirectionalCompositionResult,
} from './directional-composition.types';

const worker = self as unknown as DedicatedWorkerGlobalScope;
const VALUES_PER_COMPLEX_CELL = 8;
const FLOOR_DB = -200;
const CEILING_DB = 20;
const DB_QUANTIZATION = 10;
const COLUMNS_PER_YIELD = 64;

let configuration: (Omit<DirectionalCompositionConfigure, 'basis'> & {
  basis: Float32Array;
}) | null = null;
let latestDirection: DirectionalCompositionDirection | null = null;
let composing = false;
const yieldChannel = new MessageChannel();
const yieldResolvers: Array<() => void> = [];
yieldChannel.port1.onmessage = () => yieldResolvers.shift()?.();

worker.onmessage = (event: MessageEvent<DirectionalCompositionInput>) => {
  const message = event.data;
  if (message.type === 'configure') {
    configuration = {
      ...message,
      basis: new Float32Array(message.basis),
    };
    latestDirection = null;
    return;
  }
  if (!configuration || message.generation !== configuration.generation) return;
  latestDirection = message;
  void pump();
};

async function pump(): Promise<void> {
  if (composing) return;
  composing = true;
  try {
    while (latestDirection) {
      const direction = latestDirection;
      latestDirection = null;
      const result = await compose(direction);
      if (!result) continue;
      const newer = latestDirection as DirectionalCompositionDirection | null;
      if (newer && newer.id > direction.id) continue;
      worker.postMessage(result, [result.values]);
    }
  } finally {
    composing = false;
    if (latestDirection) void pump();
  }
}

async function compose(
  direction: DirectionalCompositionDirection,
): Promise<DirectionalCompositionResult | null> {
  const config = configuration;
  if (!config || direction.generation !== config.generation) return null;
  const { basis, columns, rows, binsPerCell } = config;
  const values = new Int16Array(columns * rows);
  const w0 = direction.weights[0] ?? 0;
  const w1 = direction.weights[1] ?? 0;
  const w2 = direction.weights[2] ?? 0;
  const w3 = direction.weights[3] ?? 0;
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
        basisOffset += VALUES_PER_COMPLEX_CELL;
      }
      const db = Math.log2(Math.max(peakPower, 1e-20)) * 3.0102999566;
      values[outputOffset] = Math.round(
        Math.max(FLOOR_DB, Math.min(CEILING_DB, db)) * DB_QUANTIZATION,
      );
      outputOffset += 1;
    }
    if ((column + 1) % COLUMNS_PER_YIELD === 0 && column + 1 < columns) {
      await yieldToWorker();
      if (
        configuration !== config ||
        (latestDirection && latestDirection.id > direction.id)
      ) return null;
    }
  }

  return {
    type: 'result',
    id: direction.id,
    generation: direction.generation,
    part: config.part,
    startColumn: config.startColumn,
    columns,
    values: values.buffer,
  };
}

function yieldToWorker(): Promise<void> {
  return new Promise((resolve) => {
    yieldResolvers.push(resolve);
    yieldChannel.port2.postMessage(0);
  });
}
