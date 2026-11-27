import { describe, expect, it } from "vitest";
import { createVoiceLevelAnalyzer } from "../src/avatar-voice-level.js";

const SAMPLE_RATE_HZ = 24_000;

function tone(milliseconds: number, gain: number): Buffer {
  const samples = (SAMPLE_RATE_HZ * milliseconds) / 1000;
  const audio = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = gain * Math.sin((2 * Math.PI * 300 * index) / SAMPLE_RATE_HZ);
    audio.writeInt16LE(Math.round(value * 32_767), index * 2);
  }
  return audio;
}

describe("FaceTime avatar voice level", () => {
  it("emits one zero per 20 ms hop of silence and drops a partial hop", () => {
    const analyze = createVoiceLevelAnalyzer();

    expect(analyze(tone(50, 0))).toEqual([0, 0]);
    expect(analyze(Buffer.alloc(0))).toEqual([]);
  });

  it("lights fully for a quiet voice heard on its own", () => {
    expect(createVoiceLevelAnalyzer()(tone(60, 0.1))).toEqual([100, 100, 100]);
  });

  it("scales the level with loudness relative to recent speech", () => {
    const analyze = createVoiceLevelAnalyzer();
    const loud = analyze(tone(100, 0.5)).at(-1);
    const soft = analyze(tone(100, 0.1)).at(-1);
    const faint = analyze(tone(100, 0.012)).at(-1);

    expect(loud).toBe(100);
    expect(soft).toBeGreaterThan(25);
    expect(soft).toBeLessThan(55);
    expect(faint).toBe(0);
  });
});
