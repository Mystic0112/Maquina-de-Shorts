import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeVoiceReference, saveVoiceReference, voiceReference } from "../../dashboard/server/voiceRef.js";

const dirs: string[] = [];
const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "voiceref-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const wav = (): Buffer => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE"), Buffer.alloc(32)]);
const mp3 = (): Buffer => Buffer.concat([Buffer.from("ID3"), Buffer.alloc(40)]);
const flac = (): Buffer => Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(40)]);
const ogg = (): Buffer => Buffer.concat([Buffer.from("OggS"), Buffer.alloc(40)]);

describe("Configurações > Voz > Chatterbox: gravação de referência", () => {
  it("keeps one recording, replaced by the newest, and returns the project-relative path", async () => {
    const dir = newDir();
    expect(await saveVoiceReference(wav(), dir)).toBe("data/voice_ref/reference.wav");
    expect(await saveVoiceReference(mp3(), dir)).toBe("data/voice_ref/reference.mp3");
    expect(existsSync(join(dir, "reference.wav"))).toBe(false);
    expect(voiceReference(dir)?.path).toBe("data/voice_ref/reference.mp3");
    expect(await saveVoiceReference(flac(), dir)).toBe("data/voice_ref/reference.flac");
  });

  it("refuses what the Chatterbox script cannot read", async () => {
    const dir = newDir();
    await expect(saveVoiceReference(ogg(), dir)).rejects.toThrow(/WAV, MP3 ou FLAC/);
    await expect(saveVoiceReference(Buffer.from("not audio at all"), dir)).rejects.toThrow(/WAV, MP3 ou FLAC/);
    await expect(saveVoiceReference("text", dir)).rejects.toThrow(/WAV, MP3 ou FLAC/);
    expect(voiceReference(dir)).toBeUndefined();
  });

  it("deletes the recording on request", async () => {
    const dir = newDir();
    expect(await removeVoiceReference(dir)).toBe(false);
    await saveVoiceReference(wav(), dir);
    expect(await removeVoiceReference(dir)).toBe(true);
    expect(voiceReference(dir)).toBeUndefined();
  });
});
