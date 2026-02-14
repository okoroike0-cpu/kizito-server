const express = require('express');
const ytdl = require('@distube/ytdl-core');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http'); 
const { Server } = require('socket.io');

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

// --- FIX 1: ADDED BROWSER USER-AGENT TO BYPASS BLOCKS ---
const customUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

let agent;
try {
    if (fs.existsSync('cookies.json')) {
        const cookies = JSON.parse(fs.readFileSync('cookies.json', 'utf8'));
        // We pass the User-Agent here to make the request look like a real person
        agent = ytdl.createAgent(cookies, { 'User-Agent': customUserAgent });
        console.log("✅ Cookies & User-Agent loaded successfully.");
    } else {
        agent = ytdl.createAgent(undefined, { 'User-Agent': customUserAgent });
        console.log("⚠️ No cookies.json found. Using User-Agent only.");
    }
} catch (e) {
    console.error("❌ Error parsing cookies.json:", e.message);
    agent = ytdl.createAgent(undefined, { 'User-Agent': customUserAgent });
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/info', async (req, res) => {
    try {
        // Pass the agent into getInfo
        const info = await ytdl.getInfo(req.query.url, { agent });
        
        let format = ytdl.chooseFormat(info.formats, { quality: '18' }) || info.formats[0];

        res.json({ 
            title: info.videoDetails.title, 
            thumbnail: info.videoDetails.thumbnails[0].url,
            size: format.contentLength ? (parseInt(format.contentLength) / (1024 * 1024)).toFixed(2) + " MB" : "Unknown",
            duration: Math.floor(info.videoDetails.lengthSeconds / 60) + ":" + (info.videoDetails.lengthSeconds % 60).toString().padStart(2, '0')
        });
    } catch (err) {
        console.error("Info Error:", err.message);
        res.status(500).json({ error: "YouTube blocked the request. Refresh cookies.json!" });
    }
});

app.get('/download', async (req, res) => {
    const { url, quality, format, socketId } = req.query;

    try {
        const info = await ytdl.getInfo(url, { agent });
        const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');

        let itag = 18; 
        if (quality === '1080p') itag = 137;
        else if (quality === '720p') itag = 22;

        const options = { 
            quality: itag, 
            agent, // Crucial: use the agent here too
            filter: format === 'mp3' ? 'audioonly' : 'audioandvideo'
        };
        
        const downloadStream = ytdl(url, options);

        downloadStream.on('info', (info, format) => {
            res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');
            const ext = format === 'mp3' ? 'mp3' : 'mp4';
            res.setHeader('Content-Disposition', `attachment; filename="${title}.${ext}"`);
        });

        downloadStream.on('progress', (_, downloaded, total) => {
            const percent = ((downloaded / total) * 100).toFixed(2);
            if (socketId) {
                io.to(socketId).emit('progress', { percent });
            }
        });

        downloadStream.on('error', err => {
            console.error("Stream Error:", err.message);
            if (!res.headersSent) res.status(500).send("YouTube connection lost.");
        });

        return downloadStream.pipe(res);

    } catch (error) {
        console.error("Download Error:", error.message);
        if (!res.headersSent) res.status(500).send("Error: " + error.message);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Kizito Server running on port ${PORT}`);
});