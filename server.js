/**
 * RIYAD VIDEO API - YouTube Search & Download
 * GET /api/video/search?songName=
 * GET /api/video/lyrics?songName=
 * GET /api/video/download?link=<videoID or URL>&format=mp4|mp3
 * GET /api/video/formats?link=<videoID or URL>   (debug: lists available formats)
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
// Resolved stream links stay valid for hours, so a longer cache makes
// repeat requests for the same video instant.
const DOWNLOAD_CACHE_TTL = 20 * 60 * 1000;
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

// Optional YouTube cookies (env var YOUTUBE_COOKIES, Netscape cookies.txt).
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
  console.warn("⚠️ No YOUTUBE_COOKIES env var set — requests may be blocked on cloud IPs.");
}

// ── search ──────────────────────────────────
function mapVideos(list) {
  return list.slice(0, 10).map((v) => ({
    id: v.videoId,
    title: v.title,
    duration: v.timestamp,
    thumbnail: youtubeThumbnail(v.videoId),
    url: v.url
  }));
}

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
      request = yts(songName)
        .then((result) => cacheSet(searchCache, key, mapVideos(result.videos || [])))
        .finally(() => searchInflight.delete(key));
      searchInflight.set(key, request);
    }

    const videos = await request;
    if (videos.length === 0) return res.status(404).json([]);
    return res.json(videos);
  } catch (err) {
    console.error("[search] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

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
      request = yts(`${songName} lyrics`)
        .then((result) => {
          const all = result.videos || [];
          const lyricsOnly = all.filter((v) => /lyrics?/i.test(v.title));
          return cacheSet(searchCache, key, mapVideos(lyricsOnly.length ? lyricsOnly : all));
        })
        .finally(() => searchInflight.delete(key));
      searchInflight.set(key, request);
    }

    const videos = await request;
    if (videos.length === 0) return res.status(404).json([]);
    return res.json(videos);
  } catch (err) {
    console.error("[lyrics] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── download via yt-dlp ─────────────────────
// clientArgs: extra yt-dlp args that choose the YouTube player client.
// useCookies: pass the cookies file or not.
function runYtDlp(url, formatArg, clientArgs, useCookies) {
  return new Promise((resolve, reject) => {
    const args = [
      "-f", formatArg,
      "-g", "--no-playlist",
      "--print", "%(title)s",
      "--no-warnings",
      "--js-runtimes", "deno",
      ...(clientArgs || [])
    ];
    if (useCookies && hasCookies) args.push("--cookies", COOKIES_PATH);
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

// Try several player clients one by one. Forcing a single client (web)
// can leave no usable formats, so start with yt-dlp's own defaults.
const CLIENT_ATTEMPTS = [
  [],
  ["--extractor-args", "youtube:player_client=web_safari"],
  ["--extractor-args", "youtube:player_client=mweb"]
];

// Errors that mean "the cookies are the problem" -> other clients with the
// same cookies will not help, so move on to the no-cookies mode.
const COOKIE_PROBLEM_RE = /Sign in to confirm|page needs to be reloaded/i;

async function resolveDownload(url, formatArg) {
  // 1st pass: with cookies (if any). 2nd pass: without cookies, because
  // stale/rotated cookies cause "The page needs to be reloaded" even for
  // videos that would work fine anonymously.
  const modes = hasCookies ? [true, false] : [false];
  let firstErr = null;
  let lastErr = null;

  for (const useCookies of modes) {
    for (const clientArgs of CLIENT_ATTEMPTS) {
      try {
        return await runYtDlp(url, formatArg, clientArgs, useCookies);
      } catch (e) {
        // transient rate limit: one short retry with the same client
        if (/429|Too Many Requests/i.test(e.message)) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            return await runYtDlp(url, formatArg, clientArgs, useCookies);
          } catch (e2) {
            e = e2;
          }
        }
        if (!firstErr) firstErr = e;
        lastErr = e;
        if (COOKIE_PROBLEM_RE.test(e.message)) {
          console.warn(`[download] cookie problem (useCookies=${useCookies}):`, e.message.slice(0, 200));
          break;
        }
      }
    }
  }

  if (firstErr && lastErr && firstErr !== lastErr) {
    throw new Error(`${firstErr.message}\n--- last attempt ---\n${lastErr.message}`);
  }
  throw firstErr || lastErr;
}

function toUrl(link) {
  return /^https?:\/\//i.test(link)
    ? link
    : `https://www.youtube.com/watch?v=${link}`;
}

app.get("/api/video/download", async (req, res) => {
  const link = String(req.query.link || "").trim();
  const format = (req.query.format || "mp4").toLowerCase();

  if (!link) {
    return res.status(400).json({ error: "link query param is required" });
  }

  const url = toUrl(link);

  // One playable stream only (the bot downloads a single URL).
  // Only plain https files (no HLS/DASH manifests): "ext=mp4" alone also
  // matches HLS playlists, which are not real video files.
  // Format 18 = 360p mp4 with audio in ONE file -> small + fast, no ffmpeg.
  const formatArg = format === "mp3"
    ? "bestaudio[ext=m4a][protocol=https]/bestaudio[protocol=https]/bestaudio"
    : "18/best[ext=mp4][protocol=https][height<=480]/best[ext=mp4][protocol=https]/best[protocol=https]";
  const cacheKey = `${url}::${format}`;

  try {
    const cached = cacheGet(downloadCache, cacheKey, DOWNLOAD_CACHE_TTL);
    if (cached) return res.json(cached);

    let request = downloadInflight.get(cacheKey);
    if (!request) {
      request = resolveDownload(url, formatArg)
        .then((stdout) => {
          const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
          const title = lines[0] || "YouTube Video";
          const links = lines.slice(1);
          if (links.length === 0) throw new Error("No downloadable stream found");
          if (/\.m3u8|manifest\.googlevideo\.com/i.test(links[0])) {
            throw new Error("Only streaming (HLS) formats available for this video");
          }
          return cacheSet(downloadCache, cacheKey, { downloadLink: links[0], title });
        })
        .finally(() => downloadInflight.delete(cacheKey));
      downloadInflight.set(cacheKey, request);
    }

    return res.json(await request);
  } catch (err) {
    console.error("[download] yt-dlp error:", err.message);
    return res.status(500).json({ error: "yt-dlp failed", detail: err.message });
  }
});

// Debug: shows which formats YouTube offers for a video.
// Add &nocookies=1 to test without the cookies file.
app.get("/api/video/formats", (req, res) => {
  const link = String(req.query.link || "").trim();
  if (!link) return res.status(400).json({ error: "link query param is required" });

  const args = ["-F", "--no-playlist", "--no-warnings", "--js-runtimes", "deno"];
  if (hasCookies && req.query.nocookies !== "1") args.push("--cookies", COOKIES_PATH);
  args.push(toUrl(link));

  execFile("yt-dlp", args, { timeout: 30000, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
    const out = String(stdout || "");
    res.type("text/plain").send(
      err ? `ERROR:\n${String(stderr || err.message).slice(0, 1500)}` : out.slice(-3500)
    );
  });
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    cookiesLoaded: hasCookies,
    endpoints: [
      "/api/video/search?songName=",
      "/api/video/lyrics?songName=",
      "/api/video/download?link=&format=",
      "/api/video/formats?link="
    ]
  });
});

app.listen(PORT, () => {
  console.log(`✅ Riyad Video API listening on port ${PORT}`);
});
