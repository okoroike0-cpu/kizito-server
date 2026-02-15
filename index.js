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

console.log("🚀 Video Converter Server starting...");
if (fs.existsSync('cookies.txt')) {
    console.log("✅ cookies.txt found and loaded.");
}

app.use(express.static(__dirname));
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'], 
    exposedHeaders: ['Content-Length', 'Content-Type', 'Content-Disposition'] 
}));

const YTDLP_PATH = './yt-dlp';

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 1. GET VIDEO INFO ---
app.get('/info', (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: "URL is required" });

    // FIXED: Removed --allow-unsecure-commands. Added impersonate for extra stealth.
    let cmd = `${YTDLP_PATH} --dump-json --no-playlist --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36" --extractor-args "youtube:player-client=web,default" "${videoUrl}"`;
    
    if (fs.existsSync('cookies.txt')) {
        cmd += ` --cookies cookies.txt`;
    }

    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            console.error("Info Error:", stderr);
            return res.status(500).json({ error: "YouTube is blocking the server. Please refresh cookies.txt on Render!" });
        }

        try {
            const info = JSON.parse(stdout);
            res.json({ 
                title: info.title, 
                thumbnail: info.thumbnail,
                videoId: info.id, 
                size: "Calculating...", 
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

    const ext = format === 'mp3' ? 'mp3' : 'mp4';
    res.setHeader('Content-Disposition', `attachment; filename="video.${ext}"`);
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');

    // FIXED: Match the info route flags
    let args = [url, '-o', '-', '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36', '--extractor-args', 'youtube:player-client=web,default'];

    if (fs.existsSync('cookies.txt')) {
        args.push('--cookies', 'cookies.txt');
    }

    if (format === 'mp3') {
        args.push('-x', '--audio-format', 'mp3');
    } else {
        let formatSelection = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
        if (quality === '1080p') formatSelection = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
        if (quality === '720p') formatSelection = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
        args.push('-f', formatSelection);
    }

    const ls = spawn(YTDLP_PATH, args);
    ls.stdout.pipe(res);

    ls.stderr.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/(\d+\.\d+)%/);
        if (match && socketId) {
            io.to(socketId).emit('progress', { percent: match[1] });
        }
    });

    ls.on('close', (code) => {
        console.log(`Process exited with code ${code}`);
    });

    req.on('close', () => {
        ls.kill();
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 Video Converter Server (yt-dlp) running on port ${PORT}`);
});