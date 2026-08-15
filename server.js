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
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const DOWNLOAD_CACHE_TTL = 90 * 1000;
const searchCache = new Map();
const searchInflight = new Map();
const downloadCache = new Map();
const downloadInflight = new Map();

function cacheGet(cache, key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > ttl) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(cache, key, value) {
  cache.set(key, { value, createdAt: Date.now() });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return value;
}

function youtubeThumbnail(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

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
  const songName = String(req.query.songName || "").trim();
  if (!songName) {
    return res.status(400).json({ error: "songName query param is required" });
  }

  try {
    const key = songName.toLowerCase();
    const cached = cacheGet(searchCache, key, SEARCH_CACHE_TTL);
    if (cached) return res.json(cached);

    let request = searchInflight.get(key);
    if (!request) {
      request = yts(songName).then((result) => {
        const videos = (result.videos || []).slice(0, 10).map(v => ({
          id: v.videoId,
          title: v.title,
          duration: v.timestamp,
          // Small thumbnails make the numbered collage much faster.
          thumbnail: youtubeThumbnail(v.videoId),
          url: v.url
        }));
        return cacheSet(searchCache, key, videos);
      }).finally(() => searchInflight.delete(key));
      searchInflight.set(key, request);
    }

    const videos = await request;

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
  const songName = String(req.query.songName || "").trim();
  if (!songName) {
    return res.status(400).json({ error: "songName query param is required" });
  }

  try {
    const key = `${songName.toLowerCase()}::lyrics`;
    const cached = cacheGet(searchCache, key, SEARCH_CACHE_TTL);
    if (cached) return res.json(cached);

    let request = searchInflight.get(key);
    if (!request) {
      request = yts(`${songName} lyrics`).then((result) => {
        const all = result.videos || [];

        // Prefer results whose title actually says "lyric(s)".
        const lyricsOnly = all.filter(v => /lyrics?/i.test(v.title));
        const videos = (lyricsOnly.length ? lyricsOnly : all).slice(0, 10).map(v => ({
          id: v.videoId,
          title: v.title,
          duration: v.timestamp,
          thumbnail: youtubeThumbnail(v.videoId),
          url: v.url
        }));
        return cacheSet(searchCache, key, videos);
      }).finally(() => searchInflight.delete(key));
      searchInflight.set(key, request);
    }

    const videos = await request;

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
      "--no-warnings",
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
  const link = String(req.query.link || "").trim();
  const format = (req.query.format || "mp4").toLowerCase();

  if (!link) {
    return res.status(400).json({ error: "link query param is required" });
  }

  const url = /^https?:\/\//i.test(link)
    ? link
    : `https://www.youtube.com/watch?v=${link}`;

  // Return one playable stream. Asking for bestvideo+bestaudio here can
  // produce two URLs, while the bot can only download one URL.
  const formatArg = format === "mp3"
    ? "bestaudio/best"
    : "best[ext=mp4]/best";
  const cacheKey = `${url}::${format}`;

  try {
    const cached = cacheGet(downloadCache, cacheKey, DOWNLOAD_CACHE_TTL);
    if (cached) return res.json(cached);

    let request = downloadInflight.get(cacheKey);
    if (!request) {
      request = resolveDownload(url, formatArg).then((stdout) => {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const title = lines[0] || "YouTube Video";
        const links = lines.slice(1);

        if (links.length === 0) {
          throw new Error("No downloadable stream found");
        }

        return cacheSet(downloadCache, cacheKey, {
          downloadLink: links[0],
          title
        });
      }).finally(() => downloadInflight.delete(cacheKey));
      downloadInflight.set(cacheKey, request);
    }

    return res.json(await request);
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
