const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const { Server }  = require('socket.io');
const { spawn }   = require('child_process');
const { execSync} = require('child_process');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));

// ══════════════════════════════════════════════════════════
//  COOKIES BOOTSTRAP
//  On Render: Dashboard → Environment → Add Variable
//    Key:   YOUTUBE_COOKIES
//    Value: (paste full contents of cookies.txt)
// ══════════════════════════════════════════════════════════

const COOKIES_PATH = process.env.RENDER
    ? path.join('/tmp', 'cookies.txt')
    : path.join(__dirname, 'cookies.txt');

(function bootstrapCookies() {
    const cookieEnv = process.env.YOUTUBE_COOKIES;
    if (cookieEnv) {
        try {
            const content = cookieEnv.replace(/\\n/g, '\n');
            fs.writeFileSync(COOKIES_PATH, content, 'utf8');
            console.log(`✅ cookies.txt written from env (${content.split('\n').length} lines)`);
        } catch (err) {
            console.error('❌ Failed to write cookies.txt:', err.message);
        }
    } else if (fs.existsSync(path.join(__dirname, 'cookies.txt'))) {
        console.log('ℹ️  Using local cookies.txt (dev mode)');
    } else {
        console.warn('⚠️  No cookies — YouTube bot-check may trigger');
    }
})();


// ── yt-dlp check ───────────────────────────────
const YTDLP_PATH = 'yt-dlp';
try {
    const v = execSync('yt-dlp --version', { timeout: 5000 }).toString().trim();
    console.log(`✅ yt-dlp: ${v}`);
} catch (e) {
    console.error('❌ yt-dlp not found on PATH');
}

const BROWSER_HEADERS = [
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--add-header', 'Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '--add-header', 'Sec-Fetch-Mode:navigate',
    '--add-header', 'Referer:https://www.google.com/',
];
const COMMON_FLAGS = [
    '--no-check-certificates', '--geo-bypass',
    '--extractor-retries', '3', '--socket-timeout', '20',
];

function withCookies(args) {
    return fs.existsSync(COOKIES_PATH) ? [...args, '--cookies', COOKIES_PATH] : args;
}


// ── Static ──────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));


// ══════════════════════════════════════════════════════════
//  SAVETHEVIDEO PROXY
// ══════════════════════════════════════════════════════════
const STV_BASE = 'https://www.savethevideo.com';
const STV_UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

app.get('/api/stv/start', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });
    try {
        const r = await fetch(`${STV_BASE}/api/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin':       STV_BASE,
                'Referer':      `${STV_BASE}/home`,
                'User-Agent':   STV_UA,
            },
            body: new URLSearchParams({ url }),
        });
        if (!r.ok) {
            const text = await r.text();
            console.error('[stv/start]', r.status, text.slice(0, 200));
            return res.status(502).json({ error: `SaveTheVideo returned ${r.status}` });
        }
        let data;
        try { data = await r.json(); } catch (e) {
            return res.status(502).json({ error: 'SaveTheVideo returned invalid JSON' });
        }
        if (!data?.id) {
            console.error('[stv/start] no id:', JSON.stringify(data).slice(0, 200));
            return res.status(502).json({ error: data?.error || data?.message || 'No task ID from SaveTheVideo' });
        }
        console.log(`[stv/start] task=${data.id}`);
        res.json(data);
    } catch (err) {
        console.error('[stv/start]', err.message);
        res.status(500).json({ error: 'SaveTheVideo unreachable.' });
    }
});

app.get('/api/stv/check', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });
    try {
        const r = await fetch(`${STV_BASE}/api/check?id=${encodeURIComponent(id)}`, {
            headers: { 'Origin': STV_BASE, 'Referer': `${STV_BASE}/home`, 'User-Agent': STV_UA },
        });
        if (!r.ok) return res.status(502).json({ error: `SaveTheVideo returned ${r.status}` });
        res.json(await r.json());
    } catch (err) {
        console.error('[stv/check]', err.message);
        res.status(500).json({ error: err.message });
    }
});


// ══════════════════════════════════════════════════════════
//  /api/search  — YouTube search → returns list of results
//  Uses yt-dlp ytsearch with --flat-playlist (fast, no download)
//  GET /api/search?q=belmont+overstepping&limit=12
// ══════════════════════════════════════════════════════════
app.get('/api/search', (req, res) => {
    const q     = req.query.q;
    const limit = Math.min(parseInt(req.query.limit) || 12, 20);
    if (!q) return res.status(400).json({ error: 'q required' });

    const searchQuery = `ytsearch${limit}:${q}`;
    const args = withCookies([
        searchQuery,
        '--flat-playlist',          // don't fetch full info — just titles/IDs (fast)
        '--dump-json',
        '--no-warnings',
        '--age-limit', '99',        // allow adult content
        ...COMMON_FLAGS,
        ...BROWSER_HEADERS,
    ]);

    console.log(`[search] "${q}" limit=${limit}`);
    const ytdlp = spawn(YTDLP_PATH, args);
    let stdout = '', stderr = '';

    ytdlp.stdout.on('data', d => { stdout += d; });
    ytdlp.stderr.on('data', d => { stderr += d.toString(); });

    const killTimer = setTimeout(() => {
        ytdlp.kill('SIGTERM');
        setTimeout(() => { try { ytdlp.kill('SIGKILL'); } catch (_) {} }, 3000);
        if (!res.headersSent) res.status(504).json({ error: 'Search timed out.' });
    }, 30000);

    ytdlp.on('close', code => {
        clearTimeout(killTimer);
        if (res.headersSent) return;

        const lines   = stdout.trim().split('\n').filter(l => l.startsWith('{'));
        const results = [];

        for (const line of lines) {
            try {
                const e = JSON.parse(line);
                // --flat-playlist gives minimal fields
                const id       = e.id       || e.url?.split('v=')[1]?.split('&')[0] || '';
                const title    = e.title    || e.fulltitle || '';
                const thumb    = e.thumbnails?.[e.thumbnails.length - 1]?.url
                              || e.thumbnail
                              || (id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '');
                const duration = e.duration_string || (e.duration ? fmtSecs(e.duration) : '');
                const channel  = e.channel || e.uploader || e.channel_id || '';
                if (id && title) results.push({ id, title, thumbnail: thumb, duration, channel });
            } catch (_) {}
        }

        if (!results.length) {
            const botCheck = stderr.includes('Sign in') || stderr.includes('bot') || stderr.includes('429');
            const msg = botCheck
                ? 'YouTube is rate-limiting us. Wait 30s and retry.'
                : 'No results found. Try different keywords.';
            return res.status(404).json({ error: msg });
        }

        res.json({ results });
    });
});

function fmtSecs(s) {
    if (!s || isNaN(s)) return '';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
}


// ══════════════════════════════════════════════════════════
//  /api/info  — single video metadata via yt-dlp
//  Works for ANY URL including adult sites — yt-dlp handles them
// ══════════════════════════════════════════════════════════
app.get('/api/info', (req, res) => {
    const userInput = req.query.url;
    if (!userInput) return res.status(400).json({ error: 'Input required' });

    const args = withCookies([
        userInput,
        '--dump-json',
        '--no-playlist',
        '--age-limit', '99',        // allow adult content
        ...COMMON_FLAGS,
        ...BROWSER_HEADERS,
    ]);

    console.log(`[info] ${userInput.slice(0, 80)}`);
    const ytdlp  = spawn(YTDLP_PATH, args);
    let stdout = '', stderr = '';

    ytdlp.stdout.on('data', d => { stdout += d; });
    ytdlp.stderr.on('data', d => {
        const l = d.toString();
        stderr += l;
        if (!l.includes('%') && l.trim()) process.stderr.write('[yt-dlp] ' + l);
    });

    const killTimer = setTimeout(() => {
        ytdlp.kill('SIGTERM');
        setTimeout(() => { try { ytdlp.kill('SIGKILL'); } catch (_) {} }, 3000);
        if (!res.headersSent) res.status(504).json({ error: 'Timed out. Paste a direct URL.' });
    }, 30000);

    ytdlp.on('close', code => {
        clearTimeout(killTimer);
        if (res.headersSent) return;
        if (code !== 0 || !stdout.trim()) {
            const blocked  = stderr.includes('403') || stderr.includes('Forbidden');
            const notFound = stderr.includes('No video formats') || stderr.includes('Unable to extract');
            const botCheck = stderr.includes('Sign in') || stderr.includes('bot') || stderr.includes('429');
            const badUrl   = stderr.includes('is not a valid URL') || stderr.includes('Unsupported URL');
            let msg = 'Could not fetch. Try a direct URL.';
            if (blocked)  msg = 'Site blocked our request (403). Try pasting the direct video URL.';
            if (notFound) msg = 'No media found at this URL.';
            if (botCheck) msg = 'Rate limited. Wait 30s and retry.';
            if (badUrl)   msg = 'Invalid URL. Check the link.';
            return res.status(500).json({ error: msg });
        }
        try {
            const jsonLine = stdout.trim().split('\n').find(l => l.startsWith('{'));
            const info = JSON.parse(jsonLine);
            res.json({
                success:   true,
                title:     info.title            || 'Unknown Title',
                thumbnail: info.thumbnail        || null,
                videoId:   info.id               || null,
                url:       info.webpage_url || info.url || userInput,
                duration:  info.duration_string  || null,
                uploader:  info.uploader         || info.channel || null,
                source:    info.extractor_key    || null,
            });
        } catch (e) {
            res.status(500).json({ error: 'Could not parse media data.' });
        }
    });
});


// ══════════════════════════════════════════════════════════
//  /download  — stream video/audio via yt-dlp
//  Supports any URL yt-dlp supports (YouTube, Dailymotion,
//  adult sites, TikTok, Twitter, Vimeo, Instagram, etc.)
// ══════════════════════════════════════════════════════════
app.get('/download', (req, res) => {
    const { url, format, socketId } = req.query;
    if (!url) return res.status(400).send('Source URL required');

    const isAudio = format === 'mp3';
    const ext     = isAudio ? 'mp3' : 'mp4';
    res.setHeader('Content-Disposition', `attachment; filename="OmniFetch_${Date.now()}.${ext}"`);
    res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

    let fmtArgs;
    if (isAudio) {
        fmtArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
    } else {
        const h = ['1080', '720', '480', '360', '240'].includes(format) ? format : '480';
        fmtArgs = [
            '-f', `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]/best`,
            '--merge-output-format', 'mp4',   // always merge into mp4, never mkv/webm
        ];
    }

    const args  = withCookies([
        url, '-o', '-', '--no-part',
        '--age-limit', '99',        // allow adult content
        ...COMMON_FLAGS, ...BROWSER_HEADERS, ...fmtArgs,
    ]);
    const ytdlp = spawn(YTDLP_PATH, args);
    ytdlp.stdout.pipe(res);

    ytdlp.stderr.on('data', chunk => {
        const match = chunk.toString().match(/(\d+\.?\d*)%/);
        if (match && socketId) io.to(socketId).emit('progress', { percent: parseFloat(match[1]) });
    });
    ytdlp.on('error', () => { if (!res.headersSent) res.status(500).send('Download failed'); });
    ytdlp.on('close', () => { if (socketId) io.to(socketId).emit('progress', { percent: 100 }); });
    req.on('close', () => {
        ytdlp.kill('SIGTERM');
        setTimeout(() => { try { ytdlp.kill('SIGKILL'); } catch (_) {} }, 3000);
    });
});


// ── Socket.IO ──────────────────────────────────
io.on('connection', socket => {
    console.log(`[socket] + ${socket.id}`);
    socket.on('disconnect', () => console.log(`[socket] - ${socket.id}`));
});


// ── Start ──────────────────────────────────────
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 OmniFetch on port ${PORT}`));