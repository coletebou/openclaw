#!/usr/bin/env node
// Renders assets/avatar-loop.mp4, the looping picture behind the avatar page.
//
//   node render.mjs --stills=0,0.25,0.5 --out=<dir>     a few frames, to check the look
//   node render.mjs --out=<dir>                         every frame, then encode the video
//   node render.mjs --encode-only --out=<dir>           encode frames already in <dir>
//
// Needs Google Chrome (or CHROME=<path>) and ffmpeg. Chrome runs headless with its own
// throwaway profile. Extra --key=value options pass through to render.html.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "1"];
  }),
);
const outDir = resolve(args.out ?? "avatar-loop-frames");
const video = resolve(args.video ?? join(here, "..", "..", "assets", "avatar-loop.mp4"));
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(outDir, { recursive: true });

function run(command, commandArgs) {
  return new Promise((done, fail) => {
    const child = spawn(command, commandArgs, { stdio: "inherit" });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? done() : fail(new Error(`${command} exited ${code}`)),
    );
  });
}

async function renderFrames() {
  const page = readFileSync(join(here, "render.html"));
  let finish;
  const finished = new Promise((done) => {
    finish = done;
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/frame/")) {
      await pipeline(req, createWriteStream(join(outDir, basename(url.pathname))));
      res.writeHead(204).end();
      return;
    }
    if (req.method === "POST" && (url.pathname === "/log" || url.pathname === "/done")) {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      res.writeHead(204).end();
      if (url.pathname === "/log") {
        console.log(body);
      } else {
        finish(body);
      }
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const query = new URLSearchParams(
    Object.entries(args).filter(([key]) => !["out", "video", "encode-only"].includes(key)),
  );
  const profile = mkdtempSync(join(tmpdir(), "avatar-loop-chrome-"));
  const browser = spawn(
    chrome,
    [
      "--headless=new",
      "--use-angle=metal",
      "--ignore-gpu-blocklist",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--window-size=1920,1080",
      `--user-data-dir=${profile}`,
      `http://127.0.0.1:${server.address().port}/?${query}`,
    ],
    { stdio: "ignore" },
  );
  const closed = once(browser, "close").then(() => "browser closed");
  const result = await Promise.race([finished, closed]);
  browser.kill();
  await closed;
  server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (result !== "ok") {
    throw new Error(`render failed: ${result}`);
  }
}

if (!args["encode-only"]) {
  await renderFrames();
}
if (!args.stills) {
  // One GOP per second keeps the file small; the page plays it start to end and never seeks.
  await run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-framerate",
    "30",
    "-i",
    join(outDir, "f%05d.png"),
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    // Four reference frames keep the stream at level 5.0, which hardware decoders take.
    "-refs",
    "4",
    "-crf",
    args.crf ?? "24",
    // spend bits on the dark gradients, where blocking shows first
    "-x264-params",
    "aq-mode=3",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-g",
    "30",
    "-an",
    "-movflags",
    "+faststart",
    video,
  ]);
  console.log(`wrote ${video}`);
}
