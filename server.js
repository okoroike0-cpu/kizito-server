/*
 * OmniFetch — server.js  v3.0
 *
 * Download strategies per platform:
 *   YouTube     → Cobalt → yt-dlp (ios+mweb clients, impersonate chrome, OAuth2 cache)
 *   TikTok      → Cobalt → yt-dlp (impersonate chrome)
 *   Instagram   → Cobalt → yt-dlp (impersonate chrome + IG headers)
 *   Twitter/X   → yt-dlp ONLY (syndication API + playlist-items:1 fix)
 *   Facebook    → yt-dlp (impersonate chrome + FB headers) → HLS scraper
 *   Dailymotion → yt-dlp ONLY (Cobalt caused corruption — yt-dlp progressive mp4)
 *   Generic     → yt-dlp → HLS/MP4 scraper
 *
 * Anti-bot measures:
 *   - --impersonate chrome-124  (curl-cffi TLS fingerprint spoofing)
 *   - YouTube ios + mweb player clients  (avoids web bot checks)
 *   - OAuth2 token cache  (no manual cookie paste needed)
 *   - Cobalt API for YT/TT/IG/Twitter (cookieless, always fresh)
 *   - Auto yt-dlp update on startup
 */

const express        = require('express');
const cors           = require('cors');
const fs             = require('fs');
const path           = require('path');
const http           = require('http');
const https          = require('https');
const { Server }     = require('socket.io');
const { spawn, execSync, spawnSync } = require('child_process');

// ── PATH fix (Render non-Docker) ──────────────────────────────────────────────
if (!process.env.DOCKER) {
    process.env.PATH = [
        `${process.env.HOME}/.local/bin`,
        '/usr/local/bin', '/usr/bin', '/bin',
        process.env.PATH || '',
    ].join(':');
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));

// ══════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════════════════
const IS_RENDER    = !!process.env.RENDER;
const TMP          = IS_RENDER ? '/tmp' : __dirname;
const COOKIES_PATH = path.join(TMP, 'cookies.txt');
const CACHE_DIR    = IS_RENDER ? '/tmp/.cache/yt-dlp' : path.join(process.env.HOME || '/tmp', '.cache', 'yt-dlp');

// Cobalt — open source, handles YT/TT/IG/Twitter/Reddit/Vimeo cookieless
// Set COBALT_API env var to point at your self-hosted instance for best reliability
const COBALT_APIS = [
    process.env.COBALT_API,
    'https://api.cobalt.tools',
    'https://cobalt.tools',
].filter(Boolean);

// Platforms Cobalt handles well
// NOTE: Twitter/X intentionally excluded — yt-dlp syndication API is more reliable
// NOTE: Dailymotion intentionally excluded — yt-dlp produces cleaner non-corrupted output
const COBALT_HOSTS = new Set([
    'youtube.com', 'youtu.be', 'www.youtube.com', 'm.youtube.com',
    'tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'm.tiktok.com',
    'instagram.com', 'www.instagram.com',
    'reddit.com', 'www.reddit.com', 'v.redd.it',
    'vimeo.com', 'www.vimeo.com', 'player.vimeo.com',
    'twitch.tv', 'www.twitch.tv', 'clips.twitch.tv',
    'soundcloud.com', 'www.soundcloud.com',
    'bilibili.com', 'www.bilibili.com',
    'ok.ru', 'tumblr.com', 'pinterest.com',
]);

// ── yt-dlp binary resolution ──────────────────────────────────────────────────
const YTDLP_CANDIDATES = [
    process.env.YTDLP_PATH,
    `${process.env.HOME}/.local/bin/yt-dlp`,
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp',
].filter(Boolean);

let YTDLP_PATH = 'yt-dlp';
for (const c of YTDLP_CANDIDATES) {
    try { execSync(`"${c}" --version`, { timeout: 5000, stdio: 'pipe' }); YTDLP_PATH = c; break; }
    catch (_) {}
}

// Does this yt-dlp support --impersonate?
let SUPPORTS_IMPERSONATE = false;
try {
    const help = execSync(`"${YTDLP_PATH}" --help`, { timeout: 8000 }).toString();
    SUPPORTS_IMPERSONATE = help.includes('--impersonate');
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ══════════════════════════════════════════════════════════════════════════════
(function bootstrap() {
    // Ensure cache dir exists (for OAuth2 token persistence)
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}

    // Restore cookies from env if provided (legacy support)
    if (process.env.YOUTUBE_COOKIES) {
        try {
            fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES.replace(/\\n/g, '\n'), 'utf8');
            console.log('✅ YouTube cookies restored from env');
        } catch (e) { console.error('❌ Cookie write failed:', e.message); }
    }

    // yt-dlp version + auto-update
    try {
        const ver = execSync(`"${YTDLP_PATH}" --version`, { timeout: 5000 }).toString().trim();
        console.log(`✅ yt-dlp ${ver}`);
        console.log(`   impersonate support: ${SUPPORTS_IMPERSONATE}`);
    } catch { console.error('❌ yt-dlp not found'); }

    // Auto-update yt-dlp (YouTube frequently breaks older versions)
    try {
        execSync(`"${YTDLP_PATH}" -U --no-check-certificate`, { timeout: 45000, stdio: 'pipe' });
        console.log('✅ yt-dlp updated to latest');
    } catch (e) {
        console.warn('⚠️  yt-dlp auto-update skipped:', e.message.slice(0, 80));
    }

    // ffmpeg check
    try { execSync('ffmpeg -version', { timeout: 5000, stdio: 'pipe' }); console.log('✅ ffmpeg ready'); }
    catch { console.warn('⚠️  ffmpeg not found — trim/convert will fail'); }

    console.log(`✅ Cobalt APIs: ${COBALT_APIS.join(', ')}`);
})();

// ══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function resolveUrl(raw) {
    if (!raw) return null;
    const s = raw.trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return 'https://www.youtube.com/watch?v=' + s;
    return s.startsWith('http') ? s : 'https://' + s;
}

function getHostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function isCobaltUrl(url) {
    try {
        const h = new URL(url).hostname;
        return COBALT_HOSTS.has(h) || COBALT_HOSTS.has(h.replace(/^www\./, ''));
    } catch { return false; }
}

function isYouTubeUrl(url) {
    return url.includes('youtube.com') || url.includes('youtu.be');
}

function isInstagramUrl(url) { return url.includes('instagram.com'); }
function isTikTokUrl(url)    { return url.includes('tiktok.com'); }
function isFacebookUrl(url)  { return url.includes('facebook.com') || url.includes('fb.watch'); }
function isTwitterUrl(url)   { return url.includes('twitter.com') || url.includes('x.com'); }

function authFlags() {
    return fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
}

// ── Per-platform yt-dlp flags ─────────────────────────────────────────────────
function getPlatformFlags(url) {
    const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

    const flags = [];

    // --impersonate: makes yt-dlp mimic a real Chrome TLS fingerprint
    // This is the single biggest improvement for bot detection bypass
    if (SUPPORTS_IMPERSONATE) {
        flags.push('--impersonate', 'chrome-124');
    }

    if (isYouTubeUrl(url)) {
        flags.push(
            '--user-agent', UA_CHROME,
            '--add-header', 'Accept-Language:en-US,en;q=0.9',
            '--add-header', 'Referer:https://www.youtube.com/',
            // ios client: bypasses many bot checks; mweb: lightweight fallback
            '--extractor-args', 'youtube:player_client=ios,mweb',
            '--extractor-args', 'youtube:skip=dash,translated_subs',
            '--cache-dir', CACHE_DIR,  // preserves OAuth2 tokens across restarts
        );
    } else if (isInstagramUrl(url)) {
        flags.push(
            '--user-agent', UA_MOBILE,
            '--add-header', 'Accept-Language:en-US,en;q=0.9',
            '--add-header', 'Referer:https://www.instagram.com/',
            '--add-header', 'X-IG-App-ID:936619743392459',
        );
    } else if (isTikTokUrl(url)) {
        flags.push(
            '--user-agent', UA_MOBILE,
            '--add-header', 'Referer:https://www.tiktok.com/',
            '--add-header', 'Accept-Language:en-US,en;q=0.9',
        );
    } else if (isFacebookUrl(url)) {
        flags.push(
            '--user-agent', UA_CHROME,
            '--add-header', 'Referer:https://www.facebook.com/',
            '--add-header', 'Accept-Language:en-US,en;q=0.9',
            '--extractor-args', 'facebook:api=v21.0',
        );
    } else if (isTwitterUrl(url)) {
        flags.push(
            '--user-agent', UA_CHROME,
            '--add-header', 'Referer:https://twitter.com/',
            '--add-header', 'Accept-Language:en-US,en;q=0.9',
            // syndication API bypasses the auth wall for public tweets
            '--extractor-args', 'twitter:api=syndication',
            // Force only the first (correct) video — tweets with multiple
            // media items return a playlist and yt-dlp can pick the wrong one
            '--playlist-items', '1',
        );
    } else {
        flags.push(
            '--user-agent', UA_CHROME,
            '--add-header', 'Accept-Language:en-US,en;q=0.9',
            '--add-header', 'Referer:https://www.google.com/',
        );
    }

    return flags;
}

const BASE_FLAGS = [
    '--no-check-certificates',
    '--geo-bypass',
    '--extractor-retries', '3',
    '--socket-timeout', '20',
    '--no-playlist',
    '--age-limit', '99',
];

// Proxy support — set PROXY_URL=http://user:pass@host:port in Render env vars
function proxyFlags() {
    return process.env.PROXY_URL ? ['--proxy', process.env.PROXY_URL] : [];
}

function parseStderrError(stderr) {
    if (stderr.includes('No video could be found'))               return 'No downloadable video found at this URL.';
    if (stderr.includes('403') || stderr.includes('Forbidden'))  return 'Access denied (403). The site blocked the request.';
    if (stderr.includes('No video formats'))                     return 'No downloadable formats found.';
    if (stderr.includes('Sign in') || stderr.includes('429'))    return 'Rate limited or sign-in required. Try again shortly.';
    if (stderr.includes('bot') || stderr.includes('captcha'))    return 'Bot detection triggered. Try again in a few seconds.';
    if (stderr.includes('Private video'))                        return 'This video is private.';
    if (stderr.includes('Unsupported URL') || stderr.includes('is not a valid URL'))
                                                                 return 'This URL is not supported.';
    if (stderr.includes('DRM') || stderr.includes('drm'))        return 'This content is DRM-protected and cannot be downloaded.';
    return 'Could not extract video. The site may be protected or temporarily unavailable.';
}

function fmtSecs(s) {
    if (!s || isNaN(s)) return '';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function parseTime(t) {
    if (!t || !t.trim()) return null;
    const s = t.trim();
    if (/^\d+$/.test(s)) return parseInt(s);
    const parts = s.split(':').map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
}

function extractTitleFromUrl(url) {
    try {
        const u = new URL(url);
        const p = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
        return decodeURIComponent(p).replace(/[-_]/g, ' ').replace(/\.\w+$/, '') || 'Video';
    } catch { return 'Video'; }
}

// ── HTTP fetch helpers ────────────────────────────────────────────────────────
function fetchJson(options, body, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const mod = options.protocol === 'http:' ? http : https;
        const req = mod.request(options, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('JSON parse error: ' + data.slice(0, 100))); }
            });
        });
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Request timeout')); });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function fetchPageText(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,*/*',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                fetchPageText(res.headers.location, timeoutMs).then(resolve).catch(reject);
                return;
            }
            let data = '';
            res.on('data', chunk => { data += chunk; if (data.length > 800000) req.destroy(); });
            res.on('end', () => resolve(data));
        });
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Page fetch timeout')); });
        req.on('error', reject);
    });
}

// ── HLS / MP4 page scraper ────────────────────────────────────────────────────
async function scrapeMediaUrl(pageUrl) {
    try {
        const html = await fetchPageText(pageUrl);

        // Patterns in priority order
        const patterns = [
            // JSON source fields
            { re: /"(?:src|file|url|stream|videoUrl|mp4|hlsUrl|streamUrl)"\s*:\s*"(https?:\/\/[^"]+\.(?:mp4|m3u8)[^"]*)"/gi, type: 'auto' },
            // Direct MP4
            { re: /["'](https?:\/\/[^"']+\.mp4[^"']{0,200}?)["']/gi, type: 'mp4' },
            // HLS
            { re: /["'](https?:\/\/[^"']+\.m3u8[^"']{0,200}?)["']/gi, type: 'hls' },
            // Stream paths
            { re: /["'](https?:\/\/[^"']+\/(?:stream|hls|video|media)[^"']{0,200}?)["']/gi, type: 'auto' },
        ];

        for (const { re, type } of patterns) {
            const match = re.exec(html);
            if (match) {
                const u = match[1];
                const t = type === 'auto' ? (u.includes('.m3u8') ? 'hls' : 'mp4') : type;
                return { url: u, type: t };
            }
        }
        return null;
    } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  COBALT API  (multi-instance fallback)
// ══════════════════════════════════════════════════════════════════════════════
async function cobaltRequest(url, quality = '1080') {
    const body = JSON.stringify({
        url,
        videoQuality: quality,
        audioFormat: 'mp3',
        filenameStyle: 'pretty',
        downloadMode: 'auto',
    });

    for (const apiBase of COBALT_APIS) {
        try {
            const apiUrl  = new URL('/api', apiBase);
            const options = {
                hostname: apiUrl.hostname,
                port:     apiUrl.port || (apiBase.startsWith('https') ? 443 : 80),
                path:     apiUrl.pathname,
                protocol: apiUrl.protocol,
                method:   'POST',
                headers:  {
                    'Content-Type':   'application/json',
                    'Accept':         'application/json',
                    'User-Agent':     'OmniFetch/3.0',
                    'Content-Length': Buffer.byteLength(body),
                },
            };
            const result = await fetchJson(options, body, 12000);
            if (result && result.status !== 'error') {
                console.log(`[cobalt] success via ${apiBase}`);
                return result;
            }
            console.warn(`[cobalt] ${apiBase} returned error:`, result?.error?.code);
        } catch (e) {
            console.warn(`[cobalt] ${apiBase} failed:`, e.message);
        }
    }
    throw new Error('All Cobalt instances failed');
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/auth/status', (req, res) => {
    const cookiesOk = fs.existsSync(COOKIES_PATH);
    const oauthOk   = fs.existsSync(path.join(CACHE_DIR, 'youtube-oauth2.token.json'))
                   || fs.existsSync(path.join(CACHE_DIR, 'youtube-oauth2.json'));
    res.json({ cookiesLoaded: cookiesOk, oauthCached: oauthOk });
});

// Manual cookie upload (legacy / emergency)
app.post('/api/auth/cookies', (req, res) => {
    const { cookies } = req.body;
    if (!cookies || typeof cookies !== 'string' || cookies.trim().length < 10)
        return res.status(400).json({ error: 'No cookies provided.' });
    try {
        fs.writeFileSync(COOKIES_PATH, cookies.replace(/\\n/g, '\n'), 'utf8');
        res.json({ ok: true, message: 'Cookies saved.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug endpoint
app.get('/api/auth/debug', (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.write(`yt-dlp: ${YTDLP_PATH}\n`);
    res.write(`impersonate: ${SUPPORTS_IMPERSONATE}\n`);
    res.write(`cookies: ${fs.existsSync(COOKIES_PATH)}\n`);
    res.write(`cache dir: ${CACHE_DIR}\n`);
    res.write(`proxy: ${process.env.PROXY_URL || 'none'}\n`);
    res.write(`cobalt APIs: ${COBALT_APIS.join(', ')}\n\n`);

    const args = [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        '--dump-json', '--verbose',
        ...BASE_FLAGS, ...getPlatformFlags('https://youtube.com'), ...authFlags(), ...proxyFlags(),
    ];
    const proc = spawn(YTDLP_PATH, args);
    proc.stdout.on('data', d => res.write('[stdout] ' + d));
    proc.stderr.on('data', d => res.write('[stderr] ' + d));
    let done = false;
    const fin = code => { if (done) return; done = true; res.write(`\nexit: ${code}\n`); res.end(); };
    proc.on('close', fin);
    setTimeout(() => { try { proc.kill(); } catch(_){} fin('timeout'); }, 30000);
});

// ══════════════════════════════════════════════════════════════════════════════
//  INFO ENDPOINT — multi-strategy
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/info', async (req, res) => {
    const url = resolveUrl(req.query.url);
    if (!url) return res.status(400).json({ success: false, error: 'URL required.' });
    try { new URL(url); } catch {
        return res.status(400).json({ success: false, error: 'Invalid URL.' });
    }

    // ── Strategy 1: Cobalt (fast, cookieless, handles YT/TT/IG/Twitter) ──────
    if (isCobaltUrl(url)) {
        try {
            const cobalt = await cobaltRequest(url);
            if (cobalt.status !== 'error') {
                // Cobalt gives a stream URL but no metadata — return quickly, UI renders
                return res.json({
                    success:    true,
                    title:      cobalt.filename?.replace(/\.[^.]+$/, '') || extractTitleFromUrl(url),
                    thumbnail:  null,
                    url,
                    duration:   null,
                    uploader:   null,
                    source:     getHostname(url),
                    strategy:   'cobalt',
                    cobaltData: cobalt,
                });
            }
        } catch (e) {
            console.warn('[info] Cobalt failed, falling to yt-dlp:', e.message);
        }
    }

    // ── Strategy 2: yt-dlp with full anti-bot flags ───────────────────────────
    const ytdlpArgs = [
        url, '--dump-json',
        ...BASE_FLAGS,
        ...getPlatformFlags(url),
        ...authFlags(),
        ...proxyFlags(),
    ];

    const ytdlp = spawn(YTDLP_PATH, ytdlpArgs);
    let stdout = '', stderr = '';

    const timer = setTimeout(() => {
        ytdlp.kill('SIGTERM');
        if (!res.headersSent) res.status(504).json({ success: false, error: 'Timed out fetching info.' });
    }, 35000);

    ytdlp.stdout.on('data', d => { stdout += d; });
    ytdlp.stderr.on('data', d => {
        const l = d.toString(); stderr += l;
        if (!l.includes('%') && l.trim()) process.stderr.write('[yt-dlp] ' + l);
    });

    ytdlp.on('close', async code => {
        clearTimeout(timer);
        if (res.headersSent) return;

        if (code === 0 && stdout.trim()) {
            try {
                const jsonLine = stdout.trim().split('\n').find(l => l.startsWith('{'));
                if (jsonLine) {
                    const info = JSON.parse(jsonLine);
                    return res.json({
                        success:      true,
                        title:        info.title           || 'Unknown Title',
                        thumbnail:    info.thumbnail       || null,
                        videoId:      info.id              || null,
                        url:          info.webpage_url || info.url || url,
                        duration:     info.duration_string || fmtSecs(info.duration) || null,
                        durationSecs: info.duration        || null,
                        uploader:     info.uploader        || info.channel || null,
                        source:       info.extractor_key   || getHostname(url),
                        strategy:     'ytdlp',
                    });
                }
            } catch (_) {}
        }

        // ── Strategy 3: HLS/MP4 page scraper ─────────────────────────────────
        console.log('[info] yt-dlp failed, trying page scraper for', url);
        const scraped = await scrapeMediaUrl(url);
        if (scraped) {
            return res.json({
                success:   true,
                title:     extractTitleFromUrl(url),
                thumbnail: null,
                url,
                duration:  null,
                uploader:  null,
                source:    getHostname(url),
                strategy:  'scraper',
                scraped,
            });
        }

        return res.status(500).json({ success: false, error: parseStderrError(stderr) });
    });
});

// ══════════════════════════════════════════════════════════════════════════════
//  DOWNLOAD ENDPOINT
// ══════════════════════════════════════════════════════════════════════════════
app.get('/download', async (req, res) => {
    let { url: rawUrl, format, socketId, start, end, strategy, scraped: scrapedJson } = req.query;

    const url = resolveUrl(rawUrl);
    if (!url) return res.status(400).send('URL required');

    const startSec = parseTime(start);
    const endSec   = parseTime(end);
    const hasCut   = startSec !== null || endSec !== null;

    const AUDIO_FORMATS = new Set(['mp3', 'wav', 'aac', 'm4a', 'opus']);
    const isAudio = AUDIO_FORMATS.has(format);
    const isWebm  = format === 'webm';
    const ext     = isAudio ? (format || 'mp3') : isWebm ? 'webm' : 'mp4';
    const mime    = isAudio ? `audio/${ext === 'mp3' ? 'mpeg' : ext}` : `video/${ext}`;

    const emit = (pct, stage) => {
        if (socketId) io.to(socketId).emit('progress', { percent: pct, stage });
    };

    console.log(`[dl] ${url.slice(0, 80)} | fmt=${format} | strategy=${strategy} | cut=${hasCut}`);

    // ── Strategy A: Cobalt stream proxy (no cut needed) ───────────────────────
    if (strategy === 'cobalt' && !hasCut) {
        try {
            const quality = ['1080','720','480','360'].includes(format) ? format : '720';
            const cobalt  = await cobaltRequest(url, quality);

            if (cobalt.status === 'stream' || cobalt.status === 'redirect') {
                emit(10, 'Connecting…');
                return proxyStream(cobalt.url, ext, mime, res, req, emit);
            }
            // picker = multiple streams (e.g. TikTok slideshow) — use first
            if (cobalt.status === 'picker' && cobalt.picker?.length) {
                const first = cobalt.picker.find(p => p.url)?.url;
                if (first) { emit(10, 'Connecting…'); return proxyStream(first, ext, mime, res, req, emit); }
            }
        } catch (e) {
            console.warn('[dl] Cobalt failed, falling to yt-dlp:', e.message);
        }
    }

    // ── Strategy B: Scraped HLS/MP4 ──────────────────────────────────────────
    if (strategy === 'scraper') {
        let scraped;
        try { scraped = scrapedJson ? JSON.parse(scrapedJson) : await scrapeMediaUrl(url); } catch { scraped = null; }

        if (scraped?.url) {
            emit(5, 'Detected stream…');
            if (scraped.type === 'hls' || hasCut) {
                return streamViaFfmpeg(scraped.url, url, ext, mime, isAudio, startSec, endSec, res, req, emit);
            }
            return proxyStream(scraped.url, ext, mime, res, req, emit, url);
        }
    }

    // ── Strategy C: yt-dlp (default, full anti-bot) ───────────────────────────
    downloadViaYtdlp(url, format, ext, mime, isAudio, isWebm, hasCut, startSec, endSec, socketId, res, req, emit);
});

// ── Proxy a remote stream directly to client ──────────────────────────────────
function proxyStream(streamUrl, ext, mime, res, req, emit, referer) {
    const mod = streamUrl.startsWith('https') ? https : http;
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
    if (referer) headers['Referer'] = referer;

    const proxyReq = mod.get(streamUrl, { headers }, (proxyRes) => {
        res.setHeader('Content-Disposition', `attachment; filename="OmniFetch_${Date.now()}.${ext}"`);
        res.setHeader('Content-Type', mime);
        if (proxyRes.headers['content-length'])
            res.setHeader('Content-Length', proxyRes.headers['content-length']);

        let received = 0;
        const total = parseInt(proxyRes.headers['content-length'] || '0');
        proxyRes.on('data', chunk => {
            received += chunk.length;
            res.write(chunk);
            if (total > 0) emit(10 + Math.round((received / total) * 89), 'Downloading…');
        });
        proxyRes.on('end', () => { emit(100, 'Done'); res.end(); });
    });
    proxyReq.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Stream proxy failed.' }); });
    req.on('close', () => proxyReq.destroy());
}

// ── yt-dlp download (stream directly or download→cut) ────────────────────────
function downloadViaYtdlp(url, format, ext, mime, isAudio, isWebm, hasCut, startSec, endSec, socketId, res, req, emit) {
    const fmtArgs = buildFormatArgs(format, ext, isAudio, isWebm);
    const allFlags = [
        ...BASE_FLAGS,
        ...getPlatformFlags(url),
        ...authFlags(),
        ...proxyFlags(),
        ...fmtArgs,
    ];

    // ── No cut: pipe directly to client ──────────────────────────────────────
    if (!hasCut) {
        const args  = [url, '-o', '-', '--no-part', ...allFlags];
        const ytdlp = spawn(YTDLP_PATH, args);
        let hasData = false, stderrBuf = '';

        ytdlp.stderr.on('data', chunk => {
            const line = chunk.toString(); stderrBuf += line;
            const m = line.match(/(\d+\.?\d*)%/);
            if (m) emit(parseFloat(m[1]), 'Downloading…');
            if (!line.includes('%') && line.trim()) process.stderr.write('[yt-dlp] ' + line);
        });
        ytdlp.stdout.on('data', chunk => {
            if (!hasData) {
                hasData = true;
                res.setHeader('Content-Disposition', `attachment; filename="OmniFetch_${Date.now()}.${ext}"`);
                res.setHeader('Content-Type', mime);
            }
            res.write(chunk);
        });
        ytdlp.on('close', code => {
            emit(100, 'Done');
            if (!hasData && !res.headersSent) res.status(500).json({ error: parseStderrError(stderrBuf) });
            else if (!res.writableEnded) res.end();
        });
        ytdlp.on('error', () => { if (!res.headersSent) res.status(500).send('yt-dlp launch failed'); });
        req.on('close', () => { ytdlp.kill('SIGTERM'); setTimeout(() => { try { ytdlp.kill('SIGKILL'); } catch(_){} }, 3000); });
        return;
    }

    // ── With cut: download to temp file → ffmpeg ──────────────────────────────
    const tmpFile = path.join(TMP, `omni_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
    const args    = [url, '-o', tmpFile, '--no-part', ...allFlags];
    const ytdlp   = spawn(YTDLP_PATH, args);
    let stderrBuf = '';

    emit(0, 'Downloading…');
    ytdlp.stderr.on('data', chunk => {
        const line = chunk.toString(); stderrBuf += line;
        const m = line.match(/(\d+\.?\d*)%/);
        if (m) emit(parseFloat(m[1]) * 0.7, 'Downloading…');
        if (!line.includes('%') && line.trim()) process.stderr.write('[yt-dlp] ' + line);
    });
    ytdlp.on('close', code => {
        if (code !== 0 || !fs.existsSync(tmpFile)) {
            if (!res.headersSent) res.status(500).json({ error: parseStderrError(stderrBuf) });
            try { fs.unlinkSync(tmpFile); } catch(_) {}
            return;
        }
        emit(70, 'Trimming…');
        streamViaFfmpeg(tmpFile, null, ext, mime, isAudio, startSec, endSec, res, req, emit, tmpFile);
    });
    req.on('close', () => { ytdlp.kill('SIGTERM'); setTimeout(() => { try { ytdlp.kill('SIGKILL'); } catch(_){} }, 3000); });
}

// ── Build yt-dlp format arguments ────────────────────────────────────────────
function buildFormatArgs(format, ext, isAudio, isWebm) {
    if (isAudio) {
        return ['-x', '--audio-format', ext === 'mp3' ? 'mp3' : ext, '--audio-quality', '0'];
    }
    if (isWebm) {
        return [
            '-f', 'bestvideo[ext=webm]+bestaudio[ext=webm]/best[ext=webm]/best',
            '--merge-output-format', 'webm',
        ];
    }
    const h = ['1080', '720', '480', '360', '240'].includes(format) ? format : '720';
    return [
        // Format selection priority:
        // 1. Best mp4 video + m4a audio at requested height (cleanest, no remux needed)
        // 2. Best mp4 video + any audio at requested height
        // 3. Any single best file at requested height (e.g. Dailymotion progressive mp4)
        // 4. Absolute best available (last resort)
        '-f', [
            `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]`,
            `bestvideo[height<=${h}][ext=mp4]+bestaudio`,
            `best[height<=${h}][ext=mp4]`,
            `best[height<=${h}]`,
            'best',
        ].join('/'),
        '--merge-output-format', 'mp4',
        // Note: --recode-video intentionally omitted — it triggers full CPU re-encode
        // on Render free tier which causes timeouts. The format string above already
        // prioritizes native mp4+m4a so remuxing is rarely needed.
    ];
}

// ── ffmpeg: HLS stream or trim ────────────────────────────────────────────────
// NOTE: We use re-encode (-c:v libx264) instead of stream copy (-vcodec copy)
// because copy fails silently when source codec/container is incompatible
// (causes the "file is corrupt / won't play" error on Dailymotion and some others)
function streamViaFfmpeg(inputUrl, referer, ext, mime, isAudio, startSec, endSec, res, req, emit, tmpFileToDelete) {
    const ffArgs = ['-y', '-loglevel', 'error'];
    if (referer) ffArgs.push('-headers', `Referer: ${referer}\r\nUser-Agent: Mozilla/5.0\r\n`);

    // Input seeking — put -ss before -i for fast seek
    if (startSec !== null) ffArgs.push('-ss', String(startSec));
    ffArgs.push('-i', inputUrl);

    // Duration limit
    if (endSec !== null) {
        const dur = endSec - (startSec || 0);
        if (dur > 0) ffArgs.push('-t', String(dur));
    }

    if (isAudio) {
        if (ext === 'mp3') ffArgs.push('-vn', '-acodec', 'libmp3lame', '-q:a', '2');
        else if (ext === 'aac') ffArgs.push('-vn', '-acodec', 'aac', '-b:a', '192k');
        else if (ext === 'wav') ffArgs.push('-vn', '-acodec', 'pcm_s16le');
        else ffArgs.push('-vn', '-acodec', 'copy');
        ffArgs.push('-f', ext === 'mp3' ? 'mp3' : ext === 'wav' ? 'wav' : 'adts');
    } else if (ext === 'webm') {
        ffArgs.push('-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-c:a', 'libopus');
        ffArgs.push('-f', 'webm');
    } else {
        // Re-encode to H.264/AAC — universally compatible with all players/devices
        // ultrafast preset keeps CPU usage low on Render's free tier
        ffArgs.push(
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k',
            '-pix_fmt', 'yuv420p',           // Required for iPhone and some Android players
            // frag_keyframe+empty_moov: correct for pipe:1 streaming.
            // +faststart cannot work here — it requires seeking back on a real file
            // to rewrite the moov atom, which is impossible on a pipe. It silently
            // fails or corrupts output. Fragmented MP4 needs no seeking — each
            // fragment is self-contained so browsers play from the first byte.
            // Paired with libx264 re-encode (not stream copy) to prevent container
            // mismatches that caused the original Dailymotion corruption.
            '-movflags', 'frag_keyframe+empty_moov',
            '-f', 'mp4',
        );
    }

    ffArgs.push('pipe:1');

    const ff = spawn('ffmpeg', ffArgs);
    let hasData = false;

    ff.stdout.on('data', chunk => {
        if (!hasData) {
            hasData = true;
            res.setHeader('Content-Disposition', `attachment; filename="OmniFetch_${Date.now()}.${ext}"`);
            res.setHeader('Content-Type', mime);
            res.removeHeader('Content-Length'); // Size unknown during encoding
        }
        res.write(chunk);
    });
    ff.stderr.on('data', chunk => {
        const line = chunk.toString();
        const tm = line.match(/time=(\d+):(\d+):(\d+)/);
        if (tm) {
            const elapsed = parseInt(tm[1]) * 3600 + parseInt(tm[2]) * 60 + parseInt(tm[3]);
            const total   = endSec ? (endSec - (startSec || 0)) : 60;
            emit(70 + Math.min(29, Math.round((elapsed / total) * 29)), 'Processing…');
        }
        // Log ffmpeg errors (not progress lines)
        if (!line.includes('time=') && !line.includes('frame=') && line.trim())
            process.stderr.write('[ffmpeg] ' + line);
    });
    ff.on('close', (code) => {
        emit(100, 'Done');
        if (tmpFileToDelete) try { fs.unlinkSync(tmpFileToDelete); } catch(_) {}
        if (!hasData && !res.headersSent) res.status(500).json({ error: 'ffmpeg failed — source may be inaccessible.' });
        else if (!res.writableEnded) res.end();
    });
    ff.on('error', () => {
        if (tmpFileToDelete) try { fs.unlinkSync(tmpFileToDelete); } catch(_) {}
        if (!res.headersSent) res.status(500).json({ error: 'ffmpeg not found on server.' });
    });
    req.on('close', () => {
        try { ff.kill('SIGTERM'); } catch(_){}
        // SIGKILL fallback: ffmpeg sometimes ignores SIGTERM mid-encode on Render
        setTimeout(() => { try { ff.kill('SIGKILL'); } catch(_){} }, 3000);
    });
}

// ══════════════════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════════════════════════════════════════
io.on('connection', s => {
    console.log(`[socket] + ${s.id}`);
    s.on('disconnect', () => console.log(`[socket] - ${s.id}`));
});

// ══════════════════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 OmniFetch v3 on port ${PORT}`));

process.on('uncaughtException',  err    => console.error('Uncaught:', err));
process.on('unhandledRejection', reason => console.error('Unhandled rejection:', reason));