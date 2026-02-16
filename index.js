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

// --- THE SCAVENGER LOGIC ---
app.get('/info', (req, res) => {
    const userInput = req.query.url;
    if (!userInput) return res.status(400).json({ error: "Input required" });

    let target = userInput.startsWith('http') ? `"${userInput}"` : `gvsearch1:"${userInput}"`;

    let cmd = `${YTDLP_PATH} --dump-json --no-playlist --no-check-certificates --geo-bypass ${target}`;
    
    if (fs.existsSync('cookies.txt')) {
        cmd += ` --cookies cookies.txt`;
    }

    exec(cmd, (error, stdout, stderr) => {
        if (error || !stdout) {
            console.error("Scavenger Error Log:", stderr);
            return res.status(500).json({ error: "Pathfinder failed. YouTube might be blocking the server IP. Try a direct link from Vimeo!" });
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
            res.status(500).json({ error: "Media found, but data is corrupted." });
        }
    });
});

// --- THE DOWNLOAD LOGIC (Now supports 240p - 1080p) ---
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
        // h grabs the selection (240, 360, 480, 720, 1080)
        let h = quality || '480'; 
        // Logic: Try to find best MP4 with height <= user choice
        let formatSelection = `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[ext=mp4]/best`;
        
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
server.listen(PORT, () => console.log(`🚀 OmniFetch running on port ${PORT}`));