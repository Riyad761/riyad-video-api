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

const app = express();
const PORT = process.env.PORT || 3000;

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
//  GET /api/video/download?link=<videoID or URL>&format=mp4
//
//  Resolves a direct, temporary googlevideo.com URL via yt-dlp
//  (much more reliable against YouTube's anti-bot changes than
//  pure-JS libraries like ytdl-core, which break often).
// ─────────────────────────────────────────────
function runYtDlp(url, formatArg) {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      [
        "-f", formatArg,
        "-g", "--no-playlist",
        "--print", "%(title)s",
        "--js-runtimes", "deno",
        "--extractor-args", "youtube:player_client=android",
        url
      ],
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
    ? "bestaudio"
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
  res.json({ status: "ok", endpoints: ["/api/video/search?songName=", "/api/video/download?link=&format="] });
});

app.listen(PORT, () => {
  console.log(`✅ Riyad Video API listening on port ${PORT}`);
});
