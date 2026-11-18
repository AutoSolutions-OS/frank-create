// Join finished clips (same model, size and codec) into one MP4, with no
// re-encode: the packets are copied and their times shifted. Used by the
// storyboard "Join film" step.
import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
} from "https://esm.sh/mediabunny@1.65.0";

export class JoinError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function sameBytes(a?: AllowSharedBufferSource | null, b?: AllowSharedBufferSource | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const x = a instanceof Uint8Array ? a : new Uint8Array(a as ArrayBuffer);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer);
  if (x.byteLength !== y.byteLength) return false;
  for (let i = 0; i < x.byteLength; i++) if (x[i] !== y[i]) return false;
  return true;
}

export async function joinMp4Clips(clips: Uint8Array[]): Promise<{
  bytes: Uint8Array;
  duration: number;
  width: number;
  height: number;
  audio: boolean;
}> {
  if (clips.length < 2) throw new JoinError("too_few_clips", "Join needs at least two clips.");
  const inputs = clips.map((bytes) => new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) }));
  const videos = await Promise.all(inputs.map((input) => input.getPrimaryVideoTrack()));
  if (videos.some((track) => !track)) throw new JoinError("no_video", "One of the clips has no video track.");
  const audios = await Promise.all(inputs.map((input) => input.getPrimaryAudioTrack()));

  const first = videos[0]!;
  const firstConfig = await first.getDecoderConfig();
  if (!first.codec || !firstConfig) throw new JoinError("unknown_codec", "The first clip's video codec is unknown.");
  for (let i = 1; i < videos.length; i++) {
    const v = videos[i]!;
    const config = await v.getDecoderConfig();
    if (v.codec !== first.codec || v.codedWidth !== first.codedWidth || v.codedHeight !== first.codedHeight) {
      throw new JoinError(
        "clips_differ",
        `Clip ${i + 1} is ${v.codedWidth}x${v.codedHeight} ${v.codec}, clip 1 is ${first.codedWidth}x${first.codedHeight} ${first.codec}. Make every shot with the same model, shape and resolution.`,
      );
    }
    if (!config || config.codec !== firstConfig.codec || !sameBytes(config.description, firstConfig.description)) {
      throw new JoinError("clips_differ", `Clip ${i + 1} was encoded differently from clip 1, so it cannot be joined without re-encoding.`);
    }
  }

  // Sound only when every clip has the same kind of sound; otherwise video only.
  const firstAudio = audios[0];
  let withAudio = !!firstAudio && audios.every((a) => a && a.codec === firstAudio.codec);
  const firstAudioConfig = withAudio ? await firstAudio!.getDecoderConfig() : null;
  if (withAudio) {
    for (const a of audios) {
      const c = await a!.getDecoderConfig();
      if (!c || !firstAudioConfig || c.sampleRate !== firstAudioConfig.sampleRate ||
        c.numberOfChannels !== firstAudioConfig.numberOfChannels || !sameBytes(c.description, firstAudioConfig.description)) {
        withAudio = false;
        break;
      }
    }
  }

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const videoOut = new EncodedVideoPacketSource(first.codec);
  output.addVideoTrack(videoOut);
  const audioOut = withAudio && firstAudio?.codec ? new EncodedAudioPacketSource(firstAudio.codec) : null;
  if (audioOut) output.addAudioTrack(audioOut);
  await output.start();

  let offset = 0;
  let videoMetaSent = false;
  let audioMetaSent = false;
  for (let i = 0; i < inputs.length; i++) {
    const v = videos[i]!;
    const start = await inputs[i].getFirstTimestamp();
    let clipEnd = 0;
    for await (const packet of new EncodedPacketSink(v).packets()) {
      const timestamp = offset + packet.timestamp - start;
      clipEnd = Math.max(clipEnd, packet.timestamp - start + packet.duration);
      await videoOut.add(packet.clone({ timestamp }), videoMetaSent ? undefined : { decoderConfig: firstConfig });
      videoMetaSent = true;
    }
    if (audioOut) {
      for await (const packet of new EncodedPacketSink(audios[i]!).packets()) {
        const local = packet.timestamp - start;
        // Sound past the end of the picture would overlap the next clip.
        if (local >= clipEnd) break;
        await audioOut.add(
          packet.clone({ timestamp: offset + local }),
          audioMetaSent ? undefined : { decoderConfig: firstAudioConfig! },
        );
        audioMetaSent = true;
      }
    }
    offset += clipEnd;
  }
  await output.finalize();
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new JoinError("empty_output", "The joined film came out empty.");
  return {
    bytes: new Uint8Array(buffer),
    duration: offset,
    width: first.displayWidth,
    height: first.displayHeight,
    audio: !!audioOut,
  };
}
