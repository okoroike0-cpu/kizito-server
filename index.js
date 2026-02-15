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

// Branding Update: OmniFetch Server Identity
console.log("🚀 OmniFetch: Universal Media Pathfinder starting...");

// Verify Cookie Status for YouTube/Restricted Sites
if (fs.existsSync('cookies.txt')) {
    console.log("✅ cookies.txt detected. Pathfinder strength: HIGH.");
} else {
    console.log("⚠️ No cookies.txt found. Using public pathfinder mode.");
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

// --- 1. THE PATHFINDER: GET INFO OR SEARCH ---
app.get('/info', (req, res) => {
    const userInput = req.query.url;
    if (!userInput) return res.status(400).json({ error: "Input (URL or Name) is required" });

    // OmniFetch Logic: Detect if link or name
    // If it doesn't start with http, we search YouTube (best universal source)
    let target = userInput.startsWith('http') ? `"${userInput}"` : `ytsearch1:"${userInput}"`;

    // Using Android/Web embedded clients for max bypass potential
    let cmd = `${YTDLP_PATH} --dump-json --no-playlist --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36" --extractor-args "youtube:player-client=android_embedded,web_embedded;player-params=2" ${target}`;
    
    if (fs.existsSync('cookies.txt')) {
        cmd += ` --cookies cookies.txt`;
    }

    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            console.error("Pathfinder Error:", stderr);
            return res.status(500).json({ error: "Path blocked by host. Try a different site link (Vimeo/Dailymotion)!" });
        }

        try {
            const info = JSON.parse(stdout);
            res.json({ 
                title: info.title, 
                thumbnail: info.thumbnail,
                videoId: info.id, 
                url: info.webpage_url, // Send actual URL back for downloading
                duration: info.duration_string,
                source: info.extractor_key
            });
        } catch (err) {
            res.status(500).json({ error: "Failed to parse found media." });
        }
    });
});

// --- 2. THE FETCHER: DOWNLOAD & STREAM ---
app.get('/download', (req, res) => {
    const { url, quality, format, socketId } = req.query;
    if (!url) return res.status(400).send("Source URL required");

    const ext = format === 'mp3' ? 'mp3' : 'mp4';
    res.setHeader('Content-Disposition', `attachment; filename="OmniFetch_${Date.now()}.${ext}"`);
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');

    let args = [
        url, 
        '-o', '-', 
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        '--extractor-args', 'youtube:player-client=android_embedded,web_embedded;player-params=2'
    ];

    if (fs.existsSync('cookies.txt')) {
        args.push('--cookies', 'cookies.txt');
    }

    if (format === 'mp3') {
        args.push('-x', '--audio-format', 'mp3');
    } else {
        // Multi-source format logic
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
        console.log(`Fetch completed with code ${code}`);
    });

    req.on('close', () => {
        ls.kill(); 
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 OmniFetch Pathfinder Server running on port ${PORT}`);
});