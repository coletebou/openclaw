import { createWriteStream, mkdirSync, readdirSync, rmSync, writeFile } from "node:fs";
import { join } from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";

const METER_INTERVAL_MS = 1_000;
const SILENCE_DBFS = -90;
// Call records hold what was said and seen. Only the newest calls are kept.
const MAX_CALL_RECORDS = 50;
// The provider events that mark turn-taking or a change in the session. Everything else a
// provider emits (a line per audio packet or per token, on some connections) stays out.
const TIMELINE_PROVIDER_EVENT = new RegExp(
  "^(?:error" +
    "|input_audio_buffer\\.(?:speech_started|speech_stopped|committed|cleared|timeout_triggered)" +
    "|output_audio_buffer\\.(?:started|stopped|cleared)" +
    "|response\\.(?:create|created|cancel|done)" +
    "|conversation\\.item\\.truncated?" +
    "|session\\.(?:created|updated|close|rotation|rotation\\.ready|continuity\\.reset)" +
    "|tool_call\\.arguments\\.rejected)$",
  "u",
);

type Level = { squares: number; peak: number; samples: number };

const emptyLevel = (): Level => ({ squares: 0, peak: 0, samples: 0 });

function measure(level: Level, pcm: Buffer) {
  for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
    const sample = Math.abs(pcm.readInt16LE(offset)) / 32_768;
    level.squares += sample * sample;
    if (sample > level.peak) {
      level.peak = sample;
    }
  }
  level.samples += pcm.byteLength >> 1;
}

const dbfs = (linear: number) =>
  linear > 0 ? Math.max(SILENCE_DBFS, 20 * Math.log10(linear)) : SILENCE_DBFS;

/** RMS over peak in dBFS, or "none" when no audio arrived in the interval. */
function describe(level: Level): string {
  return level.samples === 0
    ? "none"
    : `${dbfs(Math.sqrt(level.squares / level.samples)).toFixed(1)}/${dbfs(level.peak).toFixed(1)}dBFS`;
}

/** Opens this call's folder under `recordsDir` and drops the folders of the oldest calls. */
function openCallRecord(params: {
  recordsDir: string;
  call: string;
  startedAt: number;
  logger: RuntimeLogger;
}) {
  try {
    mkdirSync(params.recordsDir, { recursive: true, mode: 0o700 });
    // Folder names start with the UTC start time, so they sort oldest first.
    const stamp = new Date(params.startedAt).toISOString().replace(/[-:]|\.\d+/gu, "");
    const dir = join(params.recordsDir, `${stamp}-${params.call}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const old of readdirSync(params.recordsDir).toSorted().slice(0, -MAX_CALL_RECORDS)) {
      rmSync(join(params.recordsDir, old), { recursive: true, force: true });
    }
    const timeline = createWriteStream(join(dir, "timeline.log"), { flags: "a", mode: 0o600 });
    timeline.on("error", (error) =>
      params.logger.warn(`[facetime] call record stopped: ${formatErrorMessage(error)}`),
    );
    return { dir, timeline };
  } catch (error) {
    params.logger.warn(`[facetime] call record not started: ${formatErrorMessage(error)}`);
    return undefined;
  }
}

/**
 * Writes one call's timeline, for tuning: when the caller and the model start and stop, what
 * was interrupted and how much of it was heard, how long tools took, and the audio levels of
 * each second.
 *
 * The Gateway log gets timings, sizes and levels only, never words or pixels. Each line there
 * starts with "[facetime] trace <call> +<seconds since the call session started>".
 *
 * With `recordsDir` set (the `callRecords.enabled` setting), the same timeline also goes to a
 * folder for this call, together with what was said and each frame the model looked at.
 */
export function createFaceTimeCallTrace(params: {
  callUUID: string;
  logger: RuntimeLogger;
  recordsDir?: string;
}) {
  const startedAt = Date.now();
  const call = params.callUUID.slice(0, 8).toLowerCase();
  let record: ReturnType<typeof openCallRecord>;
  let meter: NodeJS.Timeout | undefined;
  let input = emptyLevel();
  let output = emptyLevel();
  let looks = 0;
  let stopped = false;
  let speaking = false;
  const tools = new Map<string, { name: string; calledAt: number }>();
  let playback: { heardMs: () => number; queuedMs: () => number } | undefined;
  // What cutting the model off costs: how much of the response was heard, and how much
  // queued speech is thrown away.
  const cutSpeech = () =>
    `${Math.round(playback?.heardMs() ?? 0)}ms heard, ${Math.round(playback?.queuedMs() ?? 0)}ms dropped`;
  const elapsed = () => `+${((Date.now() - startedAt) / 1000).toFixed(2)}s`;
  const recordLine = (text: string) => {
    if (!stopped) {
      record?.timeline.write(`${elapsed()} ${text}\n`);
    }
  };
  const write = (text: string) => {
    params.logger.info(`[facetime] trace ${call} ${elapsed()} ${text}`);
    recordLine(text);
  };
  return {
    /**
     * Opens the call record and starts the once-a-second level lines. Called when the call's
     * audio exists. `heardMs` is how much of the current response the caller has heard,
     * `queuedMs` how much model speech is queued behind it.
     */
    start: (source: { heardMs: () => number; queuedMs: () => number }) => {
      playback = source;
      if (stopped || meter) {
        return;
      }
      if (params.recordsDir) {
        record = openCallRecord({
          recordsDir: params.recordsDir,
          call,
          startedAt,
          logger: params.logger,
        });
        record?.timeline.write(
          `call ${params.callUUID} started ${new Date(startedAt).toISOString()}\n`,
        );
      }
      write("call session started");
      meter = setInterval(() => {
        // in: caller audio as sent to the model. out: model audio as queued for the caller.
        write(
          `levels in=${describe(input)} out=${describe(output)} queued=${Math.round(source.queuedMs())}ms`,
        );
        input = emptyLevel();
        output = emptyLevel();
      }, METER_INTERVAL_MS);
      meter.unref();
    },
    event: write,
    inputAudio: (pcm: Buffer) => measure(input, pcm),
    outputAudio: (pcm: Buffer) => {
      if (!speaking) {
        speaking = true;
        write("model audio started");
      }
      measure(output, pcm);
    },
    /** The model's speech ended: finished, interrupted, superseded or failed. */
    speechEnded: (how: string) => {
      // An interruption clears the audio first and the provider reports the cancelled
      // response afterwards. Only the first of the two still has speech to account for.
      write(speaking ? `${how}: ${cutSpeech()}` : how);
      speaking = false;
    },
    /**
     * One line per provider event that marks turn-taking or a session change. Speech start
     * and stop carry the caller's level since the last meter line and what the model was doing.
     */
    providerEvent: (event: { direction: string; type: string; detail?: string }) => {
      if (!TIMELINE_PROVIDER_EVENT.test(event.type)) {
        return;
      }
      const extra = event.type.startsWith("input_audio_buffer.speech_")
        ? ` in=${describe(input)} ${cutSpeech()}`
        : event.type === "error" && event.detail
          ? ` ${event.detail}`
          : "";
      write(`provider ${event.direction}:${event.type}${extra}`);
    },
    /**
     * Times tools from the talk events the call already emits, and passes the event through.
     * A consult returns to the model at once and delivers its answer later, so only its
     * result event marks the end.
     */
    talkEvent: <T extends { type: string; callId?: string; payload?: unknown }>(event: T): T => {
      const callId = event.callId;
      if (callId && event.type === "tool.call") {
        const payload = event.payload;
        const name =
          typeof payload === "object" && payload !== null && "name" in payload
            ? String(payload.name)
            : "tool";
        tools.set(callId, { name, calledAt: Date.now() });
        write(`tool call ${name}`);
      } else if (callId && (event.type === "tool.result" || event.type === "tool.error")) {
        const tool = tools.get(callId);
        if (tool) {
          tools.delete(callId);
          write(
            `tool ${tool.name} ${event.type === "tool.error" ? "failed" : "answered"} after ${Date.now() - tool.calledAt}ms`,
          );
        }
      }
      return event;
    },
    /** A finished utterance. Its words go to the call record only. */
    said: (role: string, text: string) => {
      params.logger.info(
        `[facetime] trace ${call} ${elapsed()} ${role} transcript final: ${text.length} chars`,
      );
      recordLine(`${role === "assistant" ? "agent" : "caller"} said: ${text}`);
    },
    /** One look by the model. The frame it was shown goes to the call record only. */
    looked: (detail: string, jpeg?: Buffer) => {
      write(detail);
      if (record && jpeg) {
        looks += 1;
        const name = `look-${String(looks).padStart(2, "0")}.jpg`;
        writeFile(join(record.dir, name), jpeg, { mode: 0o600 }, (error) =>
          recordLine(error ? `${name} not saved: ${formatErrorMessage(error)}` : `${name} saved`),
        );
      }
    },
    stop: (why: string) => {
      if (stopped) {
        return;
      }
      write(why);
      clearInterval(meter);
      stopped = true;
      record?.timeline.end();
    },
  };
}
