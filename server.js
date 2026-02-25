const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const { Server }      = require('socket.io');
const { spawn, execSync } = require('child_process');

// ── PATH fix for Render: pip installs to ~/.local/bin ──────
process.env.PATH = `${process.env.HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(__dirname));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));

// ══════════════════════════════════════════════════════════
//  PATHS & CONFIG
// ══════════════════════════════════════════════════════════
const IS_RENDER    = !!process.env.RENDER;
const TMP          = IS_RENDER ? '/tmp' : __dirname;
const COOKIES_PATH = path.join(TMP, 'cookies.txt');
const TOKEN_PATH   = path.join(TMP, 'yt-dlp-oauth2.token');

let oauthState = { active: false, userCode: null, verifyUrl: null, status: 'idle', error: null };

// ══════════════════════════════════════════════════════════
//  BOOTSTRAP — Restore cookies & OAuth2 token from env vars
// ══════════════════════════════════════════════════════════
(function bootstrap() {
    if (process.env.YOUTUBE_COOKIES) {
        try {
            fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES.replace(/\\n/g, '\n'), 'utf8');
            console.log('✅ Cookies restored from env');
        } catch (e) { console.error('❌ Failed to write cookies:', e.message); }
    }
    if (process.env.OAUTH2_TOKEN) {
        try {
            fs.writeFileSync(TOKEN_PATH, process.env.OAUTH2_TOKEN, 'utf8');
            console.log('✅ OAuth2 token restored from env');
        } catch (e) { console.error('❌ Failed to write token:', e.message); }
    }
    if (!process.env.YOUTUBE_COOKIES && !process.env.OAUTH2_TOKEN) {
        console.warn('⚠️  No auth env vars set — open /auth in browser after deploy to link YouTube.');
    }
})();

// ── yt-dlp path resolution ──────────────────────────────
const YTDLP_CANDIDATES = [
    process.env.YTDLP_PATH,
    `${process.env.HOME}/.local/bin/yt-dlp`,
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp',
].filter(Boolean);

let YTDLP_PATH = 'yt-dlp';
for (const candidate of YTDLP_CANDIDATES) {
    try {
        execSync(`"${candidate}" --version`, { timeout: 5000 });
        YTDLP_PATH = candidate;
        break;
    } catch (_) { /* try next */ }
}

try {
    console.log(`✅ yt-dlp ${execSync(`"${YTDLP_PATH}" --version`, { timeout: 5000 }).toString().trim()} (${YTDLP_PATH})`);
} catch {
    console.error('❌ yt-dlp not found — check your build command in package.json');
}

// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════
const COMMON_FLAGS = [
    '--no-check-certificates', '--geo-bypass',
    '--extractor-retries', '3', '--socket-timeout', '20',
];

function authFlags() {
    if (fs.existsSync(TOKEN_PATH))   return ['--username', 'oauth2', '--password', ''];
    if (fs.existsSync(COOKIES_PATH)) return ['--cookies', COOKIES_PATH];
    return [];
}

function getPlatformHeaders(url) {
    const u  = (url || '').toLowerCase();
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const h  = ['--user-agent', UA, '--add-header', 'Accept-Language:en-US,en;q=0.9'];

    if (u.includes('twitter.com') || u.includes('x.com')) {
        h.push('--extractor-args', 'twitter:api=syndication',
               '--add-header', 'Referer:https://twitter.com/');
    } else if (u.includes('dailymotion.com')) {
        h.push('--add-header', 'Referer:https://www.dailymotion.com/',
               '--add-header', 'Origin:https://www.dailymotion.com');
    } else if (u.includes('facebook.com') || u.includes('fb.watch')) {
        h.push('--add-header', 'Referer:https://www.facebook.com/',
               '--add-header', 'Origin:https://www.facebook.com');
    } else {
        h.push('--add-header', 'Referer:https://www.google.com/');
    }
    return h;
}

function parseStderrError(stderr) {
    if (stderr.includes('No video could be found'))             return 'This URL has no downloadable video (image-only tweet?).';
    if (stderr.includes('403') || stderr.includes('Forbidden')) return 'Site blocked the request (403). Try a direct URL.';
    if (stderr.includes('No video formats'))                    return 'No downloadable formats found at this URL.';
    if (stderr.includes('Sign in') || stderr.includes('bot') || stderr.includes('429'))
                                                                return 'Rate limited or login required. Re-link your YouTube account.';
    if (stderr.includes('is not a valid URL') || stderr.includes('Unsupported URL'))
                                                                return 'Invalid or unsupported URL.';
    return 'Extraction failed. The source may be private or geo-blocked.';
}

function fmtSecs(s) {
    if (!s || isNaN(s)) return '';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}


// ══════════════════════════════════════════════════════════
//  OAUTH2 ROUTES
// ══════════════════════════════════════════════════════════

app.get('/api/auth/status', (req, res) => {
    res.json({
        oauth2Linked:  fs.existsSync(TOKEN_PATH),
        cookiesLoaded: fs.existsSync(COOKIES_PATH),
        oauthFlow:     oauthState.status,
        userCode:      oauthState.userCode  || null,
        verifyUrl:     oauthState.verifyUrl || null,
        error:         oauthState.error     || null,
    });
});

// ══════════════════════════════════════════════════════════
//  DEBUG — streams raw yt-dlp output to browser
//  Visit: https://kizito-server.onrender.com/api/auth/debug
//  Also wipes the stale token so you see the device-code flow
// ══════════════════════════════════════════════════════════
app.get('/api/auth/debug', (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    res.write(`YTDLP_PATH   : ${YTDLP_PATH}\n`);
    res.write(`TOKEN_PATH   : ${TOKEN_PATH}\n`);
    res.write(`TOKEN exists : ${fs.existsSync(TOKEN_PATH)}\n`);
    res.write(`COOKIES exists: ${fs.existsSync(COOKIES_PATH)}\n`);
    res.write(`HOME: ${process.env.HOME}\n`);
    res.write(`PATH: ${process.env.PATH}\n\n`);

    if (fs.existsSync(TOKEN_PATH)) {
        try {
            fs.unlinkSync(TOKEN_PATH);
            res.write('🗑️  Removed stale token file — starting fresh device-code flow\n\n');
        } catch (e) {
            res.write(`⚠️  Could not remove token: ${e.message}\n\n`);
        }
    }

    res.write('--- Spawning yt-dlp oauth2 (--verbose) — waiting up to 30s ---\n\n');

    const proc = spawn(YTDLP_PATH, [
        '--username', 'oauth2', '--password', '',
        '--skip-download', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        '--verbose',
    ]);

    proc.stdout.on('data', d => res.write('[stdout] ' + d.toString()));
    proc.stderr.on('data', d => res.write('[stderr] ' + d.toString()));

    let done = false;
    const finish = (code) => {
        if (done) return; done = true;
        res.write(`\n\n--- yt-dlp exited: code ${code} ---\n`);
        res.end();
    };

    proc.on('close', finish);
    setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch (_) {}
        res.write('\n[TIMED OUT after 30s]\n');
        finish('timeout');
    }, 30000);
});

app.get('/api/auth/token-export', (req, res) => {
    const secret = process.env.EXPORT_SECRET;
    if (secret && req.query.secret !== secret) {
        return res.status(403).json({ error: 'Forbidden — wrong or missing ?secret= param.' });
    }
    if (!fs.existsSync(TOKEN_PATH)) {
        return res.status(404).json({ error: 'No token found. Link your account first.' });
    }
    res.json({
        token:       fs.readFileSync(TOKEN_PATH, 'utf8'),
        instruction: 'Copy the "token" value above → Render Dashboard → Environment → OAUTH2_TOKEN',
    });
});

// POST /api/auth/start — kicks off the device-code flow
app.post('/api/auth/start', (req, res) => {
    if (oauthState.active) {
        return res.json({ ok: true, userCode: oauthState.userCode, verifyUrl: oauthState.verifyUrl });
    }
    oauthState = { active: true, status: 'pending', error: null, userCode: null, verifyUrl: null };

    // ══════════════════════════════════════════════════════
    //  THE KEY FIX:
    //  Bootstrap writes the old OAUTH2_TOKEN env var to disk
    //  on every boot. When /api/auth/start runs, yt-dlp finds
    //  that file, tries to REFRESH the expired token, gets
    //  HTTP 400, and exits — never printing the device code.
    //  Solution: always delete the token file BEFORE spawning
    //  so yt-dlp is forced to start a brand-new device-code flow.
    // ══════════════════════════════════════════════════════
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            fs.unlinkSync(TOKEN_PATH);
            console.log('[oauth2] 🗑️  Deleted stale token — starting fresh device-code flow');
        } catch (e) {
            console.warn('[oauth2] Could not delete stale token:', e.message);
        }
    }

    const proc = spawn(YTDLP_PATH, [
        '--username', 'oauth2', '--password', '',
        '--skip-download', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ]);

    let stderrBuf = '';
    let responded = false;

    proc.stderr.on('data', chunk => {
        const text = chunk.toString();
        stderrBuf += text;
        console.log('[oauth2 stderr]', text.trim());

        // Plugin prints: "open https://www.google.com/device and enter code XXXX-XXXX"
        const codeMatch = stderrBuf.match(/code[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i);
        const urlMatch  = stderrBuf.match(/open\s+(https:\/\/[^\s\n]+)/i);
        if (codeMatch && urlMatch && !responded) {
            responded = true;
            oauthState.userCode  = codeMatch[1].trim();
            oauthState.verifyUrl = urlMatch[1].trim();
            res.json({ ok: true, userCode: oauthState.userCode, verifyUrl: oauthState.verifyUrl });
        }
    });

    proc.on('close', code => {
        oauthState.active = false;
        if (code === 0) {
            oauthState.status = 'linked';
            console.log('✅ OAuth2 linked — token saved at', TOKEN_PATH);
            if (!responded) res.json({ ok: true, message: 'Linked successfully' });
        } else {
            oauthState.status = 'error';
            oauthState.error  = 'OAuth2 flow failed. Is yt-dlp-youtube-oauth2 installed?';
            console.error('[oauth2] failed stderr:', stderrBuf.slice(0, 600));
            if (!responded) res.status(500).json({ error: oauthState.error });
        }
    });

    setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch (_) {}
        if (!responded) {
            oauthState = { ...oauthState, active: false, status: 'error', error: 'Flow timed out.' };
            res.status(504).json({ error: 'OAuth2 flow timed out.' });
        }
    }, 5 * 60 * 1000);
});

app.post('/api/auth/revoke', (req, res) => {
    try {
        if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
        oauthState = { active: false, userCode: null, verifyUrl: null, status: 'idle', error: null };
        res.json({ ok: true, message: 'Token revoked. Re-link to restore YouTube access.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ══════════════════════════════════════════════════════════
//  SEARCH
// ══════════════════════════════════════════════════════════
app.get('/api/search', (req, res) => {
    const q     = req.query.q;
    const limit = Math.min(parseInt(req.query.limit) || 12, 20);
    if (!q) return res.status(400).json({ error: 'Search query required' });

    const args = [
        `ytsearch${limit}:${q}`,
        '--flat-playlist', '--dump-json', '--no-warnings',
        '--age-limit', '99',
        ...COMMON_FLAGS,
        ...getPlatformHeaders('youtube.com'),
        ...authFlags(),
    ];

    const ytdlp = spawn(YTDLP_PATH, args);
    let stdout = '', stderr = '';

    const timer = setTimeout(() => {
        ytdlp.kill('SIGTERM');
        if (!res.headersSent) res.status(504).json({ error: 'Search timed out. Try again.' });
    }, 30000);

    ytdlp.stdout.on('data', d => { stdout += d; });
    ytdlp.stderr.on('data', d => { stderr += d.toString(); });

    ytdlp.on('close', () => {
        clearTimeout(timer);
        if (res.headersSent) return;

        const results = stdout.trim().split('\n')
            .filter(l => l.startsWith('{'))
            .map(line => {
                try {
                    const e = JSON.parse(line);
                    return {
                        id:        e.id,
                        title:     e.title || e.fulltitle || '',
                        thumbnail: e.thumbnail || `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
                        duration:  e.duration_string || fmtSecs(e.duration),
                        channel:   e.channel || e.uploader || '',
                    };
                } catch (_) { return null; }
            }).filter(Boolean);

        if (!results.length) {
            const botCheck = stderr.includes('Sign in') || stderr.includes('bot') || stderr.includes('429');
            return res.status(404).json({
                error: botCheck ? 'Rate-limited by YouTube. Re-link your account.' : 'No results found.',
            });
        }
        res.json({ results });
    });
});


// ══════════════════════════════════════════════════════════
//  INFO
// ══════════════════════════════════════════════════════════
app.get('/api/info', (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const args = [
        url, '--dump-json', '--no-playlist',
        '--age-limit', '99',
        ...COMMON_FLAGS,
        ...getPlatformHeaders(url),
        ...authFlags(),
    ];

    const ytdlp = spawn(YTDLP_PATH, args);
    let stdout = '', stderr = '';

    const timer = setTimeout(() => {
        ytdlp.kill('SIGTERM');
        if (!res.headersSent) res.status(504).json({ error: 'Timed out. Paste a direct URL.' });
    }, 30000);

    ytdlp.stdout.on('data', d => { stdout += d; });
    ytdlp.stderr.on('data', d => {
        const l = d.toString(); stderr += l;
        if (!l.includes('%') && l.trim()) process.stderr.write('[yt-dlp] ' + l);
    });

    ytdlp.on('close', code => {
        clearTimeout(timer);
        if (res.headersSent) return;
        if (code !== 0 || !stdout.trim()) {
            return res.status(500).json({ error: parseStderrError(stderr) });
        }
        try {
            const info = JSON.parse(stdout.trim().split('\n').find(l => l.startsWith('{')));
            res.json({
                success:   true,
                title:     info.title            || 'Unknown Title',
                thumbnail: info.thumbnail        || null,
                videoId:   info.id               || null,
                url:       info.webpage_url || info.url || url,
                duration:  info.duration_string  || null,
                uploader:  info.uploader         || info.channel || null,
                source:    info.extractor_key    || null,
            });
        } catch {
            res.status(500).json({ error: 'Could not parse media data.' });
        }
    });
});


// ══════════════════════════════════════════════════════════
//  DOWNLOAD
// ══════════════════════════════════════════════════════════
app.get('/download', (req, res) => {
    const { url, format, socketId } = req.query;
    if (!url) return res.status(400).send('URL required');

    const isAudio = format === 'mp3' || format === 'ytdlp_mp3';
    const ext     = isAudio ? 'mp3' : 'mp4';

    let fmtArgs;
    if (isAudio) {
        fmtArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
    } else {
        const h = ['1080', '720', '480', '360', '240'].includes(format) ? format : '480';
        fmtArgs = [
            '-f', `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]/best`,
            '--merge-output-format', 'mp4',
        ];
    }

    const args = [
        url, '-o', '-', '--no-part',
        '--age-limit', '99',
        ...COMMON_FLAGS,
        ...getPlatformHeaders(url),
        ...authFlags(),
        ...fmtArgs,
    ];

    console.log(`[download] ${url.slice(0, 80)} | format=${format}`);
    const ytdlp = spawn(YTDLP_PATH, args);

    let headersSent  = false;
    let stderrBuffer = '';
    let hasData      = false;

    ytdlp.stderr.on('data', chunk => {
        const line = chunk.toString();
        stderrBuffer += line;
        const match = line.match(/(\d+\.?\d*)%/);
        if (match && socketId) io.to(socketId).emit('progress', { percent: parseFloat(match[1]) });
        if (!line.includes('%') && line.trim()) process.stderr.write('[yt-dlp] ' + line);
    });

    ytdlp.stdout.on('data', chunk => {
        if (!hasData) {
            hasData     = true;
            headersSent = true;
            res.setHeader('Content-Disposition', `attachment; filename="OmniFetch_${Date.now()}.${ext}"`);
            res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');
        }
        res.write(chunk);
    });

    ytdlp.on('error', err => {
        console.error('[download] spawn error:', err.message);
        if (!headersSent && !res.headersSent) res.status(500).json({ error: 'Download engine failed.' });
    });

    ytdlp.on('close', code => {
        if (socketId) io.to(socketId).emit('progress', { percent: 100 });
        if (code !== 0 || !hasData) {
            const msg = parseStderrError(stderrBuffer);
            console.error(`[download] FAILED code=${code}: ${msg}`);
            if (!headersSent && !res.headersSent) res.status(500).json({ error: msg });
            else res.end();
            return;
        }
        res.end();
    });

    req.on('close', () => {
        ytdlp.kill('SIGTERM');
        setTimeout(() => { try { ytdlp.kill('SIGKILL'); } catch (_) {} }, 3000);
    });
});


// ══════════════════════════════════════════════════════════
//  SOCKET.IO + START
// ══════════════════════════════════════════════════════════
io.on('connection', s => {
    console.log(`[socket] + ${s.id}`);
    s.on('disconnect', () => console.log(`[socket] - ${s.id}`));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 OmniFetch running on port ${PORT}`);
    console.log(`💡 After linking YouTube, visit /api/auth/token-export?secret=YOUR_SECRET to save your token.`);
});