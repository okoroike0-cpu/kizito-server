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
//  cookies.txt is in .gitignore so it never hits GitHub.
//  On Render: paste your cookies.txt contents into an env
//  variable called YOUTUBE_COOKIES. This block writes it to
//  a temp file at startup so yt-dlp can find it normally.
//
//  How to set on Render:
//    Dashboard → your service → Environment → Add Variable
//    Key:   YOUTUBE_COOKIES
//    Value: (paste the full contents of your cookies.txt)
// ══════════════════════════════════════════════════════════

// Cookies file lives in /tmp on Render (writable), or next to
// index.js in local dev where cookies.txt may already exist.
const COOKIES_PATH = process.env.RENDER
    ? path.join('/tmp', 'cookies.txt')           // Render: writable temp dir
    : path.join(__dirname, 'cookies.txt');        // Local dev: project folder

(function bootstrapCookies() {
    const cookieEnv = process.env.YOUTUBE_COOKIES;

    if (cookieEnv) {
        try {
            // Normalize line endings — copy-pasting into Render dashboard
            // sometimes converts \n to literal backslash-n
            const content = cookieEnv.replace(/\\n/g, '\n');
            fs.writeFileSync(COOKIES_PATH, content, 'utf8');
            console.log(`✅ cookies.txt written from YOUTUBE_COOKIES env var (${content.split('\n').length} lines)`);
        } catch (err) {
            console.error('❌ Failed to write cookies.txt from env var:', err.message);
        }
    } else if (fs.existsSync(path.join(__dirname, 'cookies.txt'))) {
        // Local dev fallback — file already exists next to index.js
        console.log('ℹ️  Using local cookies.txt (dev mode)');
    } else {
        console.warn('⚠️  No YOUTUBE_COOKIES env var and no local cookies.txt — YouTube bot detection may trigger');
    }
})();


// ── yt-dlp availability check ──────────────────
const YTDLP_PATH = 'yt-dlp';
try {
    const v = execSync('yt-dlp --version', { timeout: 5000 }).toString().trim();
    console.log(`✅ yt-dlp found: ${v}`);
} catch (e) {
    console.error('❌ yt-dlp NOT found on PATH');
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

// withCookies now uses COOKIES_PATH (env-bootstrapped) instead of hardcoded __dirname
function withCookies(args) {
    return fs.existsSync(COOKIES_PATH)
        ? [...args, '--cookies', COOKIES_PATH]
        : args;
}


// ── Static ──────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));


// ══════════════════════════════════════════════════════════
//  SAVETHEVIDEO PROXY — the same engine savethevideo.com uses
//  We proxy it server-side to avoid CORS blocks in the browser
// ══════════════════════════════════════════════════════════

const STV_BASE = 'https://www.savethevideo.com';

// Step 1: Submit a URL → get a task ID back
// Frontend calls: GET /api/stv/start?url=...
app.get('/api/stv/start', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });

    try {
        const r = await fetch(`${STV_BASE}/api/start`, {
            method:  'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin':       STV_BASE,
                'Referer':      `${STV_BASE}/home`,
                'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
            body: new URLSearchParams({ url }),
        });

        if (!r.ok) {
            const text = await r.text();
            console.error('[stv/start] non-ok response:', r.status, text.slice(0, 200));
            return res.status(502).json({ error: `SaveTheVideo returned ${r.status}` });
        }

        // FIX 2: Validate the JSON structure before trusting it
        let data;
        try {
            data = await r.json();
        } catch (parseErr) {
            console.error('[stv/start] JSON parse failed:', parseErr.message);
            return res.status(502).json({ error: 'SaveTheVideo returned invalid JSON — service may be down' });
        }

        if (!data || typeof data !== 'object') {
            return res.status(502).json({ error: 'SaveTheVideo returned unexpected response' });
        }
        if (!data.id) {
            console.error('[stv/start] No task ID in response:', JSON.stringify(data).slice(0, 200));
            return res.status(502).json({ error: data.error || data.message || 'SaveTheVideo did not return a task ID' });
        }

        console.log(`[stv/start] task=${data.id} status=${data.status}`);
        res.json(data);

    } catch (err) {
        console.error('[stv/start]', err.message);
        res.status(500).json({ error: 'SaveTheVideo is currently unavailable. Try pasting a direct URL instead.' });
    }
});

// Step 2: Poll for task completion → returns links when done
// Frontend calls: GET /api/stv/check?id=...
app.get('/api/stv/check', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });

    try {
        const r = await fetch(`${STV_BASE}/api/check?id=${encodeURIComponent(id)}`, {
            headers: {
                'Origin':  STV_BASE,
                'Referer': `${STV_BASE}/home`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
        });

        if (!r.ok) {
            return res.status(502).json({ error: `SaveTheVideo returned ${r.status}` });
        }

        const data = await r.json();
        res.json(data);

    } catch (err) {
        console.error('[stv/check]', err.message);
        res.status(500).json({ error: err.message });
    }
});


// ── /api/info — yt-dlp metadata (text search fallback) ──
app.get('/api/info', (req, res) => {
    const userInput = req.query.url;
    if (!userInput) return res.status(400).json({ error: 'Input required' });

    const args = withCookies([
        userInput, '--dump-json', '--no-playlist', '--age-limit', '99',
        ...COMMON_FLAGS, ...BROWSER_HEADERS,
    ]);

    console.log(`[info] ${userInput.slice(0, 60)}...`);
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
        if (!res.headersSent) res.status(504).json({ error: 'Timed out. Try a shorter name or paste a direct URL.' });
    }, 30000);

    ytdlp.on('close', (code) => {
        clearTimeout(killTimer);
        if (res.headersSent) return;
        if (code !== 0 || !stdout.trim()) {
            const blocked  = stderr.includes('403') || stderr.includes('Forbidden');
            const notFound = stderr.includes('No video formats') || stderr.includes('Unable to extract');
            const botCheck = stderr.includes('Sign in') || stderr.includes('bot') || stderr.includes('429');
            const badUrl   = stderr.includes('is not a valid URL') || stderr.includes('Unsupported URL');
            const dmBlock  = stderr.toLowerCase().includes('dailymotion') && (stderr.includes('403') || stderr.includes('No video formats'));

            let msg = 'Search failed. Try adding "trailer" or "official video".';
            if (blocked)  msg = 'Site blocked access (403). Paste a direct video URL instead.';
            if (notFound) msg = 'No media found. Try a different title.';
            if (botCheck) msg = 'Platform is rate-limiting us. Wait 30s and retry.';
            if (badUrl)   msg = 'Invalid URL. Check the link and try again.';
            if (dmBlock)  msg = 'Dailymotion blocks server downloads. Try YouTube instead.';

            return res.status(500).json({ error: msg });
        }
        try {
            const jsonLine = stdout.trim().split('\n').find(l => l.startsWith('{'));
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
            res.status(500).json({ error: 'Could not read media data. Try pasting a direct URL.' });
        }
    });
});


// ── /api/trending — TMDB ──────────────────────
app.get('/api/trending', async (req, res) => {
    const TOKEN = process.env.TMDB_TOKEN;
    if (!TOKEN) return res.status(500).json({ error: 'TMDB_TOKEN not configured' });
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


// ── /api/searchmulti — TMDB multi search (movies + TV shows) ──
app.get('/api/searchmulti', async (req, res) => {
    const { q } = req.query;
    const TOKEN = process.env.TMDB_TOKEN;
    if (!q)     return res.status(400).json({ error: 'Search query required' });
    if (!TOKEN) return res.status(500).json({ error: 'TMDB_TOKEN not configured' });
    try {
        const r = await fetch(
            `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(q)}&language=en-US&page=1`,
            { headers: { accept: 'application/json', Authorization: `Bearer ${TOKEN}` } }
        );
        if (!r.ok) throw new Error(`TMDB returned ${r.status}`);
        res.json(await r.json());
    } catch (err) {
        console.error('[searchmulti]', err.message);
        res.status(500).json({ error: 'Multi search failed' });
    }
});

// ── /api/search — TMDB movie-only search ──────
app.get('/api/search', async (req, res) => {
    const { q } = req.query;
    const TOKEN = process.env.TMDB_TOKEN;
    if (!q)     return res.status(400).json({ error: 'Search query required' });
    if (!TOKEN) return res.status(500).json({ error: 'TMDB_TOKEN not configured' });
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


// ── /download — yt-dlp stream (fallback) ──────
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
        const h = ['1080','720','480','360','240'].includes(format) ? format : '480';
        fmtArgs = ['-f', `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]/best`];
    }

    const args  = withCookies([url, '-o', '-', '--no-part', ...COMMON_FLAGS, ...BROWSER_HEADERS, ...fmtArgs]);
    const ytdlp = spawn(YTDLP_PATH, args);
    ytdlp.stdout.pipe(res);

    ytdlp.stderr.on('data', (chunk) => {
        const match = chunk.toString().match(/(\d+\.?\d*)%/);
        if (match && socketId) io.to(socketId).emit('progress', { percent: parseFloat(match[1]) });
    });
    ytdlp.on('error', (err) => { if (!res.headersSent) res.status(500).send('Download failed'); });
    ytdlp.on('close', (code) => { if (socketId) io.to(socketId).emit('progress', { percent: 100 }); });
    req.on('close', () => {
        // Aggressive cleanup for Render free tier — SIGTERM first, SIGKILL after 3s
        ytdlp.kill('SIGTERM');
        setTimeout(() => {
            try { ytdlp.kill('SIGKILL'); } catch (_) {}
        }, 3000);
    });
});


// ── Socket.IO ──────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[socket] + ${socket.id}`);
    socket.on('disconnect', () => console.log(`[socket] - ${socket.id}`));
});


// ── Start ──────────────────────────────────────
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 OmniFetch running on port ${PORT}`);
    if (!process.env.TMDB_TOKEN) console.warn('⚠️  TMDB_TOKEN not set');
});