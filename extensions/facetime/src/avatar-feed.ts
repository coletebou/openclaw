import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import { isLoopbackHost } from "openclaw/plugin-sdk/gateway-runtime";
import {
  rejectWebSocketUpgrade,
  startWebSocketKeepalive,
  type WebSocket,
  WebSocketServer,
} from "openclaw/plugin-sdk/websocket-runtime";
import { createVoiceLevelAnalyzer, VOICE_LEVEL_HOP_MS } from "./avatar-voice-level.js";

export const FACETIME_AVATAR_PATH = "/facetime/avatar";
export const FACETIME_AVATAR_LOOP_PATH = `${FACETIME_AVATAR_PATH}/loop.mp4`;
// A viewer that stops reading is skipped instead of buffering voice levels it will show late.
const MAX_VIEWER_BUFFERED_BYTES = 256 * 1024;
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src blob:",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const LOOP_HEADERS = {
  "Content-Type": "video/mp4",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/** What the call's media path tells the avatar. Audio itself never leaves the Gateway. */
export type FaceTimeAvatarSink = {
  setCallActive: (active: boolean) => void;
  speak: (audio: Buffer, startsAtMs: number) => void;
  clear: () => void;
};

// The page and feed carry no secrets, but they show when the agent is on a call and speaking.
// Only a process on this Mac that connects straight to the Gateway may watch.
function isLocalViewer(req: IncomingMessage): boolean {
  const forwarded = Object.keys(req.headers).some(
    (header) =>
      header === "forwarded" || header === "x-real-ip" || header.startsWith("x-forwarded-"),
  );
  return !forwarded && isLoopbackHost(req.socket.remoteAddress ?? "");
}

/**
 * Serves the avatar page, its loop video and its view-only WebSocket feed on the Gateway.
 * Viewers receive the call state and scheduled voice levels; they send nothing back.
 */
export function createFaceTimeAvatarFeed(params: { pluginRoot: string }) {
  const viewers = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const analyze = createVoiceLevelAnalyzer();
  let callActive = false;
  let page: Promise<string> | undefined;

  const broadcast = (message: Record<string, unknown>) => {
    if (viewers.size === 0) {
      return;
    }
    const payload = JSON.stringify(message);
    for (const viewer of viewers) {
      if (viewer.readyState === viewer.OPEN && viewer.bufferedAmount < MAX_VIEWER_BUFFERED_BYTES) {
        viewer.send(payload);
      }
    }
  };

  return {
    async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      if (!isLocalViewer(req)) {
        res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden");
        return true;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain" }).end();
        return true;
      }
      if (new URL(req.url ?? "/", "http://localhost").pathname === FACETIME_AVATAR_LOOP_PATH) {
        // The page fetches the video once per load and loops it from memory. The video is a
        // build output: a package built without it answers 404 and the page shows a plain glow.
        const loop = await readFile(resolve(params.pluginRoot, "assets", "avatar-loop.mp4")).catch(
          () => undefined,
        );
        if (!loop) {
          res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
          return true;
        }
        res
          .writeHead(200, { ...LOOP_HEADERS, "Content-Length": loop.byteLength })
          .end(req.method === "HEAD" ? undefined : loop);
        return true;
      }
      page ??= readFile(resolve(params.pluginRoot, "assets", "avatar.html"), "utf8");
      res.writeHead(200, PAGE_HEADERS).end(req.method === "HEAD" ? undefined : await page);
      return true;
    },
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      if (!isLocalViewer(req)) {
        rejectWebSocketUpgrade(socket, { status: 403 });
        return true;
      }
      wss.handleUpgrade(req, socket, head, (viewer) => {
        viewers.add(viewer);
        startWebSocketKeepalive(viewer, () => viewer.terminate());
        viewer.on("error", () => viewer.terminate());
        viewer.on("close", () => viewers.delete(viewer));
        viewer.on("message", () => viewer.close(1003, "view_only"));
        viewer.send(
          JSON.stringify({ type: "hello", now: Date.now(), call: callActive ? "active" : "idle" }),
        );
      });
      return true;
    },
    sink: {
      setCallActive(active) {
        if (callActive === active) {
          return;
        }
        callActive = active;
        broadcast({ type: "call", state: active ? "active" : "idle" });
      },
      speak(audio, startsAtMs) {
        // Analysis keeps the loudness reference current even while nobody is watching.
        const levels = analyze(audio);
        if (levels.length > 0) {
          broadcast({
            type: "speak",
            at: Math.round(startsAtMs),
            hopMs: VOICE_LEVEL_HOP_MS,
            levels,
          });
        }
      },
      clear() {
        broadcast({ type: "clear" });
      },
    } satisfies FaceTimeAvatarSink,
    close() {
      for (const viewer of viewers) {
        viewer.close(1001, "avatar feed stopped");
      }
      viewers.clear();
    },
  };
}

export type FaceTimeAvatarFeed = ReturnType<typeof createFaceTimeAvatarFeed>;
