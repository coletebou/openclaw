import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFaceTimeCallTrace } from "../src/call-trace.js";

// A constant half-scale signal: RMS and peak are both -6.0 dBFS.
function halfScale(samples: number): Buffer {
  const audio = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    audio.writeInt16LE(index % 2 === 0 ? 16_384 : -16_384, index * 2);
  }
  return audio;
}

describe("FaceTime call trace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps events with the call and the time since it started", () => {
    const info = vi.fn();
    const trace = createFaceTimeCallTrace({
      callUUID: "98A409DB-DF13-4FD0-9C40-DB707E977FA6",
      logger: { info, warn: vi.fn(), error: vi.fn() },
    });

    vi.advanceTimersByTime(250);
    trace.event("provider session ready");
    trace.stop("call media stopped: connect-failed");
    trace.stop("call media stopped: again");
    // A call whose audio never started has no meter to leak.
    vi.advanceTimersByTime(5_000);

    expect(info.mock.calls).toEqual([
      ["[facetime] trace 98a409db +0.25s provider session ready"],
      ["[facetime] trace 98a409db +0.25s call media stopped: connect-failed"],
    ]);
  });

  it("reports each second's caller and model levels, then starts the next second empty", () => {
    const info = vi.fn();
    const trace = createFaceTimeCallTrace({
      callUUID: "98A409DB-DF13-4FD0-9C40-DB707E977FA6",
      logger: { info, warn: vi.fn(), error: vi.fn() },
    });

    trace.start({ heardMs: () => 0, queuedMs: () => 120.4 });
    trace.inputAudio(halfScale(480));
    vi.advanceTimersByTime(1_000);
    trace.outputAudio(Buffer.alloc(960));
    vi.advanceTimersByTime(1_000);
    trace.stop("call media stopped: closed");
    vi.advanceTimersByTime(5_000);

    expect(info.mock.calls).toEqual([
      ["[facetime] trace 98a409db +0.00s call session started"],
      ["[facetime] trace 98a409db +1.00s levels in=-6.0/-6.0dBFS out=none queued=120ms"],
      ["[facetime] trace 98a409db +1.00s model audio started"],
      ["[facetime] trace 98a409db +2.00s levels in=none out=-90.0/-90.0dBFS queued=120ms"],
      ["[facetime] trace 98a409db +2.00s call media stopped: closed"],
    ]);
  });

  it("shows an interruption: the caller's level, and what was heard and dropped", () => {
    const info = vi.fn();
    const trace = createFaceTimeCallTrace({
      callUUID: "98A409DB-DF13-4FD0-9C40-DB707E977FA6",
      logger: { info, warn: vi.fn(), error: vi.fn() },
    });
    trace.start({ heardMs: () => 1_840.2, queuedMs: () => 2_600 });

    trace.outputAudio(Buffer.alloc(960));
    trace.outputAudio(Buffer.alloc(960));
    // Per-token, per-chunk and per-packet events never reach the timeline.
    for (const type of [
      "response.output_audio.delta",
      "input_audio_buffer.append",
      "output_audio.rtp",
      "response.content_part.added",
    ]) {
      trace.providerEvent({ direction: "server", type });
    }
    trace.inputAudio(halfScale(480));
    trace.providerEvent({ direction: "server", type: "input_audio_buffer.speech_started" });
    trace.speechEnded("model audio cleared");
    // The provider reports the cancelled response after the audio is already gone.
    trace.speechEnded("response cancelled");
    trace.providerEvent({ direction: "server", type: "error", detail: "rate limited" });
    trace.stop("call media stopped: closed");

    expect(info.mock.calls.map(([line]) => String(line).replace(/^.*\+0\.\d\ds /u, ""))).toEqual([
      "call session started",
      "model audio started",
      "provider server:input_audio_buffer.speech_started in=-6.0/-6.0dBFS 1840ms heard, 2600ms dropped",
      "model audio cleared: 1840ms heard, 2600ms dropped",
      "response cancelled",
      "provider server:error rate limited",
      "call media stopped: closed",
    ]);
  });

  it("times a tool from its call to its result, however late the result arrives", () => {
    const info = vi.fn();
    const trace = createFaceTimeCallTrace({
      callUUID: "98A409DB-DF13-4FD0-9C40-DB707E977FA6",
      logger: { info, warn: vi.fn(), error: vi.fn() },
    });
    const call = {
      type: "tool.call",
      callId: "call-7",
      payload: { name: "openclaw_agent_consult" },
    };

    // The event is passed through untouched for the talk session to record.
    expect(trace.talkEvent(call)).toBe(call);
    trace.talkEvent({ type: "tool.progress", callId: "call-7" });
    vi.advanceTimersByTime(4_200);
    trace.talkEvent({ type: "tool.result", callId: "call-7", payload: {} });
    trace.talkEvent({ type: "tool.error", callId: "call-7" });
    trace.talkEvent({ type: "tool.call", callId: "call-8", payload: { name: "facetime_look" } });
    vi.advanceTimersByTime(12);
    trace.talkEvent({ type: "tool.error", callId: "call-8" });
    trace.stop("call media stopped: closed");

    expect(info.mock.calls.map(([line]) => String(line).replace(/^\S+ trace \S+ /u, ""))).toEqual([
      "+0.00s tool call openclaw_agent_consult",
      "+4.20s tool openclaw_agent_consult answered after 4200ms",
      "+4.20s tool call facetime_look",
      "+4.21s tool facetime_look failed after 12ms",
      "+4.21s call media stopped: closed",
    ]);
  });
});

describe("FaceTime call record", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("keeps the words and the looked-at frames in the call's folder, not in the Gateway log", async () => {
    const recordsDir = tempDirs.make("openclaw-facetime-calls-");
    // 50 earlier calls: starting one more drops the oldest.
    for (let index = 0; index < 50; index += 1) {
      mkdirSync(join(recordsDir, `20260101T0000${String(index).padStart(2, "0")}Z-aaaaaaaa`));
    }
    const info = vi.fn();
    const trace = createFaceTimeCallTrace({
      callUUID: "98A409DB-DF13-4FD0-9C40-DB707E977FA6",
      logger: { info, warn: vi.fn(), error: vi.fn() },
      recordsDir,
    });
    trace.start({ heardMs: () => 0, queuedMs: () => 0 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

    trace.said("user", "what is on my screen");
    trace.looked("look attached a frame: 7 bytes, 40ms old", jpeg);
    trace.said("assistant", "a spreadsheet");
    trace.looked("look had no view: the call has ended");

    const folders = readdirSync(recordsDir).toSorted();
    expect(folders).toHaveLength(50);
    expect(folders[0]).toBe("20260101T000001Z-aaaaaaaa");
    const dir = join(recordsDir, folders.at(-1) ?? "");
    expect(folders.at(-1)).toMatch(/^\d{8}T\d{6}Z-98a409db$/u);
    await vi.waitFor(() => {
      const timeline = readFileSync(join(dir, "timeline.log"), "utf8");
      expect(timeline).toContain("call 98A409DB-DF13-4FD0-9C40-DB707E977FA6 started ");
      expect(timeline).toMatch(/\+\d+\.\d\ds caller said: what is on my screen\n/u);
      expect(timeline).toMatch(/\+\d+\.\d\ds agent said: a spreadsheet\n/u);
      expect(timeline).toContain("look-01.jpg saved");
      expect(timeline).toContain("look had no view: the call has ended");
    });
    expect(readFileSync(join(dir, "look-01.jpg"))).toEqual(jpeg);
    trace.stop("call media stopped: closed");

    const logged = info.mock.calls.map(([line]) => String(line)).join("\n");
    expect(logged).toContain("user transcript final: 20 chars");
    expect(logged).not.toContain("spreadsheet");
    expect(logged).not.toContain("my screen");
  });
});
