import { AudioBufferSource, BufferTarget, Mp3OutputFormat, Output } from 'mediabunny';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import type { WavHeader } from './wav-reader';

const RIFF_SIZE_OFFSET = 4;
const DATA_SIZE_OFFSET_FROM_PAYLOAD = 4;
const MAX_RIFF_SIZE = 0xffff_ffff;
const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000] as const;

export type AudioBufferWavOptions = {
  sourceHeader?: WavHeader | null;
  normalizePeak?: boolean;
};

export type AudioBufferMp3Options = {
  normalizePeak?: boolean;
};

/**
 * Creates a conventional RIFF/WAV file containing the selected source
 * frames. The original fmt chunk and sample payload are kept byte-for-byte,
 * so PCM/float encoding, channel layout, sample rate, bit depth, and valid
 * bit depth all remain exactly as they were in the source WAV.
 */
export async function trimWavFile(
  file: File,
  header: WavHeader,
  startTime: number,
  endTime: number,
): Promise<Blob> {
  const [startFrame, endFrame] = selectionFrameRange(header, startTime, endTime);
  const selectedFrames = endFrame - startFrame;
  const selectedBytes = selectedFrames * header.blockAlign;
  const payloadStart = header.dataOffset + startFrame * header.blockAlign;
  const padding = selectedBytes & 1;
  const outputSize = header.dataOffset + selectedBytes + padding;

  if (outputSize - 8 > MAX_RIFF_SIZE) {
    throw new Error('The selected WAV region is too large for a standard RIFF/WAV download.');
  }

  const prefix = new Uint8Array(await file.slice(0, header.dataOffset).arrayBuffer());
  if (prefix.byteLength < 12 || header.dataOffset < 8) {
    throw new Error('The WAV header is incomplete.');
  }

  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  // A selected region below 4 GiB can always be represented as regular RIFF,
  // including when the input was RF64. ds64, if present, remains an ignorable
  // metadata chunk after this conversion.
  writeFourCc(view, 0, 'RIFF');
  view.setUint32(RIFF_SIZE_OFFSET, outputSize - 8, true);
  view.setUint32(header.dataOffset - DATA_SIZE_OFFSET_FROM_PAYLOAD, selectedBytes, true);
  updateFactChunkLength(view, header.dataOffset, selectedFrames);

  const payload = file.slice(payloadStart, payloadStart + selectedBytes);
  const parts: BlobPart[] = [prefix, payload];
  if (padding) parts.push(new Uint8Array(1));
  return new Blob(parts, { type: 'audio/wav' });
}

/**
 * Fallback for decoded (non-WAV) sources. AudioBuffer has a float32 sample
 * representation, so this produces a standards-compliant 32-bit float WAV
 * while retaining the decoded channel count and sample rate.
 */
export function trimAudioBufferToFloatWav(
  buffer: AudioBuffer,
  startTime: number,
  endTime: number,
): Blob {
  return encodeAudioBufferToWav(buffer, startTime, endTime);
}

/**
 * Encodes a decoded selection as WAV. When a source WAV header is supplied,
 * it retains that source's PCM/float sample format and bit depth; otherwise
 * it produces a 32-bit float WAV. Peak normalization is applied across every
 * selected channel before quantization.
 */
export function encodeAudioBufferToWav(
  buffer: AudioBuffer,
  startTime: number,
  endTime: number,
  options: AudioBufferWavOptions = {},
): Blob {
  const [startFrame, endFrame] = audioBufferFrameRange(buffer, startTime, endTime);
  const encoding = wavEncodingFor(options.sourceHeader);
  const frameCount = endFrame - startFrame;
  const bytesPerSample = encoding.bitsPerSample / 8;
  const blockAlign = buffer.numberOfChannels * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const useExtensibleFormat = buffer.numberOfChannels > 2 || encoding.validBitsPerSample !== encoding.bitsPerSample;
  const formatSize = useExtensibleFormat ? 40 : 16;
  const dataOffset = 12 + 8 + formatSize + 8;
  const padding = dataSize & 1;
  const totalSize = dataOffset + dataSize + padding;

  if (totalSize - 8 > MAX_RIFF_SIZE) {
    throw new Error('The selected WAV region is too large for a standard RIFF/WAV download.');
  }

  const bytes = new ArrayBuffer(totalSize);
  const view = new DataView(bytes);
  writeFourCc(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeFourCc(view, 8, 'WAVE');
  writeFourCc(view, 12, 'fmt ');
  view.setUint32(16, formatSize, true);
  view.setUint16(20, useExtensibleFormat ? WAVE_FORMAT_EXTENSIBLE : encoding.formatTag, true);
  view.setUint16(22, buffer.numberOfChannels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, encoding.bitsPerSample, true);
  if (useExtensibleFormat) {
    view.setUint16(36, 22, true);
    view.setUint16(38, encoding.validBitsPerSample, true);
    view.setUint32(40, defaultChannelMask(buffer.numberOfChannels), true);
    writeWaveSubformatGuid(view, 44, encoding.formatTag);
  }
  const dataHeaderOffset = 12 + 8 + formatSize;
  writeFourCc(view, dataHeaderOffset, 'data');
  view.setUint32(dataHeaderOffset + 4, dataSize, true);

  const gain = options.normalizePeak ? selectionPeakGain(buffer, startFrame, endFrame) : 1;
  let offset = dataOffset;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    for (const samples of channels) {
      offset = writeWavSample(view, offset, samples[frame] * gain, encoding);
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

/** Encodes a selected AudioBuffer region as a constant-bitrate MP3 file. */
export async function encodeAudioBufferToMp3(
  buffer: AudioBuffer,
  startTime: number,
  endTime: number,
  options: AudioBufferMp3Options = {},
): Promise<Blob> {
  const [startFrame, endFrame] = audioBufferFrameRange(buffer, startTime, endTime);
  const gain = options.normalizePeak ? selectionPeakGain(buffer, startFrame, endFrame) : 1;
  const selection = copyAudioBufferRange(buffer, startFrame, endFrame, gain);
  const targetSampleRate = closestMp3SampleRate(selection.sampleRate);
  const targetChannels = selection.numberOfChannels === 1 ? 1 : 2;

  ensureMp3Encoder();
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp3OutputFormat(),
    target,
  });
  const source = new AudioBufferSource({
    codec: 'mp3',
    bitrate: targetChannels === 1 ? 128_000 : 192_000,
    transform: {
      numberOfChannels: targetChannels,
      sampleRate: targetSampleRate,
    },
  });
  output.addAudioTrack(source);
  await output.start();
  await source.add(selection);
  await output.finalize();

  if (!target.buffer) throw new Error('MP3 encoding did not produce an output file.');
  return new Blob([target.buffer], { type: 'audio/mpeg' });
}

function selectionFrameRange(header: WavHeader, startTime: number, endTime: number): [number, number] {
  const start = Number.isFinite(startTime) ? startTime : 0;
  const end = Number.isFinite(endTime) ? endTime : 0;
  const lower = Math.max(0, Math.min(header.duration, Math.min(start, end)));
  const upper = Math.max(lower, Math.min(header.duration, Math.max(start, end)));
  const startFrame = Math.max(0, Math.min(header.frameCount, Math.round(lower * header.sampleRate)));
  const endFrame = Math.max(startFrame, Math.min(header.frameCount, Math.round(upper * header.sampleRate)));
  if (endFrame <= startFrame) throw new Error('Select a non-empty audio range before downloading.');
  return [startFrame, endFrame];
}

function audioBufferFrameRange(buffer: AudioBuffer, startTime: number, endTime: number): [number, number] {
  const start = Number.isFinite(startTime) ? startTime : 0;
  const end = Number.isFinite(endTime) ? endTime : 0;
  const lower = Math.max(0, Math.min(buffer.duration, Math.min(start, end)));
  const upper = Math.max(lower, Math.min(buffer.duration, Math.max(start, end)));
  const startFrame = Math.max(0, Math.min(buffer.length, Math.round(lower * buffer.sampleRate)));
  const endFrame = Math.max(startFrame, Math.min(buffer.length, Math.round(upper * buffer.sampleRate)));
  if (endFrame <= startFrame) throw new Error('Select a non-empty audio range before downloading.');
  return [startFrame, endFrame];
}

function wavEncodingFor(header: WavHeader | null | undefined): {
  formatTag: number;
  bitsPerSample: number;
  validBitsPerSample: number;
} {
  if (!header) {
    return { formatTag: WAVE_FORMAT_IEEE_FLOAT, bitsPerSample: 32, validBitsPerSample: 32 };
  }
  return {
    formatTag: header.sampleFormat === 'float' ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM,
    bitsPerSample: header.bitsPerSample,
    validBitsPerSample: header.validBitsPerSample,
  };
}

function selectionPeakGain(buffer: AudioBuffer, startFrame: number, endFrame: number): number {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      peak = Math.max(peak, Math.abs(samples[frame]));
    }
  }
  return peak > 0 && Number.isFinite(peak) ? 1 / peak : 1;
}

function copyAudioBufferRange(
  buffer: AudioBuffer,
  startFrame: number,
  endFrame: number,
  gain: number,
): AudioBuffer {
  const result = new AudioBuffer({
    length: endFrame - startFrame,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  });
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const source = buffer.getChannelData(channel);
    const destination = result.getChannelData(channel);
    if (gain === 1) {
      destination.set(source.subarray(startFrame, endFrame));
      continue;
    }
    for (let frame = 0; frame < destination.length; frame += 1) {
      destination[frame] = clampSample(source[startFrame + frame] * gain);
    }
  }
  return result;
}

function writeWavSample(
  view: DataView,
  offset: number,
  sample: number,
  encoding: { formatTag: number; bitsPerSample: number; validBitsPerSample: number },
): number {
  const value = clampSample(sample);
  if (encoding.formatTag === WAVE_FORMAT_IEEE_FLOAT) {
    if (encoding.bitsPerSample === 64) view.setFloat64(offset, value, true);
    else view.setFloat32(offset, value, true);
    return offset + encoding.bitsPerSample / 8;
  }

  if (encoding.bitsPerSample === 8) {
    // decodeWavChunk maps unsigned PCM with (byte - 128) / 128.  Use the
    // exact inverse here so a normalized 8-bit WAV does not lose a code value
    // (for example, an original byte of 255 must remain 255, not become 254).
    view.setUint8(offset, Math.max(0, Math.min(255, Math.round(value * 128 + 128))));
    return offset + 1;
  }

  const scale = 2 ** (encoding.validBitsPerSample - 1);
  const quantized = value <= -1 ? -scale : Math.round(value * (scale - 1));
  const packed = quantized * 2 ** (encoding.bitsPerSample - encoding.validBitsPerSample);
  if (encoding.bitsPerSample === 16) {
    view.setInt16(offset, packed, true);
    return offset + 2;
  }
  if (encoding.bitsPerSample === 24) {
    const unsigned = packed < 0 ? packed + 0x1_000000 : packed;
    view.setUint8(offset, unsigned & 0xff);
    view.setUint8(offset + 1, (unsigned >>> 8) & 0xff);
    view.setUint8(offset + 2, (unsigned >>> 16) & 0xff);
    return offset + 3;
  }
  view.setInt32(offset, packed, true);
  return offset + 4;
}

function clampSample(value: number): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

function defaultChannelMask(channels: number): number {
  const masks = [0, 0x4, 0x3, 0x7, 0x33, 0x37, 0x3f, 0x13f, 0x63f];
  return masks[channels] ?? 0;
}

function writeWaveSubformatGuid(view: DataView, offset: number, formatTag: number): void {
  view.setUint32(offset, formatTag, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0x0010, true);
  view.setUint8(offset + 8, 0x80);
  view.setUint8(offset + 9, 0x00);
  view.setUint8(offset + 10, 0x00);
  view.setUint8(offset + 11, 0xaa);
  view.setUint8(offset + 12, 0x00);
  view.setUint8(offset + 13, 0x38);
  view.setUint8(offset + 14, 0x9b);
  view.setUint8(offset + 15, 0x71);
}

function closestMp3SampleRate(sampleRate: number): number {
  return MP3_SAMPLE_RATES.reduce((closest, candidate) => (
    Math.abs(candidate - sampleRate) < Math.abs(closest - sampleRate) ? candidate : closest
  ));
}

let mp3EncoderRegistered = false;

function ensureMp3Encoder(): void {
  if (mp3EncoderRegistered) return;
  registerMp3Encoder();
  mp3EncoderRegistered = true;
}

function writeFourCc(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < 4; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

function updateFactChunkLength(view: DataView, dataOffset: number, frameCount: number): void {
  let offset = 12;
  while (offset + 8 <= dataOffset) {
    const id = readFourCc(view, offset);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (id === 'fact' && size >= 4 && payload + 4 <= dataOffset) {
      view.setUint32(payload, frameCount, true);
    }
    if (id === 'data') return;
    const next = payload + size + (size & 1);
    if (next <= offset || next > dataOffset) return;
    offset = next;
  }
}

function readFourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}
