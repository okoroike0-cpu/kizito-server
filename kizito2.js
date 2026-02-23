// ============================================================
// OMNIFETCH — kizito2.js  (v5 — Triple Engine)
//
// THREE ENGINES + HOW THEY COMBINE:
//
//  ① vermeauplomberie / download-lagu-mp3  (YouTube only)
//     GET api.download-lagu-mp3.com/@api/json/mp3/{ytId}     → MP3 direct link
//     GET api.download-lagu-mp3.com/@api/json/videos/{ytId}  → MP4 quality list
//     ↳ Called straight from browser — zero server, zero CORS issue
//
//  ② SaveTheVideo  (ANY other URL: Dailymotion, FB, TikTok, Vimeo…)
//     POST /api/stv/start?url=  → task id
//     Poll /api/stv/check?id=   → quality list with sizes & bitrates
//     ↳ Proxied through our server (savethevideo.com blocks direct CORS)
//
//  ③ VidSrc  (TMDB movies & TV shows)
//     WATCH    → vidsrc.cc/v2/embed/{type}/{tmdbId}     iframe player
//     DOWNLOAD → dl.vidsrc.vip/{type}/{tmdbId}          direct MKV link
//     ↳ Both called straight from browser
//
//  ④ yt-dlp backend  (last resort only — Render server)
//
// ROUTING LOGIC:
//   YouTube URL pasted          →  ① DL-MP3 quality list  (STV for metadata only)
//   Dailymotion/Vimeo/FB/other  →  ② STV
//   TMDB card clicked           →  ③ VidSrc player + MKV download button
//   Text search → TMDB hit      →  ③ VidSrc
//   Text search → no TMDB hit   →  ② STV gvsearch  →  ④ yt-dlp fallback
// ============================================================

// ============================================================
// 1. CONFIG
// ============================================================
const BACKEND_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://kizito-server.onrender.com';

const DLMP3_BASE   = 'https://api.download-lagu-mp3.com/@api/json';
const VIDSRC_EMBED = 'https://vidsrc.cc/v2/embed';
const VIDSRC_DL    = 'https://dl.vidsrc.vip';

const socket = io(BACKEND_URL);
let userSocketId = '';

// ── State ─────────────────────────────────────
let currentMode        = null;   // 'dlmp3' | 'stv' | 'vidsrc' | 'ytdlp'
let currentStvLinks    = [];
let currentStvTitle    = '';
let currentYtId        = null;
let currentDlMp3Links  = [];
let currentVidsrcId    = null;
let currentVidsrcType  = 'movie';
let currentVidsrcTitle = '';

// ============================================================
// 2. SOCKET  (progress bar for yt-dlp)
// ============================================================
socket.on('connect',    () => { userSocketId = socket.id; setDot(true); });
socket.on('disconnect', () => setDot(false));
setInterval(() => setDot(socket.connected), 5000);

function setDot(online) {
    const d = document.getElementById('statusDot');
    if (!d) return;
    d.style.backgroundColor = online ? '#2ecc71' : '#e74c3c';
    d.title = online ? 'OmniFetch Online' : 'OmniFetch Offline';
}

socket.on('progress', ({ percent }) => {
    const bar  = document.getElementById('progressBar');
    const txt  = document.getElementById('progressText');
    const wrap = document.getElementById('progressWrapper');
    if (percent === undefined || !bar) return;
    if (wrap) wrap.style.display = 'block';
    if (txt)  { txt.style.display = 'block'; txt.innerText = percent < 100 ? `Downloading: ${Math.round(percent)}%` : 'Done!'; }
    bar.style.width = Math.round(percent) + '%';
    if (percent >= 100) {
        if (navigator.vibrate) navigator.vibrate(200);
        setTimeout(() => { if (wrap) wrap.style.display = 'none'; if (txt) txt.style.display = 'none'; bar.style.width = '0%'; }, 4000);
    }
});

// ============================================================
// 3. UTILITIES
// ============================================================
const delay = ms => new Promise(r => setTimeout(r, ms));
function isUrl(s) { return /^https?:\/\//i.test(s.trim()); }

function extractYtId(url) {
    try {
        const u = new URL(url);
        if (u.hostname === 'youtu.be')            return u.pathname.slice(1).split('?')[0];
        if (u.hostname.includes('youtube.com')) {
            if (u.searchParams.get('v'))           return u.searchParams.get('v');
            const p = u.pathname.split('/');
            const i = p.findIndex(s => s === 'shorts' || s === 'embed');
            if (i !== -1)                          return p[i + 1];
        }
    } catch (_) {}
    return null;
}

function platformLabel(url) {
    if (!url) return 'Web';
    const u = url.toLowerCase();
    if (u.includes('youtube') || u.includes('youtu.be'))   return 'YouTube';
    if (u.includes('facebook') || u.includes('fb.watch'))  return 'Facebook';
    if (u.includes('tiktok'))                               return 'TikTok';
    if (u.includes('instagram'))                            return 'Instagram';
    if (u.includes('twitter') || u.includes('x.com'))      return 'Twitter/X';
    if (u.includes('vimeo'))                                return 'Vimeo';
    if (u.includes('dailymotion') || u.includes('dai.ly')) return 'Dailymotion';
    return 'Web';
}

function showError(msg) {
    const b = document.getElementById('errorBox');
    if (!b) { alert(msg); return; }
    b.innerText = msg; b.style.display = 'block';
    b.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function hideError() { const b = document.getElementById('errorBox'); if (b) b.style.display = 'none'; }

function setBtnLoading(label = 'Searching...') {
    const btn = document.getElementById('startBtn');
    if (btn) btn.disabled = true;
    const spn = document.getElementById('spinner');
    if (spn) spn.style.display = 'inline-block';
    const txt = document.getElementById('btnText');
    if (txt) txt.innerText = label;
}
function setBtnReady() {
    const btn = document.getElementById('startBtn');
    if (btn) btn.disabled = false;
    const spn = document.getElementById('spinner');
    if (spn) spn.style.display = 'none';
    const txt = document.getElementById('btnText');
    if (txt) txt.innerText = 'Fetch';
}
function setDlBtn(text, disabled = false) {
    const b = document.getElementById('downloadBtn');
    if (!b) return;
    b.innerText = text; b.disabled = disabled;
    b.style.animation  = disabled ? 'none' : '';
    b.style.background = disabled ? '#6c757d' : '';
}
function openResult() { document.getElementById('result').style.display = 'block'; }
function setSource(label) {
    const s = document.getElementById('sourceIndicator');
    if (!s) return;
    s.innerText = label; s.style.display = label ? 'inline-block' : 'none';
}
function setTitle(t) { const el = document.getElementById('title'); if (el) el.innerText = t || 'Unknown Title'; }
function setPreview(html) {
    const el = document.getElementById('videoPreview');
    if (!el) return;
    el.innerHTML = html; window.myPlayer = null;
}

// ============================================================
// 4. ENGINE ①  —  download-lagu-mp3  (vermeauplomberie)
//    YouTube only — browser-side, no CORS issues
// ============================================================

async function dlmp3_videos(ytId) {
    const res  = await fetch(`${DLMP3_BASE}/videos/${ytId}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`DL-MP3 videos ${res.status}`);
    const data = await res.json();
    if (!data.vidInfo) throw new Error('No video info from DL-MP3');
    return Object.values(data.vidInfo)
        .filter(v => v.dloadUrl)
        .map(v => ({
            quality : parseInt(String(v.quality || '0').replace(/p$/i, '')) || 0,
            size    : v.rSize || '',
            url     : v.dloadUrl.startsWith('//') ? 'https:' + v.dloadUrl : v.dloadUrl,
            ftype   : (v.ftype || 'mp4').toLowerCase(),
        }))
        .sort((a, b) => b.quality - a.quality);
}

async function dlmp3_audio(ytId) {
    const res  = await fetch(`${DLMP3_BASE}/mp3/${ytId}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`DL-MP3 mp3 ${res.status}`);
    const data = await res.json();
    const info = data.vidInfo?.['0'];
    if (!info?.dloadUrl) throw new Error('No MP3 link from DL-MP3');
    return {
        url     : info.dloadUrl.startsWith('//') ? 'https:' + info.dloadUrl : info.dloadUrl,
        bitrate : info.bitrate || 320,
        size    : info.mp3size || '',
    };
}

function showYoutubeResult(ytId, title, thumbnail, sourceUrl) {
    currentMode       = 'dlmp3';
    currentYtId       = ytId;
    currentStvTitle   = title;
    window.currentDownloadUrl = sourceUrl;

    setTitle(title);
    setSource('YouTube');

    if (typeof csPlayer !== 'undefined') {
        setPreview('');
        window.myPlayer = new csPlayer('#videoPreview', { id: ytId, theme: 'default', autoplay: false });
    } else if (thumbnail) {
        setPreview(`<img src="${thumbnail}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;" onerror="this.style.display='none'">`);
    }

    // Build selector from real quality links fetched from DL-MP3
    const sel = document.getElementById('formatSelect');
    if (sel) {
        sel.innerHTML = currentDlMp3Links.map((l, i) =>
            `<option value="dlmp3_video_${i}">📼 MP4 — ${l.quality}p${l.size ? ' — ' + l.size : ''}</option>`
        ).join('') + `<option value="dlmp3_audio">🎵 MP3 — Direct audio download</option>`;
    }

    setDlBtn('⬇ Download Now', false);
    openResult();
    addToHistory(title, thumbnail || '', sourceUrl, 'dlmp3');
}

// ============================================================
// 5. ENGINE ②  —  SaveTheVideo  (any non-YouTube URL)
//    Proxied through server to avoid CORS
// ============================================================

async function stv_fetch(url, onStatus) {
    if (onStatus) onStatus('Analyzing...');
    const startRes = await fetch(
        `${BACKEND_URL}/api/stv/start?url=${encodeURIComponent(url)}`,
        { signal: AbortSignal.timeout(15000) }
    );
    if (!startRes.ok) throw new Error(`STV start: ${startRes.status}`);
    const start = await startRes.json();
    if (!start.id) throw new Error(start.error || 'STV: no task ID');

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        await delay(1500);
        if (onStatus) onStatus('Processing...');
        const checkRes = await fetch(
            `${BACKEND_URL}/api/stv/check?id=${encodeURIComponent(start.id)}`,
            { signal: AbortSignal.timeout(10000) }
        );
        if (!checkRes.ok) throw new Error(`STV check: ${checkRes.status}`);
        const data = await checkRes.json();
        if (data.status === 'active') continue;
        if (data.links || data.status === 'done') return data;
        if (data.error || data.status === 'error') throw new Error(data.error || 'STV processing failed');
    }
    throw new Error('SaveTheVideo timed out');
}

function showStvResult(data, sourceUrl) {
    currentMode     = 'stv';
    currentStvLinks = data.links || [];
    currentStvTitle = data.title || 'Unknown';
    window.currentDownloadUrl = sourceUrl;

    setTitle(currentStvTitle);
    setSource(platformLabel(sourceUrl));

    const ytId = extractYtId(sourceUrl);
    if (typeof csPlayer !== 'undefined' && ytId) {
        setPreview('');
        window.myPlayer = new csPlayer('#videoPreview', { id: ytId, theme: 'default', autoplay: false });
    } else if (data.thumbnail) {
        setPreview(`<img src="${data.thumbnail}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;" onerror="this.style.display='none'">`);
    } else {
        setPreview(`<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:#111;border-radius:8px;font-size:48px;">🎬</div>`);
    }

    const meta = [data.uploader, data.duration].filter(Boolean).join(' — ');
    let metaEl = document.getElementById('mediaMeta');
    if (!metaEl) {
        metaEl = Object.assign(document.createElement('div'), { id: 'mediaMeta' });
        metaEl.style.cssText = 'font-size:11px;opacity:0.6;margin-bottom:10px;';
        const titleEl = document.getElementById('title');
        if (titleEl) titleEl.parentNode.insertBefore(metaEl, titleEl.nextSibling);
    }
    metaEl.innerText = meta;

    buildStvSelector(currentStvLinks);
    setDlBtn('⬇ Download Now', false);
    openResult();
    addToHistory(currentStvTitle, data.thumbnail || '', sourceUrl, 'stv');
}

function buildStvSelector(links) {
    const sel = document.getElementById('formatSelect');
    if (!sel || !links.length) return;
    sel.innerHTML = '';
    function parseQ(q) {
        if (!q) return 0;
        const n = parseInt(String(q).replace(/p$/i, ''));
        if (!isNaN(n)) return n;
        return ({ 'full hd': 1080, '4k': 2160, 'uhd': 2160, 'hd': 720, 'sd': 480, 'ld': 360 })[String(q).toLowerCase()] || 0;
    }
    const videos = links.filter(l => l.type !== 'mp3' && l.type !== 'audio').sort((a, b) => parseQ(b.quality) - parseQ(a.quality));
    const audios = links.filter(l => l.type === 'mp3'  || l.type === 'audio');

    videos.forEach((l, i) => {
        const opt = document.createElement('option');
        opt.value = `stv_video_${i}`;
        const q = l.quality    ? ` — ${l.quality}`      : '';
        const r = l.resolution ? ` — (${l.resolution})` : '';
        const k = l.bitrate    ? ` — ${l.bitrate}Kbps`  : '';
        const s = l.size       ? ` — ${l.size}`         : '';
        opt.text = `📼 ${(l.type || 'MP4').toUpperCase()}${q}${r}${k}${s}`;
        if (i === 0) opt.selected = true;
        sel.appendChild(opt);
    });
    audios.forEach((l, i) => {
        const opt = document.createElement('option');
        opt.value = `stv_audio_${i}`;
        opt.text  = `🎵 ${(l.type || 'MP3').toUpperCase()} — Audio${l.quality ? ' ' + l.quality : ''}${l.size ? ' — ' + l.size : ''}`;
        sel.appendChild(opt);
    });
    if (!audios.length) {
        const opt = document.createElement('option');
        opt.value = 'ytdlp_mp3';
        opt.text  = '🎵 MP3 Audio — (via server)';
        sel.appendChild(opt);
    }
}

// ============================================================
// 6. ENGINE ③  —  VidSrc
//    Watch via vidsrc.cc  |  Download via dl.vidsrc.vip
// ============================================================

function playWithVidSrc(tmdbId, title, type = 'movie', thumb = '') {
    currentMode        = 'vidsrc';
    currentStvLinks    = [];
    currentYtId        = null;
    currentDlMp3Links  = [];
    currentVidsrcId    = tmdbId;
    currentVidsrcType  = type;
    currentVidsrcTitle = title || '';

    const embedPath = type === 'tv' ? `${tmdbId}/1/1` : `${tmdbId}`;  // TV = S1E1 default

    setPreview(`
        <iframe
            src="${VIDSRC_EMBED}/${type}/${embedPath}"
            width="100%" height="100%"
            frameborder="0" allowfullscreen
            allow="autoplay; fullscreen; picture-in-picture"
            referrerpolicy="origin"
            style="border-radius:8px;">
        </iframe>`);

    setTitle(title);
    setSource(type === 'tv' ? '📺 TV Series' : '🎬 Movie');

    // Format selector:
    //   vip_mkv         = dl.vidsrc.vip direct MKV  (instant, no server)
    //   stv_title_search = STV searches YouTube for this title → MP4
    //   dlmp3_title_mp3  = DL-MP3 searches YouTube for audio  → MP3
    const sel = document.getElementById('formatSelect');
    if (sel) {
        sel.innerHTML = `
            <option value="vip_mkv">🎬 MKV — Direct from vidsrc.vip  ⚡ Fastest</option>
            <option value="stv_title_search">📹 MP4 — Search via SaveTheVideo</option>
            <option value="dlmp3_title_mp3">🎵 MP3 — Search via YouTube</option>`;
    }

    setDlBtn('⬇ Download Now', false);
    openResult();
    addToHistory(title, thumb, String(tmdbId), 'vidsrc', type);
}

// ============================================================
// 7. MAIN FETCH
// ============================================================

async function fetchVideo() {
    const raw = document.getElementById('videoUrl')?.value?.trim();
    if (!raw) { showError('Please enter a URL or a video name!'); return; }

    hideError();
    setBtnLoading('Searching...');
    document.getElementById('result').style.display = 'none';
    currentMode = null; currentYtId = null; currentStvLinks = []; currentDlMp3Links = [];

    try {

        // ── A: Direct URL ──────────────────────────────────────
        if (isUrl(raw)) {
            const ytId = extractYtId(raw);

            if (ytId) {
                // YouTube → engine ①
                setBtnLoading('Loading YouTube...');
                try {
                    // Fetch video qualities and metadata in parallel
                    const [vRes, metaRes] = await Promise.allSettled([
                        dlmp3_videos(ytId),
                        stv_fetch(raw, () => {}),   // STV just for title + thumbnail
                    ]);

                    const vLinks = vRes.status === 'fulfilled' ? vRes.value : [];
                    if (!vLinks.length) throw new Error('No video links from DL-MP3');
                    currentDlMp3Links = vLinks;

                    const meta  = metaRes.status === 'fulfilled' ? metaRes.value : {};
                    const title = meta.title     || `YouTube — ${ytId}`;
                    const thumb = meta.thumbnail || '';

                    showYoutubeResult(ytId, title, thumb, raw);
                } catch (e) {
                    console.warn('[DL-MP3]', e.message, '→ STV fallback');
                    try {
                        const data = await stv_fetch(raw, msg => setBtnLoading(msg));
                        showStvResult(data, raw);
                    } catch (e2) {
                        await fetchViaYtDlp(raw);
                    }
                }

            } else {
                // Non-YouTube → engine ②
                setBtnLoading('Analyzing...');
                try {
                    const data = await stv_fetch(raw, msg => setBtnLoading(msg));
                    showStvResult(data, raw);
                } catch (e) {
                    console.warn('[STV]', e.message, '→ yt-dlp');
                    await fetchViaYtDlp(raw);
                }
            }
            setBtnReady();
            return;
        }

        // ── B: 11-char YouTube ID shorthand ────────────────────
        if (/^[A-Za-z0-9_-]{11}$/.test(raw) && !raw.includes('.')) {
            document.getElementById('videoUrl').value = `https://www.youtube.com/watch?v=${raw}`;
            await fetchVideo();
            return;
        }

        // ── C: Text → TMDB multi-search → VidSrc ───────────────
        try {
            const r    = await fetch(`${BACKEND_URL}/api/searchmulti?q=${encodeURIComponent(raw)}`);
            const body = await r.json();
            const hits = (body.results || []).filter(x => x.media_type !== 'person');
            if (hits.length) {
                const m     = hits[0];
                const type  = m.media_type === 'tv' ? 'tv' : 'movie';
                const title = m.title || m.name || 'Unknown';
                const thumb = m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : '';
                playWithVidSrc(m.id, title, type, thumb);
                setBtnReady();
                return;
            }
        } catch (e) { console.warn('[TMDB]', e.message); }

        // ── D: No TMDB hit → STV gvsearch → yt-dlp ─────────────
        try {
            const data = await stv_fetch(`gvsearch1:${raw}`, msg => setBtnLoading(msg));
            showStvResult(data, `gvsearch1:${raw}`);
        } catch (e) {
            await fetchViaYtDlp(`gvsearch1:${raw}`);
        }

    } catch (e) {
        showError(e.message || 'Something went wrong.');
    }
    setBtnReady();
}

// ============================================================
// 8. DOWNLOAD HANDLER
// ============================================================

async function triggerDownload() {
    const sel    = document.getElementById('formatSelect');
    const format = sel?.value || '0';
    hideError();

    // ══ ENGINE ③: VidSrc mode ══════════════════════════════════
    if (currentMode === 'vidsrc') {

        // Direct MKV from dl.vidsrc.vip — no server needed
        if (format === 'vip_mkv') {
            browserDownload(
                `${VIDSRC_DL}/${currentVidsrcType}/${currentVidsrcId}`,
                `${currentVidsrcTitle || 'OmniFetch'}.mkv`
            );
            setDlBtn('✅ MKV Download Started!', false);
            setTimeout(() => setDlBtn('⬇ Download Now', false), 5000);
            return;
        }

        // STV search → MP4
        if (format === 'stv_title_search') {
            setDlBtn('🔍 Searching SaveTheVideo...', true);
            try {
                const infoRes = await fetch(`${BACKEND_URL}/api/info?url=${encodeURIComponent('gvsearch1:' + currentVidsrcTitle + ' full movie')}`);
                const info    = await infoRes.json();
                if (!info.url) throw new Error(info.error || 'No YouTube match');
                const data = await stv_fetch(info.url, () => {});
                currentMode     = 'stv';
                currentStvLinks = data.links || [];
                currentStvTitle = currentVidsrcTitle;
                buildStvSelector(currentStvLinks);
                setDlBtn('⬇ Select quality above & click again', false);
            } catch (e) {
                ytdlpDownload(`gvsearch1:${currentVidsrcTitle} full movie`, '480');
            }
            return;
        }

        // DL-MP3 search → MP3
        if (format === 'dlmp3_title_mp3') {
            setDlBtn('🎵 Searching YouTube audio...', true);
            try {
                const infoRes = await fetch(`${BACKEND_URL}/api/info?url=${encodeURIComponent('gvsearch1:' + currentVidsrcTitle + ' soundtrack')}`);
                const info    = await infoRes.json();
                const ytId    = extractYtId(info.url || '');
                if (!ytId) throw new Error('No YouTube ID');
                const mp3 = await dlmp3_audio(ytId);
                browserDownload(mp3.url, `${currentVidsrcTitle}.mp3`);
                setDlBtn(`✅ MP3 Ready! (${mp3.bitrate}kbps${mp3.size ? ' · ' + mp3.size : ''})`, false);
            } catch (e) {
                ytdlpDownload(`gvsearch1:${currentVidsrcTitle} soundtrack`, 'mp3');
            }
            setTimeout(() => setDlBtn('⬇ Download Now', false), 5000);
            return;
        }
    }

    // ══ ENGINE ①: YouTube / DL-MP3 mode ═══════════════════════
    if (currentMode === 'dlmp3' && currentYtId) {
        setDlBtn('⏳ Getting link...', true);
        try {
            if (format === 'dlmp3_audio') {
                const mp3 = await dlmp3_audio(currentYtId);
                browserDownload(mp3.url, `${currentStvTitle || 'OmniFetch'}.mp3`);
                setDlBtn(`✅ MP3 Ready!  (${mp3.bitrate}kbps${mp3.size ? ' · ' + mp3.size : ''})`, false);
            } else if (format.startsWith('dlmp3_video_')) {
                const idx  = parseInt(format.replace('dlmp3_video_', ''), 10);
                const link = currentDlMp3Links[idx] || currentDlMp3Links[0];
                if (!link) throw new Error('Quality not available');
                browserDownload(link.url, `${currentStvTitle || 'OmniFetch'}_${link.quality}p.${link.ftype}`);
                setDlBtn(`✅ ${link.quality}p${link.size ? '  (' + link.size + ')' : ''}  Downloading!`, false);
            } else {
                throw new Error('Unknown format');
            }
        } catch (e) {
            console.warn('[DL-MP3 dl]', e.message, '→ yt-dlp');
            ytdlpDownload(window.currentDownloadUrl, format === 'dlmp3_audio' ? 'mp3' : '480');
        }
        setTimeout(() => setDlBtn('⬇ Download Now', false), 5000);
        return;
    }

    // ══ ENGINE ②: SaveTheVideo mode ════════════════════════════
    if (currentMode === 'stv' && currentStvLinks.length) {
        if (format === 'ytdlp_mp3') {
            ytdlpDownload(window.currentDownloadUrl, 'mp3');
            return;
        }
        let link;
        if (format.startsWith('stv_video_')) {
            link = currentStvLinks.filter(l => l.type !== 'mp3' && l.type !== 'audio')[parseInt(format.replace('stv_video_', ''), 10)];
        } else if (format.startsWith('stv_audio_')) {
            link = currentStvLinks.filter(l => l.type === 'mp3' || l.type === 'audio')[parseInt(format.replace('stv_audio_', ''), 10)];
        }
        if (!link?.url) return showError('Link unavailable — try a different quality.');
        browserDownload(link.url, `${currentStvTitle || 'OmniFetch'}.${(link.type || 'mp4').toLowerCase()}`);
        setDlBtn(`✅ ${link.quality || 'Downloading'}...`, false);
        setTimeout(() => setDlBtn('⬇ Download Now', false), 5000);
        return;
    }

    // ══ ENGINE ④: yt-dlp fallback ══════════════════════════════
    const isAudio = format === 'ytdlp_mp3' || format === 'mp3';
    ytdlpDownload(window.currentDownloadUrl, isAudio ? 'mp3' : format);
}

function browserDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url; a.download = filename || ''; a.target = '_blank';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function ytdlpDownload(url, format) {
    if (!url) return showError('No media loaded!');
    setDlBtn('🚀 Preparing via server...', true);
    browserDownload(
        `${BACKEND_URL}/download?url=${encodeURIComponent(url)}&format=${encodeURIComponent(format)}&socketId=${encodeURIComponent(userSocketId)}`,
        ''
    );
    setTimeout(() => setDlBtn('⬇ Download Now', false), 5000);
}

// ============================================================
// 9. YT-DLP FALLBACK METADATA
// ============================================================

async function fetchViaYtDlp(input) {
    currentMode = 'ytdlp'; currentStvLinks = []; currentYtId = null; currentDlMp3Links = [];
    for (let attempt = 0; attempt <= 1; attempt++) {
        try {
            if (attempt > 0) setBtnLoading('Retrying...');
            const res  = await fetch(`${BACKEND_URL}/api/info?url=${encodeURIComponent(input)}`, { headers: { Accept: 'application/json' } });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Server error');
            window.currentDownloadUrl = data.url || input;

            // Upgrade to engine ① if the resolved URL is YouTube
            const ytId = extractYtId(data.url || input);
            if (ytId) {
                try {
                    const vLinks = await dlmp3_videos(ytId);
                    if (vLinks.length) {
                        currentDlMp3Links = vLinks;
                        currentYtId       = ytId;
                        showYoutubeResult(ytId, data.title || 'Unknown', data.thumbnail || '', data.url || input);
                        return;
                    }
                } catch (_) {}
            }

            setTitle(data.title);
            if (data.videoId && typeof csPlayer !== 'undefined') {
                setPreview(''); window.myPlayer = new csPlayer('#videoPreview', { id: data.videoId, theme: 'default', autoplay: false });
            } else if (data.thumbnail) {
                setPreview(`<img src="${data.thumbnail}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;" onerror="this.style.display='none'">`);
            }
            setSource(data.source || '');

            const sel = document.getElementById('formatSelect');
            if (sel) sel.innerHTML = `
                <option value="0">📹 MP4 — Best Quality</option>
                <option value="720">📹 MP4 — 720p</option>
                <option value="480">📹 MP4 — 480p</option>
                <option value="ytdlp_mp3">🎵 MP3 Audio</option>`;

            setDlBtn('⬇ Download Now', false);
            openResult();
            addToHistory(data.title || 'Unknown', data.thumbnail || '', window.currentDownloadUrl, 'ytdlp');
            return;
        } catch (e) {
            if (attempt >= 1) showError(`Error: ${e.message}`);
            else await delay(2000);
        }
    }
}

// ============================================================
// 10. HISTORY & SHARE
// ============================================================

function addToHistory(title, thumbnail, url, mode = 'stv', mediaType = 'movie') {
    let h = JSON.parse(localStorage.getItem('omni_history') || '[]');
    h = h.filter(i => i.url !== url);
    h.unshift({ title, thumbnail, url, mode, mediaType });
    localStorage.setItem('omni_history', JSON.stringify(h.slice(0, 5)));
    renderHistory();
}
function clearHistory() { localStorage.removeItem('omni_history'); renderHistory(); }

function renderHistory() {
    const history = JSON.parse(localStorage.getItem('omni_history') || '[]');
    const section = document.getElementById('historySection');
    const list    = document.getElementById('historyList');
    if (!section || !list) return;
    if (!history.length) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    list.innerHTML = history.map((item, i) => `
        <div class="history-item" data-index="${i}">
            <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">
                ${item.thumbnail
                    ? `<img src="${item.thumbnail}" style="width:60px;height:35px;object-fit:cover;border-radius:4px;" onerror="this.style.display='none'">`
                    : `<div style="width:60px;height:35px;background:var(--step-bg);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:18px;">🎬</div>`}
                <div style="font-weight:bold;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${item.title}</div>
            </div>
            <div class="copy-badge">${item.mode === 'vidsrc' ? '▶ STREAM' : 'RE-FETCH'}</div>
        </div>`).join('');

    list.querySelectorAll('.history-item').forEach(el => {
        const item = history[parseInt(el.dataset.index, 10)];
        el.addEventListener('click', () => {
            if (item.mode === 'vidsrc') {
                playWithVidSrc(item.url, item.title, item.mediaType || 'movie', item.thumbnail);
            } else {
                const inp = document.getElementById('videoUrl');
                if (inp) { inp.value = item.url; fetchVideo(); }
            }
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    });
}

function shareSite() {
    const d = { title: 'OmniFetch', text: 'Download any video — Universal Media Pathfinder', url: window.location.href };
    if (navigator.share) { navigator.share(d).catch(() => {}); }
    else navigator.clipboard.writeText(window.location.href)
        .then(() => { const b = document.querySelector('.share-btn'); if (b) { const o = b.innerText; b.innerText = '✅ Copied!'; setTimeout(() => b.innerText = o, 2500); } })
        .catch(() => prompt('Copy this link:', window.location.href));
}

// ============================================================
// 11. TRENDING & SEARCH
// ============================================================

async function loadTrendingMovies() {
    const grid = document.getElementById('trendingGrid');
    if (!grid) return;
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;opacity:0.6;">Loading trending...</div>';
    try {
        const res = await fetch(`${BACKEND_URL}/api/trending`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (data.results) renderMovieGrid(data.results);
    } catch { grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;opacity:0.5;padding:20px;">Could not load trending.</div>'; }
}

async function searchMovies() {
    const grid  = document.getElementById('trendingGrid');
    const query = document.getElementById('searchInput')?.value?.trim();
    if (!query) return loadTrendingMovies();
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;opacity:0.6;">Searching...</div>';
    try {
        const res  = await fetch(`${BACKEND_URL}/api/searchmulti?q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        const hits = (data.results || []).filter(r => r.media_type !== 'person');
        if (!hits.length) { grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;opacity:0.6;">No results.</p>'; return; }
        renderMovieGrid(hits);
    } catch {
        try {
            const r2 = await fetch(`${BACKEND_URL}/api/search?q=${encodeURIComponent(query)}`);
            const d2 = await r2.json();
            if (d2.results?.length) renderMovieGrid(d2.results);
            else grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;opacity:0.6;">No results.</p>';
        } catch { grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:#e74c3c;">Search failed.</p>'; }
    }
}

function renderMovieGrid(movies) {
    const grid = document.getElementById('trendingGrid');
    if (!grid) return;
    grid.innerHTML = movies.slice(0, 10).map((m, i) => {
        const isTV  = m.media_type === 'tv';
        const title = m.title || m.name || 'Unknown';
        const src   = m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : `https://placehold.co/500x750/1e1e1e/888?text=No+Poster`;
        return `
        <div class="movie-card" data-index="${i}">
            ${isTV ? '<span class="tv-badge">TV</span>' : ''}
            <img class="movie-poster" src="${src}" onerror="this.src='https://placehold.co/500x750/1e1e1e/888?text=No+Poster'" loading="lazy">
            <div class="movie-info">${title}</div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.movie-card').forEach((card, i) => {
        card.addEventListener('click', () => {
            const m     = movies[i];
            const type  = m.media_type === 'tv' ? 'tv' : 'movie';
            const title = m.title || m.name || 'Unknown';
            const thumb = m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : '';
            playWithVidSrc(m.id, title, type, thumb);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    });
}

// ============================================================
// 12. INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    renderHistory();
    loadTrendingMovies();
    document.getElementById('searchBtn')?.addEventListener('click', searchMovies);
    document.getElementById('searchInput')?.addEventListener('keypress', e => { if (e.key === 'Enter') searchMovies(); });
    document.getElementById('videoUrl')?.addEventListener('keypress',   e => { if (e.key === 'Enter') fetchVideo(); });

    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
        const saved = localStorage.getItem('omni_theme') || 'light';
        document.documentElement.setAttribute('data-theme', saved);
        themeBtn.innerText = saved === 'light' ? '🌙 Mode' : '☀️ Mode';
        themeBtn.addEventListener('click', () => {
            const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', next);
            themeBtn.innerText = next === 'light' ? '🌙 Mode' : '☀️ Mode';
            localStorage.setItem('omni_theme', next);
        });
    }
});