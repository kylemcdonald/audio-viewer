import {
  AudioSampleSink,
  BlobSource,
  Input,
  MP4,
  type InputAudioTrack,
} from 'mediabunny';

export type Mp4PcmBlock = {
  startFrame: number;
  samples: Float32Array<ArrayBuffer>;
};

export class Mp4NoAudioTrackError extends Error {
  constructor() {
    super('This MP4 file does not contain an audio track.');
    this.name = 'Mp4NoAudioTrackError';
  }
}

export class Mp4AudioDecodeUnsupportedError extends Error {
  constructor(codec: string) {
    super(`This browser cannot progressively decode the MP4 audio codec (${codec}).`);
    this.name = 'Mp4AudioDecodeUnsupportedError';
  }
}

export class Mp4AudioSession {
  readonly frameCount: number;

  private disposed = false;

  constructor(
    private readonly input: Input,
    private readonly track: InputAudioTrack,
    readonly sampleRate: number,
    readonly channels: number,
    readonly duration: number,
    readonly codec: string,
  ) {
    this.frameCount = Math.max(1, Math.ceil(duration * sampleRate));
  }

  async *blocks(): AsyncGenerator<Mp4PcmBlock> {
    if (this.disposed) throw new Error('The MP4 audio session has been disposed.');
    const sink = new AudioSampleSink(this.track);

    for await (const sample of sink.samples()) {
      let block: Mp4PcmBlock;
      try {
        if (sample.sampleRate !== this.sampleRate) {
          throw new Error(`The MP4 audio sample rate changed from ${this.sampleRate} Hz to ${sample.sampleRate} Hz.`);
        }
        const mono = new Float32Array(sample.numberOfFrames);
        const plane = new Float32Array(sample.numberOfFrames);
        for (let channel = 0; channel < sample.numberOfChannels; channel += 1) {
          sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
          for (let frame = 0; frame < mono.length; frame += 1) {
            mono[frame] += plane[frame] / sample.numberOfChannels;
          }
        }
        block = {
          startFrame: Math.round(sample.timestamp * this.sampleRate),
          samples: mono,
        };
      } finally {
        sample.close();
      }
      yield block;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.dispose();
  }
}

export async function openMp4Audio(file: File): Promise<Mp4AudioSession> {
  const input = new Input({
    formats: [MP4],
    source: new BlobSource(file, { maxCacheSize: 16 * 1024 * 1024 }),
  });

  try {
    if (!await input.canRead()) throw new Error('The file is not a readable MP4 container.');
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Mp4NoAudioTrackError();

    const [sampleRate, channels, codec, canDecode] = await Promise.all([
      track.getSampleRate(),
      track.getNumberOfChannels(),
      track.getCodecParameterString(),
      track.canDecode(),
    ]);
    const codecLabel = codec ?? await track.getCodec() ?? 'unknown';
    if (!canDecode) throw new Mp4AudioDecodeUnsupportedError(codecLabel);

    const metadataDuration = await track.getDurationFromMetadata();
    const duration = metadataDuration ?? await track.computeDuration({ metadataOnly: true });
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('The MP4 audio track has no measurable duration.');
    }

    return new Mp4AudioSession(input, track, sampleRate, channels, duration, codecLabel);
  } catch (error) {
    input.dispose();
    throw error;
  }
}
