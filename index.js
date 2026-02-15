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

console.log("🚀 OmniFetch: Scavenger Pathfinder starting...");

if (fs.existsSync('cookies.txt')) {
    console.log("✅ cookies.txt detected. Pathfinder strength: HIGH.");
}

app.use(express.static(__dirname));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));

const YTDLP_PATH = './yt-dlp';

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 1. THE SCAVENGER: INFO & SEARCH ---
app.get('/info', (req, res) => {
    const userInput = req.query.url;
    if (!userInput) return res.status(400).json({ error: "Input required" });

    let target;
    if (userInput.startsWith('http')) {
        target = `"${userInput}"`;
    } else {
        // We use gvsearch1 (Google Video) to find matches on ANY site, not just YT.
        target = `gvsearch1:"${userInput}"`;
    }

    // Cleaned up the command: Removed the 'android' flags that were causing blocks
    // Added --no-check-certificates and --geo-bypass to help Render move around blocks
    let cmd = `${YTDLP_PATH} --dump-json --no-playlist --geo-bypass --no-check-certificates --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36" ${target}`;
    
    if (fs.existsSync('cookies.txt')) {
        cmd += ` --cookies cookies.txt`;
    }

    exec(cmd, (error, stdout, stderr) => {
        if (error || !stdout) {
            console.error("Scavenger Error:", stderr);
            return res.status(500).json({ error: "Access Denied. Try a direct link from Vimeo/Dailymotion instead of searching." });
        }

        try {
            const info = JSON.parse(stdout);
            res.json({ 
                title: info.title, 
                thumbnail: info.thumbnail,
                videoId: info.id, 
                url: info.webpage_url,
                duration: info.duration_string,
                source: info.extractor_key
            });
        } catch (err) {
            res.status(500).json({ error: "Found the file, but couldn't read the map." });
        }
    });
});

// --- 2. THE FETCHER: DOWNLOAD ---
app.get('/download', (req, res) => {
    const { url, quality, format, socketId } = req.query;
    if (!url) return res.status(400).send("Source URL required");

    const ext = format === 'mp3' ? 'mp3' : 'mp4';
    res.setHeader('Content-Disposition', `attachment; filename="OmniFetch_${Date.now()}.${ext}"`);
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');

    // Cleaned up flags here as well
    let args = [
        url, 
        '-o', '-', 
        '--no-check-certificates',
        '--geo-bypass',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36'
    ];

    if (fs.existsSync('cookies.txt')) {
        args.push('--cookies', 'cookies.txt');
    }

    if (format === 'mp3') {
        args.push('-x', '--audio-format', 'mp3');
    } else {
        let formatSelection = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
        if (quality === '1080p') formatSelection = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
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

    req.on('close', () => ls.kill());
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 OmniFetch Scavenger running on port ${PORT}`));