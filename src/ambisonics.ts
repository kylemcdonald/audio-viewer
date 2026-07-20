export type MonoMixMode = 'sum' | 'first' | 'directional';

export type AmbisonicInputFormat = 'ambix' | 'fuma' | 'a-format';

export type VirtualMicrophoneDirection = {
  azimuth: number;
  elevation: number;
};

export type FourChannelMixSettings = VirtualMicrophoneDirection & {
  mode: MonoMixMode;
  format: AmbisonicInputFormat;
};

export type FourChannelWeights = readonly [number, number, number, number];

const QUARTER = 0.25;
const THREE_QUARTERS = 0.75;

export function directionVector(
  azimuthDegrees: number,
  elevationDegrees: number,
): readonly [front: number, left: number, up: number] {
  const azimuth = degreesToRadians(wrapAzimuth(azimuthDegrees));
  const elevation = degreesToRadians(clampElevation(elevationDegrees));
  const horizontal = Math.cos(elevation);
  return [
    horizontal * Math.cos(azimuth),
    horizontal * Math.sin(azimuth),
    Math.sin(elevation),
  ];
}

/**
 * Returns a peak-normalized mono decoder for a four-channel source.
 *
 * The directional decoder is the first-order regular/hypercardioid
 * beamformer. Its response is (1 + 3 cos(theta)) / 4: unity on-axis,
 * -0.5 at the rear, and the maximum directivity factor available at FOA.
 */
export function fourChannelMixWeights(settings: FourChannelMixSettings): FourChannelWeights {
  if (settings.mode === 'first') return [1, 0, 0, 0];
  if (settings.mode === 'sum') return [QUARTER, QUARTER, QUARTER, QUARTER];

  const [front, left, up] = directionVector(settings.azimuth, settings.elevation);

  if (settings.format === 'ambix') {
    // ACN/SN3D first order: W, Y, Z, X.
    return [
      QUARTER,
      THREE_QUARTERS * left,
      THREE_QUARTERS * up,
      THREE_QUARTERS * front,
    ];
  }

  if (settings.format === 'fuma') {
    // Traditional B-format: W, X, Y, Z. FuMa W is 1/sqrt(2) of SN3D W.
    return [
      Math.SQRT2 * QUARTER,
      THREE_QUARTERS * front,
      THREE_QUARTERS * left,
      THREE_QUARTERS * up,
    ];
  }

  // Canonical tetrahedral A-format: FLU, FRD, BLD, BRU. This is the
  // normalized scalar A-to-B matrix for ideal matched cardioid capsules.
  // Manufacturer calibration/EQ can still improve a real array.
  const directionalScale = (3 * Math.sqrt(3)) / 8;
  return [
    1 / 8 + directionalScale * (front + left + up),
    1 / 8 + directionalScale * (front - left - up),
    1 / 8 + directionalScale * (-front + left - up),
    1 / 8 + directionalScale * (-front - left + up),
  ];
}

export function mixChannelData(
  channels: readonly Float32Array[],
  weights?: readonly number[],
): Float32Array<ArrayBuffer> {
  const length = channels.reduce((minimum, channel) => Math.min(minimum, channel.length), Infinity);
  if (!Number.isFinite(length) || length <= 0) return new Float32Array(0);
  const mixed = new Float32Array(length);
  const defaultGain = 1 / Math.max(1, channels.length);

  for (let channel = 0; channel < channels.length; channel += 1) {
    const source = channels[channel];
    const gain = weights?.[channel] ?? defaultGain;
    if (gain === 0) continue;
    for (let frame = 0; frame < length; frame += 1) mixed[frame] += source[frame] * gain;
  }
  return mixed;
}

export function detectAmbisonicInputFormat(
  trackNames: readonly string[] | null | undefined,
): AmbisonicInputFormat | null {
  if (!trackNames || trackNames.length < 4) return null;
  const names = trackNames.slice(0, 4).map(normalizeTrackName);
  if (names.join(',') === 'W,Y,Z,X') return 'ambix';
  if (names.join(',') === 'W,X,Y,Z') return 'fuma';
  if (names.join(',') === 'FLU,FRD,BLD,BRU') return 'a-format';
  return null;
}

export function inferAmbisonicInputFormat(fileName: string): AmbisonicInputFormat | null {
  const normalized = fileName.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  if (/\b(?:a format|aformat|ambeo|tetrahedral)\b/.test(normalized)) return 'a-format';
  if (/\bfuma\b/.test(normalized)) return 'fuma';
  if (/\b(?:ambix|acn)\b/.test(normalized)) return 'ambix';
  return null;
}

export function wrapAzimuth(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

export function clampElevation(value: number): number {
  return Number.isFinite(value) ? Math.max(-90, Math.min(90, value)) : 0;
}

function normalizeTrackName(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}
