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

// --- THE SCAVENGER LOGIC (Info Endpoint) ---
app.get('/api/info', (req, res) => {
    const userInput = req.query.url;
    if (!userInput) return res.status(400).json({ error: "Input required" });

    // ytsearch1: is more reliable than gvsearch1 for YouTube
    let target = userInput.startsWith('http') ? `"${userInput}"` : `ytsearch1:"${userInput}"`;

    // Added --user-agent to help bypass the "Sign in to confirm you're not a bot" error
    let cmd = `${YTDLP_PATH} --dump-json --no-playlist --no-check-certificates --geo-bypass --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36" ${target}`;
    
    if (fs.existsSync('cookies.txt')) {
        cmd += ` --cookies cookies.txt`;
    }

    exec(cmd, (error, stdout, stderr) => {
        if (error || !stdout) {
            console.error("Scavenger Error Log:", stderr);
            return res.status(500).json({ error: "Pathfinder failed. YouTube might be blocking the server. Try a direct link!" });
        }

        try {
            const info = JSON.parse(stdout);
            res.json({ 
                success: true,
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

// --- THE DOWNLOAD LOGIC (Supports 240p - 1080p & MP3) ---
app.get('/download', (req, res) => {
    const { url, format, socketId } = req.query;
    if (!url) return res.status(400).send("Source URL required");

    // 'format' from the frontend dropdown will be '1080', '720', '480', '360', '240', or 'mp3'
    const isAudio = format === 'mp3';
    const ext = isAudio ? 'mp3' : 'mp4';
    
    res.setHeader('Content-Disposition', `attachment; filename="OmniFetch_${Date.now()}.${ext}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    // Base arguments with Bot protection
    let args = [
        url, 
        '-o', '-', 
        '--no-check-certificates', 
        '--no-part', // Prevents .part files which crash streaming
        '--user-agent', "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
    ];

    if (fs.existsSync('cookies.txt')) args.push('--cookies', 'cookies.txt');

    if (isAudio) {
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
        // Logic: Try to find best MP4 with height <= user choice (format variable)
        let h = format || '480'; 
        let formatSelection = `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[ext=mp4]/best`;
        args.push('-f', formatSelection);
    }

    const ls = spawn(YTDLP_PATH, args);
    
    // Pipe the data directly to the user's browser
    ls.stdout.pipe(res);

    // Track progress via Socket.io
    ls.stderr.on('data', (data) => {
        const match = data.toString().match(/(\d+\.\d+)%/);
        if (match && socketId) io.to(socketId).emit('progress', { percent: match[1] });
    });

    // Cleanup if user cancels download
    req.on('close', () => {
        ls.kill();
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 OmniFetch running on port ${PORT}`));