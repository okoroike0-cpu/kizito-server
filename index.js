const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { spawn, exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));

const YTDLP_PATH = 'yt-dlp';

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// /api/info — Universal Scavenger
// ==========================================
app.get('/api/info', (req, res) => {
    const userInput = req.query.url;
    if (!userInput) return res.status(400).json({ error: "Input required" });

    // FIX: properly quote search queries vs raw URLs
    let target;
    if (userInput.startsWith('http')) {
        target = `"${userInput}"`;
    } else {
        // Already formatted as gvsearch1:... by the client
        target = userInput;
    }

    let cmd = `${YTDLP_PATH} --dump-json --no-playlist --no-check-certificates --geo-bypass ` +
              `--impersonate chrome ` +
              `--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36" ` +
              `--referer "https://www.google.com" ${target}`;

    if (fs.existsSync('cookies.txt')) {
        cmd += ` --cookies cookies.txt`;
    }

    exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error || !stdout.trim()) {
            console.error("Scavenger Error:", stderr?.slice(0, 500));
            const isBlocked = (stderr || '').includes("403") || (stderr || '').includes("Forbidden");
            return res.status(500).json({
                error: isBlocked
                    ? "Site access forbidden (403). Try a different link."
                    : "Pathfinder failed. Try a different search term."
            });
        }
        try {
            // yt-dlp may return multiple JSON lines for playlists; take the first
            const firstLine = stdout.trim().split('\n')[0];
            const info = JSON.parse(firstLine);
            res.json({
                success: true,
                title: info.title || 'Unknown Title',
                thumbnail: info.thumbnail || null,
                videoId: info.id || null,
                url: info.webpage_url || info.url || userInput,
                duration: info.duration_string || null,
                source: info.extractor_key || null
            });
        } catch (err) {
            console.error("JSON Parse Error:", err.message);
            res.status(500).json({ error: "Could not parse media data." });
        }
    });
});

// ==========================================
// /api/trending — TMDB Proxy
// ==========================================
app.get('/api/trending', async (req, res) => {
    const TMDB_TOKEN = process.env.TMDB_TOKEN;
    if (!TMDB_TOKEN) return res.status(500).json({ error: "TMDB_TOKEN not set in environment" });

    try {
        const response = await fetch('https://api.themoviedb.org/3/trending/movie/day?language=en-US', {
            headers: {
                accept: 'application/json',
                Authorization: `Bearer ${TMDB_TOKEN}`
            }
        });
        if (!response.ok) throw new Error(`TMDB responded with ${response.status}`);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error("Trending Error:", err.message);
        res.status(500).json({ error: "Failed to fetch trending movies" });
    }
});

// ==========================================
// /api/search — TMDB Search Proxy
// ==========================================
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    const TMDB_TOKEN = process.env.TMDB_TOKEN;

    if (!query) return res.status(400).json({ error: "Search query required" });
    if (!TMDB_TOKEN) return res.status(500).json({ error: "TMDB_TOKEN not set in environment" });

    try {
        const response = await fetch(
            `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(query)}&language=en-US&page=1`,
            {
                headers: {
                    accept: 'application/json',
                    Authorization: `Bearer ${TMDB_TOKEN}`
                }
            }
        );
        if (!response.ok) throw new Error(`TMDB responded with ${response.status}`);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error("Search Proxy Error:", err.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// ==========================================
// /download — Stream Download to Client
// FIX: now correctly reads format & socketId,
//      sends real-time progress via socket.io
// ==========================================
app.get('/download', (req, res) => {
    const { url, format, socketId } = req.query;

    if (!url) return res.status(400).send("Source URL required");

    const isAudio = format === 'mp3';
    const ext = isAudio ? 'mp3' : 'mp4';
    const safeFilename = `OmniFetch_${Date.now()}.${ext}`;

    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
    // Allow client to see download progress
    res.setHeader('X-Content-Type-Options', 'nosniff');

    let args = [
        url,
        '-o', '-',                          // pipe to stdout
        '--no-check-certificates',
        '--no-part',
        '--impersonate', 'chrome',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    ];

    if (fs.existsSync('cookies.txt')) {
        args.push('--cookies', 'cookies.txt');
    }

    if (isAudio) {
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
        // FIX: format is now correctly passed from client (480, 720, 1080, etc.)
        const height = format || '480';
        const formatSelection = `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/best[height<=${height}]/best`;
        args.push('-f', formatSelection);
    }

    console.log(`Download: format=${format}, socketId=${socketId}, url=${url.slice(0, 60)}...`);

    const ytdlp = spawn(YTDLP_PATH, args);

    // Pipe video data to client
    ytdlp.stdout.pipe(res);

    // FIX: parse progress and emit to the correct socket
    ytdlp.stderr.on('data', (chunk) => {
        const line = chunk.toString();
        const match = line.match(/(\d+\.?\d*)%/);
        if (match && socketId) {
            const percent = parseFloat(match[1]);
            io.to(socketId).emit('progress', { percent });
        }
    });

    ytdlp.on('error', (err) => {
        console.error("yt-dlp spawn error:", err.message);
        if (!res.headersSent) {
            res.status(500).send("Download failed: could not start yt-dlp");
        }
    });

    ytdlp.on('close', (code) => {
        console.log(`yt-dlp exited with code ${code}`);
        // Send 100% completion signal
        if (socketId) io.to(socketId).emit('progress', { percent: 100 });
    });

    // Kill yt-dlp if client disconnects
    req.on('close', () => {
        ytdlp.kill('SIGTERM');
        console.log("Client disconnected — yt-dlp killed");
    });
});

// ==========================================
// Socket.IO connection tracking
// ==========================================
io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);
    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
    });
});

// ==========================================
// Start server
// ==========================================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 OmniFetch running on port ${PORT}`);
    if (!process.env.TMDB_TOKEN) {
        console.warn("⚠️  WARNING: TMDB_TOKEN environment variable is not set. Trending and Search will not work.");
    }
});