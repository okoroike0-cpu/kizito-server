const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http'); 
const { Server } = require('socket.io');
const { spawn, exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" } 
});

app.use(express.static(__dirname));
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'], 
    exposedHeaders: ['Content-Length', 'Content-Type', 'Content-Disposition'] 
}));

// Path to your yt-dlp binary (downloaded via the Render Build Command)
const YTDLP_PATH = './yt-dlp';

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 1. GET VIDEO INFO ---
app.get('/info', (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: "URL is required" });

    // yt-dlp command to get metadata in JSON format
    // Added --cookies cookies.json if it exists
    let cmd = `${YTDLP_PATH} --dump-json --no-playlist "${videoUrl}"`;
    if (fs.existsSync('cookies.json')) cmd += ` --cookies cookies.json`;

    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            console.error("Info Error:", stderr);
            return res.status(500).json({ error: "YouTube blocked the request or URL is invalid." });
        }

        try {
            const info = JSON.parse(stdout);
            res.json({ 
                title: info.title, 
                thumbnail: info.thumbnail,
                videoId: info.id, 
                size: "Calculating...", // yt-dlp calculates size during actual download
                duration: info.duration_string
            });
        } catch (err) {
            res.status(500).json({ error: "Failed to parse video data." });
        }
    });
});

// --- 2. DOWNLOAD & STREAM ---
app.get('/download', (req, res) => {
    const { url, quality, format, socketId } = req.query;

    if (!url) return res.status(400).send("URL is required");

    // Define filename and extension
    const ext = format === 'mp3' ? 'mp3' : 'mp4';
    
    // Set headers for browser download
    res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"`);
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');

    // Build arguments for yt-dlp
    let args = [url, '-o', '-']; // '-o -' tells it to stream to stdout (standard output)

    if (fs.existsSync('cookies.json')) {
        args.push('--cookies', 'cookies.json');
    }

    if (format === 'mp3') {
        args.push('-x', '--audio-format', 'mp3');
    } else {
        // Quality logic: 1080p, 720p, or best
        let formatSelection = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
        if (quality === '1080p') formatSelection = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
        if (quality === '720p') formatSelection = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
        args.push('-f', formatSelection);
    }

    // Use 'spawn' instead of 'exec' for streaming (better for large files)
    const ls = spawn(YTDLP_PATH, args);

    // Pipe the data directly to the user's browser
    ls.stdout.pipe(res);

    // Track progress via stderr (yt-dlp sends status updates here)
    ls.stderr.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/(\d+\.\d+)%/); // Search for progress percentage
        if (match && socketId) {
            io.to(socketId).emit('progress', { percent: match[1] });
        }
    });

    ls.on('close', (code) => {
        console.log(`Download process exited with code ${code}`);
    });

    // Handle user cancelling the download
    req.on('close', () => {
        ls.kill();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Kizito Server (yt-dlp) running on port ${PORT}`);
});