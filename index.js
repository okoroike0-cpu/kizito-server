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

// Verify yt-dlp is reachable at startup — visible immediately in Render logs
const { execSync } = require('child_process');
try {
    const version = execSync('yt-dlp --version', { timeout: 5000 }).toString().trim();
    console.log(`✅ yt-dlp found: ${version}`);
} catch (e) {
    console.error('❌ yt-dlp NOT found on PATH — all downloads will fail!');
    console.error('   Fix: set Build Command to: npm install && pip install -U yt-dlp --break-system-packages');
}

// ─────────────────────────────────────────────
// No --impersonate flag at all.
// We use a realistic Chrome User-Agent + spoofed
// browser headers instead. Works for YouTube,
// Vimeo, Dailymotion, etc.
// ─────────────────────────────────────────────
const BROWSER_HEADERS = [
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '--add-header', 'Sec-Fetch-Mode:navigate',
    '--add-header', 'Referer:https://www.google.com/',
];

const COMMON_FLAGS = [
    '--no-check-certificates',
    '--geo-bypass',
    '--extractor-retries', '3',
    '--socket-timeout', '20',
    // --no-impersonate intentionally omitted — it doesn't exist in older yt-dlp builds
    // and causes a hard exit-code-2 crash before any work is done.
    // extractor-args targets Dailymotion's internal impersonation attempt directly.
    '--extractor-args', 'dailymotion:impersonate=false',
];

function withCookies(args) {
    const cookiePath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiePath)) {
        return [...args, '--cookies', cookiePath];
    }
    return args;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ══════════════════════════════════════════════
// /api/info — Fetch media metadata
// ══════════════════════════════════════════════
app.get('/api/info', (req, res) => {
    const userInput = req.query.url;
    if (!userInput) return res.status(400).json({ error: 'Input required' });

    const args = withCookies([
        userInput,
        '--dump-json',
        '--no-playlist',
        '--age-limit', '99',
        ...COMMON_FLAGS,
        ...BROWSER_HEADERS,
    ]);

    console.log(`[info] ${YTDLP_PATH} ${args[0].slice(0, 60)}...`);

    const ytdlp = spawn(YTDLP_PATH, args);
    let stdout = '';
    let stderr = '';

    ytdlp.stdout.on('data', d => { stdout += d.toString(); });
    ytdlp.stderr.on('data', d => {
        const line = d.toString();
        stderr += line;
        if (!line.includes('%') && line.trim()) process.stderr.write('[yt-dlp] ' + line);
    });

    const killTimer = setTimeout(() => {
        ytdlp.kill('SIGTERM');
        if (!res.headersSent) {
            res.status(504).json({ error: 'Timed out. Try a shorter name or paste a direct URL.' });
        }
    }, 30000);

    ytdlp.on('close', (code) => {
        clearTimeout(killTimer);
        if (res.headersSent) return;

        if (code !== 0 || !stdout.trim()) {
            const blocked  = stderr.includes('403') || stderr.includes('Forbidden');
            const notFound = stderr.includes('No video formats') || stderr.includes('Unable to extract') || stderr.includes('no suitable formats');
            const botCheck = stderr.includes('Sign in') || stderr.includes('bot') || stderr.includes('429') || stderr.includes('rate limit');
            const badUrl   = stderr.includes('is not a valid URL') || stderr.includes('Unsupported URL');
            // Detect residual impersonation errors even after our flags, so we surface a clear message
            const impersonateErr = stderr.includes('impersonat') || stderr.includes('curl-cffi');
            const badFlag        = stderr.includes('no such option') || stderr.includes('unrecognized option');

            let msg = 'Search failed. Try adding "trailer" or "official video" to the name.';
            if (blocked)        msg = 'Site blocked access (403). Paste a direct video URL instead.';
            if (notFound)       msg = 'No media found for that search. Try a different title.';
            if (botCheck)       msg = 'Platform is rate-limiting us. Wait 30 seconds and try again, or paste the URL directly.';
            if (badUrl)         msg = 'Invalid URL. Check the link and try again.';
            if (badFlag)        msg = 'Server configuration error (unsupported yt-dlp flag). Please contact support.';
            if (impersonateErr) msg = 'This site requires browser emulation not supported on this server. Try a YouTube or direct video URL instead.';

            console.error(`[info] Failed — code=${code} blocked=${blocked} notFound=${notFound} botCheck=${botCheck} badFlag=${badFlag} impersonateErr=${impersonateErr}`);
            return res.status(500).json({ error: msg });
        }

        try {
            const jsonLine = stdout.trim().split('\n').find(l => l.startsWith('{'));
            if (!jsonLine) throw new Error('No JSON object found in yt-dlp output');
            const info = JSON.parse(jsonLine);

            res.json({
                success:   true,
                title:     info.title           || 'Unknown Title',
                thumbnail: info.thumbnail       || null,
                videoId:   info.id              || null,
                url:       info.webpage_url || info.url || userInput,
                duration:  info.duration_string || null,
                source:    info.extractor_key   || null,
            });
        } catch (err) {
            console.error('[info] JSON parse error:', err.message);
            res.status(500).json({ error: 'Could not read media data. Try pasting a direct URL.' });
        }
    });
});

// ══════════════════════════════════════════════
// /api/trending — TMDB proxy
// ══════════════════════════════════════════════
app.get('/api/trending', async (req, res) => {
    const TOKEN = process.env.TMDB_TOKEN;
    if (!TOKEN) return res.status(500).json({ error: 'TMDB_TOKEN not configured on server' });

    try {
        const r = await fetch('https://api.themoviedb.org/3/trending/movie/day?language=en-US', {
            headers: { accept: 'application/json', Authorization: `Bearer ${TOKEN}` }
        });
        if (!r.ok) throw new Error(`TMDB returned ${r.status}`);
        res.json(await r.json());
    } catch (err) {
        console.error('[trending]', err.message);
        res.status(500).json({ error: 'Could not load trending movies' });
    }
});

// ══════════════════════════════════════════════
// /api/search — TMDB search proxy
// ══════════════════════════════════════════════
app.get('/api/search', async (req, res) => {
    const { q } = req.query;
    const TOKEN = process.env.TMDB_TOKEN;

    if (!q) return res.status(400).json({ error: 'Search query required' });
    if (!TOKEN) return res.status(500).json({ error: 'TMDB_TOKEN not configured on server' });

    try {
        const r = await fetch(
            `https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(q)}&language=en-US&page=1`,
            { headers: { accept: 'application/json', Authorization: `Bearer ${TOKEN}` } }
        );
        if (!r.ok) throw new Error(`TMDB returned ${r.status}`);
        res.json(await r.json());
    } catch (err) {
        console.error('[search]', err.message);
        res.status(500).json({ error: 'Movie search failed' });
    }
});

// ══════════════════════════════════════════════
// /download — Stream file directly to browser
// ══════════════════════════════════════════════
app.get('/download', (req, res) => {
    const { url, format, socketId } = req.query;
    if (!url) return res.status(400).send('Source URL required');

    const isAudio = format === 'mp3';
    const ext     = isAudio ? 'mp3' : 'mp4';

    res.setHeader('Content-Disposition', `attachment; filename="OmniFetch_${Date.now()}.${ext}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    // Format selection
    let fmtArgs;
    if (isAudio) {
        fmtArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
    } else {
        const h = ['1080','720','480','360','240'].includes(format) ? format : '480';
        fmtArgs = ['-f', `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]/best`];
    }

    const args = withCookies([
        url,
        '-o', '-',
        '--no-part',
        ...COMMON_FLAGS,
        ...BROWSER_HEADERS,
        ...fmtArgs,
    ]);

    console.log(`[download] format=${format} socket=${socketId} url=${url.slice(0,60)}...`);

    const ytdlp = spawn(YTDLP_PATH, args);
    ytdlp.stdout.pipe(res);

    ytdlp.stderr.on('data', (chunk) => {
        const line = chunk.toString();
        const match = line.match(/(\d+\.?\d*)%/);
        if (match && socketId) {
            io.to(socketId).emit('progress', { percent: parseFloat(match[1]) });
        }
    });

    ytdlp.on('error', (err) => {
        console.error('[download] spawn error:', err.message);
        if (!res.headersSent) res.status(500).send('Download failed');
    });

    ytdlp.on('close', (code) => {
        console.log(`[download] yt-dlp exit=${code}`);
        if (socketId) io.to(socketId).emit('progress', { percent: 100 });
    });

    req.on('close', () => ytdlp.kill('SIGTERM'));
});

// ══════════════════════════════════════════════
// Socket.IO
// ══════════════════════════════════════════════
io.on('connection', (socket) => {
    console.log(`[socket] + ${socket.id}`);
    socket.on('disconnect', () => console.log(`[socket] - ${socket.id}`));
});

// ══════════════════════════════════════════════
// Start
// ══════════════════════════════════════════════
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 OmniFetch running on port ${PORT}`);
    if (!process.env.TMDB_TOKEN) {
        console.warn('⚠️  TMDB_TOKEN not set — /api/trending and /api/search will return errors');
    }
});