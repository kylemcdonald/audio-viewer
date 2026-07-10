export type WavSampleFormat = 'pcm' | 'float';

export type WavHeader = {
  sampleFormat: WavSampleFormat;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
  validBitsPerSample: number;
  dataOffset: number;
  dataSize: number;
  frameCount: number;
  duration: number;
};

export type DecodedWavChunk = {
  channels: Array<Float32Array<ArrayBuffer>>;
  mono: Float32Array<ArrayBuffer>;
  frameCount: number;
};

type FormatChunk = Omit<WavHeader, 'dataOffset' | 'dataSize' | 'frameCount' | 'duration'>;

const PCM_FORMAT = 0x0001;
const IEEE_FLOAT_FORMAT = 0x0003;
const EXTENSIBLE_FORMAT = 0xfffe;

export async function parseWavHeader(file: File): Promise<WavHeader | null> {
  if (file.size < 12) return null;
  const riff = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const container = fourCc(riff, 0);
  if ((container !== 'RIFF' && container !== 'RF64') || fourCc(riff, 8) !== 'WAVE') return null;

  let format: FormatChunk | null = null;
  let dataOffset = -1;
  let dataSize = -1;
  let rf64DataSize: number | null = null;
  let offset = 12;

  for (let chunkIndex = 0; chunkIndex < 10_000 && offset + 8 <= file.size; chunkIndex += 1) {
    const headerBytes = new Uint8Array(await file.slice(offset, offset + 8).arrayBuffer());
    if (headerBytes.length < 8) break;
    const id = fourCc(headerBytes, 0);
    const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
    const declaredSize = view.getUint32(4, true);
    const payloadOffset = offset + 8;

    if (id === 'ds64' && declaredSize >= 16) {
      const bytes = await file.slice(payloadOffset, payloadOffset + Math.min(declaredSize, 32)).arrayBuffer();
      const ds64 = new DataView(bytes);
      const low = ds64.getUint32(8, true);
      const high = ds64.getUint32(12, true);
      rf64DataSize = high * 0x1_0000_0000 + low;
    } else if (id === 'fmt ') {
      const bytes = await file.slice(payloadOffset, payloadOffset + Math.min(declaredSize, 64)).arrayBuffer();
      format = parseFormatChunk(bytes);
    } else if (id === 'data') {
      dataOffset = payloadOffset;
      const requestedSize = declaredSize === 0xffff_ffff && rf64DataSize !== null
        ? rf64DataSize
        : declaredSize;
      dataSize = Math.max(0, Math.min(requestedSize, file.size - dataOffset));
      if (format) break;
    }

    const nextOffset = payloadOffset + declaredSize + (declaredSize & 1);
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > file.size) break;
    offset = nextOffset;
  }

  if (!format || dataOffset < 0 || dataSize < format.blockAlign) return null;
  const frameCount = Math.floor(dataSize / format.blockAlign);
  return {
    ...format,
    dataOffset,
    dataSize: frameCount * format.blockAlign,
    frameCount,
    duration: frameCount / format.sampleRate,
  };
}

export function decodeWavChunk(buffer: ArrayBuffer, header: WavHeader): DecodedWavChunk {
  const frameCount = Math.floor(buffer.byteLength / header.blockAlign);
  const channelData: Array<Float32Array<ArrayBuffer>> = Array.from(
    { length: header.channels },
    () => new Float32Array(frameCount),
  );
  const mono = new Float32Array(frameCount);
  const view = new DataView(buffer);
  const bytesPerSample = header.bitsPerSample / 8;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = frame * header.blockAlign;
    let sum = 0;
    for (let channel = 0; channel < header.channels; channel += 1) {
      const sample = readSample(view, frameOffset + channel * bytesPerSample, header);
      channelData[channel][frame] = sample;
      sum += sample;
    }
    mono[frame] = sum / header.channels;
  }

  return { channels: channelData, mono, frameCount };
}

export function preferredWavChunkBytes(header: WavHeader): number {
  const target = 2 * 1024 * 1024;
  return Math.max(header.blockAlign, Math.floor(target / header.blockAlign) * header.blockAlign);
}

function parseFormatChunk(buffer: ArrayBuffer): FormatChunk | null {
  if (buffer.byteLength < 16) return null;
  const view = new DataView(buffer);
  let formatTag = view.getUint16(0, true);
  const channels = view.getUint16(2, true);
  const sampleRate = view.getUint32(4, true);
  const blockAlign = view.getUint16(12, true);
  const bitsPerSample = view.getUint16(14, true);
  let validBitsPerSample = bitsPerSample;

  if (formatTag === EXTENSIBLE_FORMAT) {
    if (buffer.byteLength < 40) return null;
    validBitsPerSample = view.getUint16(18, true) || bitsPerSample;
    formatTag = view.getUint16(24, true);
  }

  const sampleFormat = formatTag === PCM_FORMAT
    ? 'pcm'
    : formatTag === IEEE_FLOAT_FORMAT
      ? 'float'
      : null;
  const supportedBits = sampleFormat === 'pcm'
    ? [8, 16, 24, 32].includes(bitsPerSample)
    : sampleFormat === 'float'
      ? bitsPerSample === 32 || bitsPerSample === 64
      : false;
  const bytesPerSample = bitsPerSample / 8;

  if (
    !sampleFormat || !supportedBits || !Number.isInteger(bytesPerSample) ||
    channels < 1 || sampleRate < 1 || blockAlign < channels * bytesPerSample
  ) return null;

  return {
    sampleFormat,
    channels,
    sampleRate,
    blockAlign,
    bitsPerSample,
    validBitsPerSample: Math.max(1, Math.min(bitsPerSample, validBitsPerSample)),
  };
}

function readSample(view: DataView, offset: number, header: WavHeader): number {
  if (header.sampleFormat === 'float') {
    const value = header.bitsPerSample === 32
      ? view.getFloat32(offset, true)
      : view.getFloat64(offset, true);
    return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  }

  if (header.bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128;

  let value: number;
  if (header.bitsPerSample === 16) {
    value = view.getInt16(offset, true);
  } else if (header.bitsPerSample === 24) {
    value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
    if (value & 0x80_0000) value -= 0x100_0000;
  } else {
    value = view.getInt32(offset, true);
  }

  const shift = header.bitsPerSample - header.validBitsPerSample;
  if (shift > 0) value >>= shift;
  return Math.max(-1, Math.min(1, value / 2 ** (header.validBitsPerSample - 1)));
}

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}
