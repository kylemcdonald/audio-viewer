/**
 * Constant-Q analysis for the spectrogram worker (FNR-CQT column mode).
 *
 * Each spectrogram column is a constant-Q frame: one Hann-windowed FFT of a
 * segment centered on the column's tick (length L = 8x the UI FFT size,
 * capped at CQT_MAX_SEGMENT), followed by, for every log-spaced band, a windowed dot
 * product over the band's spectral support evaluated at the segment center.
 * The center-time phase factor e^{2*pi*i*bin*(L/2)/L} degenerates to
 * (-1)^bin, so no per-band inverse transform is needed — a CQT column costs
 * one FFT plus O(total spectral support) multiply-adds.
 *
 * Bands follow f_k = fmin * 2^(k/B) with support Gamma_k = f_k * (2^(1/B) -
 * 2^(-1/B)) (CQ-NSGT construction), Hann-shaped in frequency. Because the
 * segment itself is Hann-windowed (reusing the worker's initialize shader),
 * each band's effective response is the frequency window convolved with the
 * 3-bin segment-window kernel; the 2/L weight makes a full-scale tone at a
 * band center read ~0 dB, matching the FFT path's 4/fftSize convention.
 * Bands whose constant-Q bandwidth falls below CQT_MIN_SUPPORT_BINS FFT
 * bins are clamped to that width, transitioning smoothly to constant
 * bandwidth at the low end (see CQT_MIN_SUPPORT_BINS); they may read a few
 * dB low — a display-grade compromise inherent to windowed segments.
 *
 * This keeps the viewer's viewport-driven tick/column cache model intact:
 * only visible columns are computed, memory stays bounded by the existing
 * LRU frame cache, and multi-hour files work exactly as in FFT mode.
 */

// Below the audible floor on purpose: recordings often carry subsonic
// energy the FFT view shows, and the log display reaches toward 0 Hz.
export const CQT_FMIN = 10.0;
export const CQT_MAX_SEGMENT = 131072;
/**
 * Minimum spectral support per band, in FFT bins. Without this clamp, bands
 * whose constant-Q bandwidth falls below one bin degenerate to a single bin
 * whose Hann weight depends on where the fractional band center lands —
 * bands unlucky enough to center near a bin edge read ~0 (visible as black
 * horizontal stripes below ~50 Hz). With a 3-bin floor, every band always
 * straddles at least one well-weighted bin; bands below the constant-Q
 * limit smoothly become constant-bandwidth (3 * sr / L Hz), which is
 * exactly how linear FFT bins behave in that range.
 */
export const CQT_MIN_SUPPORT_BINS = 3;

export type CqtPlan = {
  sampleRate: number;
  L: number;
  logL: number;
  nBands: number;
  fMin: number;
  binsPerOctave: number;
  /** Per band: start bin, support length, offset into winValues, 0. */
  bandMeta: Uint32Array<ArrayBuffer>;
  /** Concatenated per-band window values (2/L * hann in frequency). */
  winValues: Float32Array<ArrayBuffer>;
  frequencies: Float64Array;
};

export function cqtSegmentSize(fftSize: number): number {
  return Math.max(4096, Math.min(CQT_MAX_SEGMENT, fftSize * 8));
}

/**
 * Vertical resolution follows the UI resolution slider: more bands per
 * octave at higher settings. Higher B needs the longer segments the same
 * slider positions provide (band supports halve as B doubles).
 */
export function cqtBinsPerOctave(fftSize: number): number {
  if (fftSize >= 16384) return 60;
  if (fftSize >= 8192) return 48;
  if (fftSize >= 4096) return 36;
  return 24;
}

export function buildCqtPlan(sampleRate: number, fftSize: number): CqtPlan {
  const L = cqtSegmentSize(fftSize);
  const B = cqtBinsPerOctave(fftSize);
  const fMax = (sampleRate / 2) * 2 ** (-0.5 / B);
  const nBands = 1 + Math.floor(B * Math.log2(fMax / CQT_FMIN) + 1e-9);
  const halfBins = Math.floor(L / 2);
  const starts: number[] = [];
  const supports: number[] = [];
  const windows: number[][] = [];
  const frequencies: number[] = [];
  for (let k = 0; k < nBands; k += 1) {
    const f = CQT_FMIN * 2 ** (k / B);
    const nu = (f * L) / sampleRate;
    const width = Math.max(
      (f * (2 ** (1 / B) - 2 ** (-1 / B)) * L) / sampleRate,
      CQT_MIN_SUPPORT_BINS,
    );
    let s = Math.floor(nu - 0.5 * width) + 1;
    let e = Math.ceil(nu + 0.5 * width) - 1;
    // Band supports start at bin 1 by default: the Hann segment kernel's
    // skirt collects any DC offset into bins 0-1, which otherwise brightens
    // the lowest bands with non-acoustic energy.
    s = Math.max(s, 1);
    e = Math.min(e, halfBins);
    if (e < s) { s = Math.min(Math.max(Math.round(nu), 1), halfBins); e = s; }
    const values: number[] = [];
    for (let bin = s; bin <= e; bin += 1) {
      const u = (bin - nu) / width;
      values.push(Math.abs(u) <= 0.5 ? (2 / L) * (0.5 + 0.5 * Math.cos(2 * Math.PI * u)) : 0);
    }
    starts.push(s);
    supports.push(values.length);
    windows.push(values);
    frequencies.push(f);
  }
  const totalSupport = supports.reduce((a, b) => a + b, 0);
  const bandMeta = new Uint32Array(nBands * 4);
  const winValues = new Float32Array(totalSupport);
  let offset = 0;
  for (let k = 0; k < nBands; k += 1) {
    bandMeta[k * 4] = starts[k];
    bandMeta[k * 4 + 1] = supports[k];
    bandMeta[k * 4 + 2] = offset;
    winValues.set(windows[k], offset);
    offset += supports[k];
  }
  return {
    sampleRate, L, logL: Math.log2(L), nBands,
    fMin: CQT_FMIN, binsPerOctave: B,
    bandMeta, winValues,
    frequencies: Float64Array.from(frequencies),
  };
}

/**
 * WGSL: one thread per (frame, band); sums the band's windowed spectral
 * support with the (-1)^bin center-time phase and writes dB using the same
 * clamp/scale convention as the FFT path's magnitude shader.
 */
export const CQT_COLUMN_SHADER = /* wgsl */ `
struct Parameters { frame_count: u32, n_bands: u32, fft_size: u32, padding: u32 }
struct BandMeta { start: u32, support: u32, win_offset: u32, padding: u32 }
@group(0) @binding(0) var<storage, read> complex_values: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> band_meta: array<BandMeta>;
@group(0) @binding(2) var<storage, read> win_values: array<f32>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;
@group(0) @binding(4) var<uniform> parameters: Parameters;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  let total = parameters.frame_count * parameters.n_bands;
  if (index >= total) { return; }
  let frame = index / parameters.n_bands;
  let band = band_meta[index % parameters.n_bands];
  let base = frame * parameters.fft_size;
  var accumulator = vec2<f32>(0.0, 0.0);
  for (var j = 0u; j < band.support; j += 1u) {
    let bin = band.start + j;
    let sign = 1.0 - 2.0 * f32(bin & 1u);
    accumulator += complex_values[base + bin] * (win_values[band.win_offset + j] * sign);
  }
  let magnitude = sqrt(dot(accumulator, accumulator));
  output[index] = clamp(log2(max(magnitude, 0.0000000001)) * 6.020599913, -200.0, 20.0);
}
`;

/**
 * CPU fallback: CQT column dB values from an fft.js half spectrum
 * (interleaved complex, valid below fft_size/2) of a Hann-windowed segment.
 */
export function cqtColumnFromSpectrum(plan: CqtPlan, spectrum: number[] | Float64Array): Float64Array {
  const out = new Float64Array(plan.nBands);
  for (let k = 0; k < plan.nBands; k += 1) {
    const start = plan.bandMeta[k * 4];
    const support = plan.bandMeta[k * 4 + 1];
    const winOffset = plan.bandMeta[k * 4 + 2];
    let re = 0;
    let im = 0;
    for (let j = 0; j < support; j += 1) {
      const bin = start + j;
      const weight = plan.winValues[winOffset + j] * (bin & 1 ? -1 : 1);
      re += spectrum[bin * 2] * weight;
      im += spectrum[bin * 2 + 1] * weight;
    }
    const magnitude = Math.sqrt(re * re + im * im);
    out[k] = Math.max(-200, Math.min(20, 20 * Math.log10(Math.max(magnitude, 1e-10))));
  }
  return out;
}
