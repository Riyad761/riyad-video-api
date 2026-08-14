/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║        RIYAD VIDEO API — YouTube Search & Download            ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Drop-in replacement for the third-party "mahmud" API that vidio.js
 * currently calls. Same endpoint shapes, so vidio.js needs NO code
 * changes — just point its apiUrl at this server instead.
 *
 * Endpoints:
 *   GET /api/video/search?songName=<query>
 *     -> [ { id, title, duration, thumbnail }, ... ]
 *
 *   GET /api/video/download?link=<videoID>&format=mp4
 *     -> { downloadLink, title }
 *
 * Uses:
 *  - yt-search       -> find a YouTube video by name (no API key needed)
 *  - yt-dlp (binary)  -> resolve a direct, playable download URL
 */
"use strict";

const express = require("express");
const yts = require("yt-search");
const { execFile } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
//  Optional YouTube cookies (env var YOUTUBE_COOKIES, Netscape cookies.txt
//  format). YouTube heavily rate-limits/blocks cloud-provider IPs (429
//  errors) regardless of client emulation — the practical fix is sending
//  requests as a logged-in browser session via cookies. Written to disk
//  once at startup so yt-dlp can reference it with --cookies.
// ─────────────────────────────────────────────
const COOKIES_PATH = path.join(__dirname, "cookies.txt");
let hasCookies = false;
if (process.env.YOUTUBE_COOKIES && process.env.YOUTUBE_COOKIES.trim()) {
  try {
    fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES.trim() + "\n");
    hasCookies = true;
    console.log("✅ YouTube cookies loaded from YOUTUBE_COOKIES env var.");
  } catch (e) {
    console.error("⚠️ Failed to write cookies file:", e.message);
  }
} else {
  console.warn("⚠️ No YOUTUBE_COOKIES env var set — requests may hit 429 rate limits on cloud IPs.");
}

// ─────────────────────────────────────────────
//  GET /api/video/search?songName=...
// ─────────────────────────────────────────────
app.get("/api/video/search", async (req, res) => {
  const songName = req.query.songName;
  if (!songName) {
    return res.status(400).json({ error: "songName query param is required" });
  }

  try {
    const result = await yts(songName);
    const videos = (result.videos || []).slice(0, 10).map(v => ({
      id: v.videoId,
      title: v.title,
      duration: v.timestamp,
      thumbnail: v.thumbnail,
      url: v.url
    }));

    if (videos.length === 0) {
      return res.status(404).json([]);
    }
    return res.json(videos);
  } catch (err) {
    console.error("[search] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  GET /api/video/lyrics?songName=...
//  Same shape as /api/video/search, but searches "<songName> lyrics" and
//  prioritizes results whose title actually contains "lyric(s)" — so you
//  get lyric-video versions of the song instead of the regular MV/audio.
// ─────────────────────────────────────────────
app.get("/api/video/lyrics", async (req, res) => {
  const songName = req.query.songName;
  if (!songName) {
    return res.status(400).json({ error: "songName query param is required" });
  }

  try {
    const result = await yts(`${songName} lyrics`);
    const all = result.videos || [];

    // Prefer results whose title actually says "lyric(s)" — a plain
    // "<song> lyrics" search still returns some non-lyric-video results
    // mixed in (official MV, audio-only upload, etc).
    const lyricsOnly = all.filter(v => /lyrics?/i.test(v.title));
    const videos = (lyricsOnly.length ? lyricsOnly : all).slice(0, 10).map(v => ({
      id: v.videoId,
      title: v.title,
      duration: v.timestamp,
      thumbnail: v.thumbnail,
      url: v.url
    }));

    if (videos.length === 0) {
      return res.status(404).json([]);
    }
    return res.json(videos);
  } catch (err) {
    console.error("[lyrics] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  GET /api/video/download?link=<videoID or URL>&format=mp4
//
//  Resolves a direct, temporary googlevideo.com URL via yt-dlp
//  (much more reliable against YouTube's anti-bot changes than
//  pure-JS libraries like ytdl-core, which break often).
// ─────────────────────────────────────────────
function runYtDlp(url, formatArg) {
  return new Promise((resolve, reject) => {
    const args = [
      "-f", formatArg,
      "-g", "--no-playlist",
      "--print", "%(title)s",
      "--js-runtimes", "deno",
      // FIX: the "android" player client does NOT support cookies at all —
      // yt-dlp prints "Skipping client android since it does not support
      // cookies" and silently falls back to a client that then gets
      // bot-detected ("This video is unavailable"). "web" supports cookies
      // properly, which is the whole point of having YOUTUBE_COOKIES set.
      "--extractor-args", "youtube:player_client=web"
    ];
    if (hasCookies) args.push("--cookies", COOKIES_PATH);
    args.push(url);

    execFile(
      "yt-dlp",
      args,
      { timeout: 30000, maxBuffer: 1024 * 1024 * 5 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      }
    );
  });
}

async function resolveDownload(url, formatArg) {
  try {
    return await runYtDlp(url, formatArg);
  } catch (e) {
    // YouTube's shared cloud-IP rate limiting (429) is often transient —
    // one short retry clears it a meaningful fraction of the time.
    if (/429|Too Many Requests/i.test(e.message)) {
      await new Promise(r => setTimeout(r, 3000));
      return await runYtDlp(url, formatArg);
    }
    throw e;
  }
}

app.get("/api/video/download", async (req, res) => {
  const link = req.query.link;
  const format = (req.query.format || "mp4").toLowerCase();

  if (!link) {
    return res.status(400).json({ error: "link query param is required" });
  }

  const url = /^https?:\/\//i.test(link)
    ? link
    : `https://www.youtube.com/watch?v=${link}`;

  // format selection: best mp4 (video+audio muxed) by default, or bestaudio for mp3
  const formatArg = format === "mp3"
    ? "bestaudio/best"
    : "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";

  try {
    const stdout = await resolveDownload(url, formatArg);

    // yt-dlp with -g and --print prints: title first, then one URL per
    // selected stream (2 lines for separate video+audio, 1 for muxed/audio-only)
    const lines = stdout.trim().split(os.EOL).filter(Boolean);
    const title = lines[0] || "YouTube Video";
    const links = lines.slice(1);

    if (links.length === 0) {
      return res.status(500).json({ error: "No downloadable stream found" });
    }

    return res.json({
      downloadLink: links[0],
      title
    });
  } catch (err) {
    console.error("[download] yt-dlp error:", err.message);
    return res.status(500).json({ error: "yt-dlp failed", detail: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    cookiesLoaded: hasCookies,
    endpoints: ["/api/video/search?songName=", "/api/video/lyrics?songName=", "/api/video/download?link=&format="]
  });
});

app.listen(PORT, () => {
  console.log(`✅ Riyad Video API listening on port ${PORT}`);
});
