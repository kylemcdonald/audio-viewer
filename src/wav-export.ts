import type { WavHeader } from './wav-reader';

const RIFF_SIZE_OFFSET = 4;
const DATA_SIZE_OFFSET_FROM_PAYLOAD = 4;
const MAX_RIFF_SIZE = 0xffff_ffff;

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
  const startFrame = Math.max(0, Math.min(buffer.length, Math.round(startTime * buffer.sampleRate)));
  const endFrame = Math.max(startFrame, Math.min(buffer.length, Math.round(endTime * buffer.sampleRate)));
  const frameCount = endFrame - startFrame;
  const bytesPerSample = 4;
  const blockAlign = buffer.numberOfChannels * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const bytes = new ArrayBuffer(44 + dataSize);
  const view = new DataView(bytes);

  writeFourCc(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeFourCc(view, 8, 'WAVE');
  writeFourCc(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, buffer.numberOfChannels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  writeFourCc(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      view.setFloat32(offset, buffer.getChannelData(channel)[frame], true);
      offset += bytesPerSample;
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
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
