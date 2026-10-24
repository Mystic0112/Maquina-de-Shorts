import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addTrack, cleanTrackName, listTracks, removeTrack, sniffAudio, trackPath } from "../../dashboard/server/music.js";

const dirs: string[] = [];
const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "music-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const wav = (): Buffer => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE"), Buffer.alloc(32)]);
const mp3 = (): Buffer => Buffer.concat([Buffer.from("ID3"), Buffer.alloc(40)]);

describe("Configurações > Músicas", () => {
  it("recognises audio by its first bytes, not by the name", () => {
    expect(sniffAudio(mp3())).toBe("mp3");
    expect(sniffAudio(Buffer.from([0xff, 0xfb, 0x90, 0x00, ...new Array(20).fill(0)]))).toBe("mp3");
    expect(sniffAudio(wav())).toBe("wav");
    expect(sniffAudio(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A "), Buffer.alloc(16)]))).toBe("m4a");
    expect(sniffAudio(Buffer.concat([Buffer.from("OggS"), Buffer.alloc(20)]))).toBe("ogg");
    expect(sniffAudio(Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(20)]))).toBe("flac");
    expect(sniffAudio(Buffer.from("<html><body>not audio at all</body></html>"))).toBeUndefined();
    expect(sniffAudio(Buffer.alloc(4))).toBeUndefined();
  });

  it("adds a track, lists it and keeps the file next to library.json", async () => {
    const dir = newDir();
    const track = await addTrack("  Minha   música  ", wav(), dir);
    expect(track.name).toBe("Minha música");
    expect(track.file).toMatch(/^minha-musica-[0-9a-f]{6}\.wav$/);
    expect(track.id).toMatch(/^minha-musica-[0-9a-f]{6}$/);
    expect((await listTracks(dir)).map((t) => t.id)).toEqual([track.id]);
    expect(readdirSync(dir).sort()).toEqual([track.file, "library.json"].sort());
    expect(await trackPath(track.id, dir)).toBe(join(dir, track.file));
  });

  it("refuses empty names, non-audio files, oversize files and repeated names", async () => {
    const dir = newDir();
    await expect(addTrack("  ", wav(), dir)).rejects.toMatchObject({ status: 400 });
    await expect(addTrack("x", Buffer.from("not audio, just text bytes here"), dir)).rejects.toMatchObject({ status: 400 });
    await expect(addTrack("x", undefined, dir)).rejects.toMatchObject({ status: 400 });
    await addTrack("Faixa", mp3(), dir);
    await expect(addTrack("faixa", mp3(), dir)).rejects.toMatchObject({ status: 409 });
    expect(await listTracks(dir)).toHaveLength(1);
  });

  it("removes the track and its file; unknown or unsafe ids are refused", async () => {
    const dir = newDir();
    const track = await addTrack("Faixa", mp3(), dir);
    expect(await removeTrack("../../etc/passwd", dir)).toBe(false);
    expect(await removeTrack("nao-existe-123456", dir)).toBe(false);
    expect(await removeTrack(track.id, dir)).toBe(true);
    expect(await listTracks(dir)).toEqual([]);
    expect(existsSync(join(dir, track.file))).toBe(false);
    expect(await trackPath(track.id, dir)).toBeUndefined();
  });

  it("cleans names: control characters, repeated spaces and length", () => {
    expect(cleanTrackName("a\u0000b\n  c")).toBe("a b c");
    expect(cleanTrackName("x".repeat(100))).toHaveLength(60);
    expect(cleanTrackName(42)).toBe("");
  });
});
