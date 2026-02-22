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

// --- THE UNIVERSAL SCAVENGER LOGIC ---
app.get('/api/info', (req, res) => { // Added /api/ prefix to match frontend
    const userInput = req.query.url;
    if (!userInput) return res.status(400).json({ error: "Input required" });

    let target = userInput.startsWith('http') ? `"${userInput}"` : `gvsearch1:"${userInput}"`;
    let cmd = `${YTDLP_PATH} --dump-json --no-playlist --no-check-certificates --geo-bypass --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36" --referer "https://www.google.com" ${target}`;
    
    if (fs.existsSync('cookies.txt')) {
        cmd += ` --cookies cookies.txt`;
    }

    exec(cmd, (error, stdout, stderr) => {
        if (error || !stdout) {
            console.error("Scavenger Error Log:", stderr);
            return res.status(500).json({ error: "Pathfinder failed." });
        }
        try {
            const info = JSON.parse(stdout);
            res.json({ 
                success: true,
                title: info.title, 
                thumbnail: info.thumbnail || 'https://via.placeholder.com/300?text=Media+Found',
                videoId: info.id, 
                url: info.webpage_url, 
                duration: info.duration_string,
                source: info.extractor_key 
            });
        } catch (err) {
            res.status(500).json({ error: "Data corrupted." });
        }
    });
});

// --- THE SECURE TMDB PROXY ---
// Michael, this is what fuels your Trending Today grid safely
app.get('/api/trending', async (req, res) => {
    const TMDB_TOKEN = process.env.TMDB_TOKEN;

    if (!TMDB_TOKEN) {
        console.error("❌ TMDB_TOKEN missing from Render Env Variables");
        return res.status(500).json({ error: "Server config error" });
    }

    try {
        // Using global fetch (available in Node 18+)
        const response = await fetch('https://api.themoviedb.org/3/trending/movie/day?language=en-US', {
            method: 'GET',
            headers: {
                accept: 'application/json',
                Authorization: `Bearer ${TMDB_TOKEN}`
            }
        });

        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error("Trending Proxy Error:", err);
        res.status(500).json({ error: "Failed to fetch movies" });
    }
});

// --- THE UNIVERSAL DOWNLOADER ---
app.get('/download', (req, res) => {
    const { url, format, socketId } = req.query;
    if (!url) return res.status(400).send("Source URL required");

    const isAudio = format === 'mp3';
    const ext = isAudio ? 'mp3' : 'mp4';
    
    res.setHeader('Content-Disposition', `attachment; filename="OmniFetch_${Date.now()}.${ext}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    let args = [
        url, '-o', '-', '--no-check-certificates', '--no-part',
        '--user-agent', "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
    ];

    if (fs.existsSync('cookies.txt')) args.push('--cookies', 'cookies.txt');

    if (isAudio) {
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
        let h = format || '480'; 
        let formatSelection = `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}]/best`;
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