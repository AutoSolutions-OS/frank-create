import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { JoinError, joinMp4Clips } from "./joinClips.ts";

const dir = new URL("./testdata/", import.meta.url);
const read = (name: string) => Deno.readFile(new URL(name, dir));

Deno.test("two 1 s clips become one 2 s film with sound, no re-encode", async () => {
  const film = await joinMp4Clips([await read("clip-a.mp4"), await read("clip-b.mp4")]);
  assertEquals([film.width, film.height, film.audio], [160, 160, true]);
  assertEquals(Math.round(film.duration), 2);
});

Deno.test("clips of another size are refused with a clear reason", async () => {
  const err = await assertRejects(
    async () => joinMp4Clips([await read("clip-a.mp4"), await read("clip-wide.mp4")]),
    JoinError,
  );
  assertEquals(err.code, "clips_differ");
});

Deno.test("one clip is not a film", async () => {
  await assertRejects(async () => joinMp4Clips([await read("clip-a.mp4")]), JoinError);
});
