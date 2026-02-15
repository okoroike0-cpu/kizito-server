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

console.log("🚀 OmniFetch: Scavenger Pathfinder starting...");

app.use(express.static(__dirname));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));

// Use the system command installed via pip
const YTDLP_PATH = 'yt-dlp';

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 1. THE SCAVENGER: INFO & SEARCH ---
app.get('/info', (req, res) => {
    const userInput = req.query.url;
    if (!userInput) return res.status(400).json({ error: "Input required" });

    let target = userInput.startsWith('http') ? `"${userInput}"` : `gvsearch1:"${userInput}"`;

    // Strategy A: Try with Chrome Disguise
    let primaryCmd = `${YTDLP_PATH} --dump-json --no-playlist --no-check-certificates --impersonate chrome --geo-bypass ${target}`;
    
    if (fs.existsSync('cookies.txt')) {
        primaryCmd += ` --cookies cookies.txt`;
    }

    exec(primaryCmd, (error, stdout, stderr) => {
        if (error || !stdout) {
            console.log("⚠️ Primary path blocked or missing 'chrome' target. Trying Safe Mode...");
            
            // Strategy B: Fallback to Basic Mode (No impersonation)
            let fallbackCmd = `${YTDLP_PATH} --dump-json --no-playlist --no-check-certificates ${target}`;
            if (fs.existsSync('cookies.txt')) fallbackCmd += ` --cookies cookies.txt`;
            
            return exec(fallbackCmd, (err2, stdout2, stderr2) => {
                processResult(err2, stdout2, stderr2, res);
            });
        }
        processResult(error, stdout, stderr, res);
    });
});

// Helper function to handle the JSON data
function processResult(error, stdout, stderr, res) {
    if (error || !stdout) {
        console.error("Scavenger Error Log:", stderr);
        return res.status(500).json({ error: "Pathfinder failed. This video might be too heavily guarded." });
    }
    try {
        const info = JSON.parse(stdout);
        res.json({ 
            title: info.title, 
            thumbnail: info.thumbnail,
            videoId: info.id, 
            url: info.webpage_url,
            duration: info.duration_string,
            source: info.extractor_key // Returns 'Youtube', 'Vimeo', etc.
        });
    } catch (err) {
        res.status(500).json({ error: "Media found, but data is corrupted." });
    }
}

// --- 2. THE FETCHER: DOWNLOAD ---
app.get('/download', (req, res) => {
    const { url, quality, format, socketId } = req.query;
    if (!url) return res.status(400).send("Source URL required");

    const ext = format === 'mp3' ? 'mp3' : 'mp4';
    res.setHeader('Content-Disposition', `attachment; filename="OmniFetch_${Date.now()}.${ext}"`);
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');

    let args = [url, '-o', '-', '--no-check-certificates'];
    if (fs.existsSync('cookies.txt')) args.push('--cookies', 'cookies.txt');

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
        const match = data.toString().match(/(\d+\.\d+)%/);
        if (match && socketId) io.to(socketId).emit('progress', { percent: match[1] });
    });
    req.on('close', () => ls.kill());
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 OmniFetch Scavenger running on port ${PORT}`));