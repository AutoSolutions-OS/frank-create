// Integration test for the storyboard "Join film" path: clips are served over
// HTTP and downloaded the way POST /storyboards/:id/join reads them, joined,
// then the output film is opened again and checked packet by packet.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from "https://esm.sh/mediabunny@1.65.0";
import { joinMp4Clips } from "./joinClips.ts";

const dir = new URL("./testdata/", import.meta.url);

async function serveTestdata() {
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const name = new URL(req.url).pathname.slice(1);
    if (!/^[\w-]+\.mp4$/.test(name)) return new Response("not found", { status: 404 });
    try {
      return new Response(await Deno.readFile(new URL(name, dir)), { headers: { "content-type": "video/mp4" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  const { port } = server.addr as Deno.NetAddr;
  return { base: `http://127.0.0.1:${port}/`, server };
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  assert(res.ok, `download failed ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function packets(bytes: Uint8Array) {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  const read = async (track: any) => {
    const out: { timestamp: number; duration: number }[] = [];
    if (!track) return out;
    for await (const p of new EncodedPacketSink(track).packets()) out.push({ timestamp: p.timestamp, duration: p.duration });
    return out;
  };
  return { video: await read(video), audio: await read(audio), duration: await input.computeDuration(), width: video?.displayWidth };
}

Deno.test("join film: downloaded clips become one playable film with every frame in order", async () => {
  const { base, server } = await serveTestdata();
  try {
    const parts = [await download(base + "clip-a.mp4"), await download(base + "clip-b.mp4")];
    const [a, b] = await Promise.all(parts.map(packets));
    const film = await joinMp4Clips(parts);
    assert(film.bytes.byteLength > 0);

    const out = await packets(film.bytes);
    assertEquals(out.video.length, a.video.length + b.video.length);
    assertEquals(out.width, 160);
    assert(out.audio.length > 0, "film should keep its sound");
    // Packets are in decode order (B-frames), so check time windows, not order:
    // clip 1's frames stay before its end, clip 2's start where clip 1 ends.
    const span = (ps: { timestamp: number; duration: number }[]) => ({
      start: Math.min(...ps.map((p) => p.timestamp)),
      end: Math.max(...ps.map((p) => p.timestamp + p.duration)),
    });
    const aLen = span(a.video).end - span(a.video).start;
    const first = span(out.video.slice(0, a.video.length));
    const second = span(out.video.slice(a.video.length));
    assert(Math.abs(first.start) < 0.05, `film starts at ${first.start}`);
    assert(first.end <= second.start + 0.05, `clip 1 ends at ${first.end}, clip 2 starts at ${second.start}`);
    assert(Math.abs(second.start - aLen) < 0.05, `clip 2 starts at ${second.start}, clip 1 lasts ${aLen}`);
    assertEquals(Math.round(out.duration), 2);
    assertEquals(Math.round(film.duration), 2);
  } finally {
    await server.shutdown();
  }
});
