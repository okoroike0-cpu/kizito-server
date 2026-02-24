// ============================================================
// OMNIFETCH — kizito2.js  (v10 — Final)
//
// ✅ NO hardcoded API tokens or secrets in this file.
//    All sensitive config (YOUTUBE_COOKIES) lives in
//    Render → Environment Variables only.
//
// MODE A — URL PASTE  →  download card
//   YouTube URL   →  ① DL-MP3 qualities + STV metadata
//   Any other URL →  ② STV proxy quality list
//   Any fallback  →  ③ yt-dlp server (supports adult sites,
//                      Dailymotion, Vimeo, Twitter, TikTok, etc.)
//   Total failure →  STV browser tab opened as last resort
//
// MODE B — TEXT SEARCH  →  MP3Juice-style results list
//   /api/search on server runs ytsearch via yt-dlp (fast)
//   Each result: [🎵 MP3] [📹 MP4 ▾ quality] [▶ Play]
//   MP3  → dlmp3_audio(ytId)       → direct download
//   MP4  → dlmp3_videos(ytId)      → quality picker popup → direct download
//   Play → floating mini-player
// ============================================================

const BACKEND_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3000'
    : 'https://kizito-server.onrender.com';

const DLMP3_BASE = 'https://api.download-lagu-mp3.com/@api/json';
const STV_HOME   = 'https://www.savethevideo.com/home';

const socket = io(BACKEND_URL);
let socketId = '';

// ── Download-card state ───────────────────────
let dlMode     = null;   // 'dlmp3' | 'stv' | 'ytdlp'
let stvLinks   = [];
let stvTitle   = '';
let activeYtId = null;
let dlmp3Links = [];

// ══════════════════════════════════════════════
// SOCKET
// ══════════════════════════════════════════════
socket.on('connect',    () => { socketId = socket.id; setDot(true); });
socket.on('disconnect', () => setDot(false));
setInterval(() => setDot(socket.connected), 5000);

function setDot(on) {
    const d = document.getElementById('statusDot');
    if (!d) return;
    d.style.background = on ? '#16a34a' : '#dc2626';
    d.title = on ? 'Online' : 'Offline';
}

socket.on('progress', ({ percent }) => {
    if (percent == null) return;
    const wrap = document.getElementById('progressWrapper');
    const bar  = document.getElementById('progressBar');
    const txt  = document.getElementById('progressText');
    if (wrap) wrap.style.display = 'block';
    if (bar)  bar.style.width = Math.round(percent) + '%';
    if (txt)  { txt.style.display = 'block'; txt.textContent = percent < 100 ? `Downloading ${Math.round(percent)}%…` : '✅ Done!'; }
    if (percent >= 100) {
        if (navigator.vibrate) navigator.vibrate(200);
        setTimeout(() => {
            if (wrap) wrap.style.display = 'none';
            if (txt)  txt.style.display  = 'none';
            if (bar)  bar.style.width    = '0%';
        }, 4000);
    }
});

// ══════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════
const wait  = ms => new Promise(r => setTimeout(r, ms));
const isUrl = s  => /^https?:\/\//i.test(s.trim());

function getYtId(url) {
    try {
        const u = new URL(url);
        if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
        if (u.hostname.includes('youtube.com')) {
            if (u.searchParams.get('v')) return u.searchParams.get('v');
            const parts = u.pathname.split('/');
            const idx   = parts.findIndex(p => p === 'shorts' || p === 'embed');
            if (idx !== -1) return parts[idx + 1];
        }
    } catch (_) {}
    return null;
}

function platformOf(url) {
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

function fmtSecs(s) {
    if (!s || isNaN(s)) return '';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
}

// ── UI helpers ────────────────────────────────
function showErr(msg) {
    const b = document.getElementById('errorBox');
    if (!b) return;
    b.textContent = msg; b.style.display = 'block';
}
function hideErr() { const b = document.getElementById('errorBox'); if (b) b.style.display = 'none'; }

function setBtnLoading(label = 'Searching…') {
    const btn = document.getElementById('startBtn'); if (btn) btn.disabled = true;
    const sp  = document.getElementById('spinner');  if (sp)  sp.style.display = 'inline-block';
    const tx  = document.getElementById('btnText');  if (tx)  tx.textContent = label;
}
function setBtnReady(label = 'Search') {
    const btn = document.getElementById('startBtn'); if (btn) btn.disabled = false;
    const sp  = document.getElementById('spinner');  if (sp)  sp.style.display = 'none';
    const tx  = document.getElementById('btnText');  if (tx)  tx.textContent = label;
}
function setDlBtn(text, disabled = false) {
    const b = document.getElementById('downloadBtn');
    if (!b) return;
    b.textContent = text; b.disabled = disabled;
    b.style.animation  = disabled ? 'none' : '';
    b.style.background = disabled ? '#6b7280' : '';
}

function showDownloadCard() {
    document.getElementById('downloadCard').style.display  = 'block';
    document.getElementById('searchResults').style.display = 'none';
    closeQualityPicker();
}
function showSearchResults() {
    document.getElementById('searchResults').style.display = 'block';
    document.getElementById('downloadCard').style.display  = 'none';
}
function hideAll() {
    document.getElementById('downloadCard').style.display  = 'none';
    document.getElementById('searchResults').style.display = 'none';
}

function setDlTitle(t) { const e = document.getElementById('dlTitle'); if (e) e.textContent = t || 'Unknown'; }
function setDlMeta(parts) { const e = document.getElementById('dlMeta'); if (e) e.textContent = parts.filter(Boolean).join('  ·  '); }
function setChip(label) {
    const s = document.getElementById('sourceChip');
    if (!s) return;
    s.textContent = label; s.style.display = label ? 'inline-block' : 'none';
}
function setPreview(html) {
    const el = document.getElementById('videoPreview');
    if (!el) return;
    el.innerHTML = html; window.myPlayer = null;
}

// ══════════════════════════════════════════════
// ENGINE ①  download-lagu-mp3  (YouTube direct)
// ══════════════════════════════════════════════

async function dlmp3_videos(ytId) {
    const res  = await fetch(`${DLMP3_BASE}/videos/${ytId}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`DL-MP3 videos ${res.status}`);
    const data = await res.json();
    if (!data.vidInfo) throw new Error('No vidInfo');
    return Object.values(data.vidInfo)
        .filter(v => v.dloadUrl)
        .map(v => ({
            quality : parseInt(String(v.quality || '0').replace(/p$/i, '')) || 0,
            size    : v.rSize  || '',
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
    if (!info?.dloadUrl) throw new Error('No MP3 link');
    return {
        url     : info.dloadUrl.startsWith('//') ? 'https:' + info.dloadUrl : info.dloadUrl,
        bitrate : info.bitrate || 320,
        size    : info.mp3size || '',
    };
}

// ══════════════════════════════════════════════
// ENGINE ②  SaveTheVideo  (any URL)
// ══════════════════════════════════════════════

async function stv_fetch(url, onStatus) {
    if (onStatus) onStatus('Analyzing…');
    const startR = await fetch(
        `${BACKEND_URL}/api/stv/start?url=${encodeURIComponent(url)}`,
        { signal: AbortSignal.timeout(15000) }
    );
    if (!startR.ok) throw new Error(`STV start ${startR.status}`);
    const start = await startR.json();
    if (!start.id) throw new Error(start.error || 'STV: no task ID');

    const deadline = Date.now() + 65000;
    while (Date.now() < deadline) {
        await wait(1500);
        if (onStatus) onStatus('Processing…');
        const checkR = await fetch(
            `${BACKEND_URL}/api/stv/check?id=${encodeURIComponent(start.id)}`,
            { signal: AbortSignal.timeout(10000) }
        );
        if (!checkR.ok) throw new Error(`STV check ${checkR.status}`);
        const data = await checkR.json();
        if (data.status === 'active') continue;
        if (data.links || data.status === 'done') return data;
        if (data.error  || data.status === 'error') throw new Error(data.error || 'STV failed');
    }
    throw new Error('SaveTheVideo timed out');
}

function stvBrowserFallback(url) {
    if (!isUrl(url)) return;
    window.open(`${STV_HOME}?url=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer');
    showErr('⚠️ Our proxy failed — SaveTheVideo.com opened in a new tab. Paste your link there.');
}

function stvQualityLabel(l) {
    const icon  = (l.type === 'mp3' || l.type === 'audio') ? '🎵' : '📼';
    const type  = (l.type || 'MP4').toUpperCase();
    const parts = [`${icon} ${type}`];
    if (l.quality) {
        const q = String(l.quality);
        if (/^(2160|4k|uhd)/i.test(q))       parts.push('4K');
        else if (/^(1080|full.?hd)/i.test(q)) parts.push('Full HD');
        else if (/^(720|hd)/i.test(q))        parts.push('HD');
        else if (/^(480|sd)/i.test(q))        parts.push('SD');
        else if (/^(360|ld)/i.test(q))        parts.push('SD 360p');
        else                                   parts.push(q);
    }
    if (l.resolution) parts.push(`(${l.resolution})`);
    if (l.bitrate)    parts.push(`${l.bitrate}Kbps`);
    if (l.size)       parts.push(l.size);
    return parts.join(' — ');
}

function buildStvSelector(links) {
    const sel = document.getElementById('formatSelect');
    if (!sel || !links.length) return;
    sel.innerHTML = '';

    function parseQ(q) {
        if (!q) return 0;
        const n = parseInt(String(q).replace(/p$/i, ''));
        if (!isNaN(n)) return n;
        return ({'4k':2160,'uhd':2160,'full hd':1080,'hd':720,'sd':480,'ld':360})[String(q).toLowerCase()] || 0;
    }

    const videos = links.filter(l => l.type !== 'mp3' && l.type !== 'audio')
                        .sort((a, b) => parseQ(b.quality) - parseQ(a.quality));
    const audios = links.filter(l => l.type === 'mp3'  || l.type === 'audio');

    videos.forEach((l, i) => {
        const o = document.createElement('option');
        o.value = `stv_video_${i}`; o.text = stvQualityLabel(l);
        if (i === 0) o.selected = true;
        sel.appendChild(o);
    });
    audios.forEach((l, i) => {
        const o = document.createElement('option');
        o.value = `stv_audio_${i}`; o.text = stvQualityLabel(l);
        sel.appendChild(o);
    });
    if (!audios.length) {
        const o = document.createElement('option');
        o.value = 'ytdlp_mp3'; o.text = '🎵 MP3 Audio — (via server)';
        sel.appendChild(o);
    }
}

// ══════════════════════════════════════════════
// DOWNLOAD CARD — show helpers
// ══════════════════════════════════════════════

function showYtResult(ytId, title, thumbnail, uploader, duration, sourceUrl) {
    dlMode     = 'dlmp3';
    activeYtId = ytId;
    stvTitle   = title;
    window.currentDownloadUrl = sourceUrl;

    setDlTitle(title);
    setDlMeta([uploader, duration]);
    setChip('YouTube');

    if (typeof csPlayer !== 'undefined') {
        setPreview('');
        window.myPlayer = new csPlayer('#videoPreview', { id: ytId, theme: 'default', autoplay: false });
    } else if (thumbnail) {
        setPreview(`<img src="${thumbnail}" alt="" onerror="this.style.display='none'">`);
    }

    const sel = document.getElementById('formatSelect');
    if (sel) {
        sel.innerHTML =
            dlmp3Links.map((l, i) =>
                `<option value="dlmp3_video_${i}">📼 MP4 — ${l.quality}p${l.size ? ' — ' + l.size : ''}</option>`
            ).join('') +
            `<option value="dlmp3_audio">🎵 MP3 — Direct audio</option>`;
    }

    setDlBtn('⬇ Download Now');
    showDownloadCard();
    addHistory(title, thumbnail || '', sourceUrl, 'dlmp3');
}

function showStvResult(data, sourceUrl) {
    dlMode   = 'stv';
    stvLinks = data.links || [];
    stvTitle = data.title || 'Unknown';
    window.currentDownloadUrl = sourceUrl;

    setDlTitle(stvTitle);
    setDlMeta([data.uploader, data.duration]);
    setChip(platformOf(sourceUrl));

    const vid = getYtId(sourceUrl);
    if (typeof csPlayer !== 'undefined' && vid) {
        setPreview('');
        window.myPlayer = new csPlayer('#videoPreview', { id: vid, theme: 'default', autoplay: false });
    } else if (data.thumbnail) {
        setPreview(`<img src="${data.thumbnail}" alt="" onerror="this.style.display='none'">`);
    } else {
        setPreview(`<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:#111;font-size:44px;">🎬</div>`);
    }

    buildStvSelector(stvLinks);
    setDlBtn('⬇ Download Now');
    showDownloadCard();
    addHistory(stvTitle, data.thumbnail || '', sourceUrl, 'stv');
}

// ══════════════════════════════════════════════
// QUALITY PICKER POPUP  (for MP4 in search results)
// A small dropdown that appears near the MP4 button
// ══════════════════════════════════════════════

let pickerTarget = null;  // the button that opened the picker

function closeQualityPicker() {
    const p = document.getElementById('qualityPicker');
    if (p) p.remove();
    pickerTarget = null;
}

async function openQualityPicker(btn, ytId, title, thumbnail) {
    // If same button clicked again, close it
    if (pickerTarget === btn) { closeQualityPicker(); return; }
    closeQualityPicker();
    pickerTarget = btn;

    const picker = document.createElement('div');
    picker.id = 'qualityPicker';
    picker.style.cssText = `
        position:absolute; z-index:200;
        background:var(--card); border:1px solid var(--border);
        border-radius:10px; padding:8px; min-width:220px;
        box-shadow:0 8px 24px rgba(0,0,0,.15); font-size:12px;`;
    picker.innerHTML = `<div style="padding:6px 8px;opacity:.6;font-weight:700;">Loading qualities…</div>`;

    // Position below the button
    btn.style.position = 'relative';
    btn.parentNode.style.position = 'relative';
    btn.insertAdjacentElement('afterend', picker);

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function outsideClick(e) {
            if (!picker.contains(e.target) && e.target !== btn) {
                closeQualityPicker();
                document.removeEventListener('click', outsideClick);
            }
        });
    }, 100);

    try {
        const vids = await dlmp3_videos(ytId);
        if (!vids.length) throw new Error('No qualities');
        picker.innerHTML = vids.map((v, i) =>
            `<div class="qp-opt" data-i="${i}" style="padding:7px 10px;cursor:pointer;border-radius:7px;
             display:flex;justify-content:space-between;align-items:center;gap:12px;
             transition:background .15s;">
                <span>📼 ${v.quality}p</span>
                <span style="opacity:.55;font-size:11px;">${v.size || ''}</span>
             </div>`
        ).join('') +
        `<div style="border-top:1px solid var(--border);margin:5px 0;"></div>
         <div class="qp-opt qp-mp3" style="padding:7px 10px;cursor:pointer;border-radius:7px;
             display:flex;justify-content:space-between;align-items:center;
             transition:background .15s;">
             <span>🎵 MP3 Audio</span>
         </div>`;

        picker.querySelectorAll('.qp-opt').forEach(opt => {
            opt.addEventListener('mouseenter', () => opt.style.background = 'var(--muted)');
            opt.addEventListener('mouseleave', () => opt.style.background = '');
        });

        // Video quality clicks
        picker.querySelectorAll('.qp-opt:not(.qp-mp3)').forEach(opt => {
            opt.addEventListener('click', async () => {
                const i    = parseInt(opt.dataset.i, 10);
                const link = vids[i];
                closeQualityPicker();
                btn.textContent = `⏳ ${link.quality}p…`; btn.disabled = true;
                dl(link.url, `${title}_${link.quality}p.${link.ftype}`);
                addHistory(title, thumbnail, `https://www.youtube.com/watch?v=${ytId}`, 'dlmp3');
                setTimeout(() => { btn.textContent = '📹 MP4 ▾'; btn.disabled = false; }, 6000);
            });
        });

        // MP3 click
        picker.querySelector('.qp-mp3')?.addEventListener('click', async () => {
            closeQualityPicker();
            btn.textContent = '⏳ MP3…'; btn.disabled = true;
            try {
                const mp3 = await dlmp3_audio(ytId);
                dl(mp3.url, `${title}.mp3`);
                addHistory(title, thumbnail, `https://www.youtube.com/watch?v=${ytId}`, 'dlmp3');
            } catch (e) {
                ytdlpDownload(`https://www.youtube.com/watch?v=${ytId}`, 'mp3');
            }
            setTimeout(() => { btn.textContent = '📹 MP4 ▾'; btn.disabled = false; }, 6000);
        });

    } catch (e) {
        picker.innerHTML = `<div style="padding:8px 10px;color:#dc2626;">Failed — using server fallback</div>`;
        setTimeout(() => {
            closeQualityPicker();
            ytdlpDownload(`https://www.youtube.com/watch?v=${ytId}`, '480');
        }, 1200);
    }
}

// ══════════════════════════════════════════════
// MODE B — TEXT SEARCH → results list
// ══════════════════════════════════════════════

async function runSearch(query) {
    setBtnLoading('Searching…');
    hideErr();
    hideAll();
    closeQualityPicker();

    // Show a friendly nudge if the server takes > 15s (Render free tier cold start)
    const slowTimer = setTimeout(() => {
        setBtnLoading('Still searching…');
        showErr('⏳ Server is waking up — this can take up to 30s on first use. Please wait…');
    }, 15000);

    let results = [];

    try {
        const controller = new AbortController();
        const hardTimeout = setTimeout(() => controller.abort(), 45000);

        const res  = await fetch(
            `${BACKEND_URL}/api/search?q=${encodeURIComponent(query)}&limit=12`,
            { signal: controller.signal }
        );
        clearTimeout(hardTimeout);
        const data = await res.json();
        if (data.results?.length) results = data.results;
        else if (data.error) throw new Error(data.error);
    } catch (e) {
        clearTimeout(slowTimer);
        const msg = e.name === 'AbortError'
            ? 'Search timed out. The server may be sleeping — wait 30s and try again.'
            : (e.message || 'Search failed. Try a different name or paste a direct URL.');
        console.warn('[search]', e.message);
        showErr(msg);
        setBtnReady();
        return;
    }

    clearTimeout(slowTimer);
    setBtnReady();
    hideErr();  // clear the "waking up" message if results came back

    if (!results.length) {
        showErr('No results found. Try different keywords or paste a direct URL.');
        return;
    }

    renderSearchResults(results, query);
}

function renderSearchResults(results, query) {
    const section = document.getElementById('searchResults');
    const list    = document.getElementById('resultsList');
    const label   = document.getElementById('resultsLabel');
    if (!section || !list) return;

    label.textContent = `Results for "${query}"`;
    list.innerHTML = '';

    results.forEach(item => {
        const ytId    = item.id       || '';
        const title   = item.title    || 'Unknown';
        const thumb   = item.thumbnail || '';
        const dur     = item.duration  || '';
        const channel = item.channel   || '';

        const row = document.createElement('div');
        row.className = 'result-item';
        row.innerHTML = `
            ${thumb
                ? `<img class="result-thumb" src="${thumb}" loading="lazy" onerror="this.style.display='none'">`
                : `<div class="result-thumb-ph">🎵</div>`}
            <div class="result-info">
                <div class="result-title" title="${title.replace(/"/g,'&quot;')}">${title}</div>
                <div class="result-meta">${[channel, dur].filter(Boolean).join('  ·  ')}</div>
            </div>
            <div class="result-actions">
                <button class="btn-mp3" title="Download MP3">🎵 MP3</button>
                <button class="btn-mp4" title="Choose video quality">📹 MP4 ▾</button>
                <button class="btn-play" title="Play in mini player">▶ Play</button>
            </div>`;

        // ── MP3 ──
        row.querySelector('.btn-mp3').addEventListener('click', async function () {
            if (!ytId) return showErr('No YouTube ID.');
            this.textContent = '⏳…'; this.disabled = true;
            try {
                const mp3 = await dlmp3_audio(ytId);
                dl(mp3.url, `${title}.mp3`);
                this.textContent = '✅ MP3!';
                addHistory(title, thumb, `https://www.youtube.com/watch?v=${ytId}`, 'dlmp3');
            } catch (e) {
                ytdlpDownload(`https://www.youtube.com/watch?v=${ytId}`, 'mp3');
                this.textContent = '🚀 Server';
            }
            const btn = this;
            setTimeout(() => { btn.textContent = '🎵 MP3'; btn.disabled = false; }, 6000);
        });

        // ── MP4 ▾ (quality picker) ──
        row.querySelector('.btn-mp4').addEventListener('click', function () {
            if (!ytId) return showErr('No YouTube ID.');
            openQualityPicker(this, ytId, title, thumb);
        });

        // ── Play ──
        row.querySelector('.btn-play').addEventListener('click', function () {
            if (!ytId) return showErr('No YouTube ID.');
            openMiniPlayer(ytId, title);
        });

        list.appendChild(row);
    });

    showSearchResults();
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ══════════════════════════════════════════════
// MINI PLAYER
// ══════════════════════════════════════════════

function openMiniPlayer(ytId, title) {
    const mp    = document.getElementById('miniPlayer');
    const inner = document.getElementById('miniPlayerInner');
    const ttl   = document.getElementById('miniPlayerTitle');
    if (!mp || !inner) return;

    ttl.textContent = title || 'Now Playing';
    if (typeof csPlayer !== 'undefined') {
        inner.innerHTML = '';
        window.miniCsPlayer = new csPlayer('#miniPlayerInner', { id: ytId, theme: 'default', autoplay: true });
    } else {
        inner.innerHTML = `<iframe src="https://www.youtube.com/embed/${ytId}?autoplay=1"
            width="100%" height="100%" frameborder="0" allowfullscreen
            allow="autoplay; fullscreen"></iframe>`;
    }
    mp.style.display = 'block';
    mp.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function closeMiniPlayer() {
    const mp    = document.getElementById('miniPlayer');
    const inner = document.getElementById('miniPlayerInner');
    if (inner) inner.innerHTML = '';
    if (mp) mp.style.display = 'none';
    window.miniCsPlayer = null;
}

// ══════════════════════════════════════════════
// MAIN FETCH — routes URL vs text search
// ══════════════════════════════════════════════

async function fetchVideo() {
    const raw = document.getElementById('videoUrl')?.value?.trim();
    if (!raw) { showErr('Enter a URL or search term!'); return; }

    hideErr();
    closeMiniPlayer();
    closeQualityPicker();

    // ── TEXT SEARCH ───────────────────────────
    if (!isUrl(raw) && !/^[A-Za-z0-9_-]{11}$/.test(raw)) {
        await runSearch(raw);
        return;
    }

    // ── URL or 11-char YT ID ─────────────────
    setBtnLoading('Fetching…');
    hideAll();
    dlMode = null; activeYtId = null; stvLinks = []; dlmp3Links = [];

    try {
        let url = raw;
        if (/^[A-Za-z0-9_-]{11}$/.test(raw) && !raw.includes('.')) {
            url = `https://www.youtube.com/watch?v=${raw}`;
            document.getElementById('videoUrl').value = url;
        }

        const ytId = getYtId(url);

        if (ytId) {
            // YouTube → engine ①
            setBtnLoading('Loading…');
            try {
                const [vRes, metaRes] = await Promise.allSettled([
                    dlmp3_videos(ytId),
                    stv_fetch(url, () => {}),
                ]);
                const vLinks = vRes.status === 'fulfilled' ? vRes.value : [];
                if (!vLinks.length) throw new Error('No links from DL-MP3');
                dlmp3Links = vLinks;
                const meta = metaRes.status === 'fulfilled' ? metaRes.value : {};
                showYtResult(ytId, meta.title || `YouTube — ${ytId}`, meta.thumbnail || '', meta.uploader || '', meta.duration || '', url);
            } catch (e) {
                console.warn('[DL-MP3]', e.message, '→ STV');
                try {
                    const data = await stv_fetch(url, msg => setBtnLoading(msg));
                    showStvResult(data, url);
                } catch (e2) {
                    await ytdlpMeta(url);
                }
            }

        } else {
            // Non-YouTube URL → engine ② (STV handles Dailymotion, FB, TikTok, Vimeo, adult sites via our server fallback)
            setBtnLoading('Analyzing…');
            try {
                const data = await stv_fetch(url, msg => setBtnLoading(msg));
                showStvResult(data, url);
            } catch (e) {
                console.warn('[STV]', e.message, '→ yt-dlp');
                try {
                    await ytdlpMeta(url);
                } catch (e2) {
                    stvBrowserFallback(url);
                }
            }
        }

    } catch (e) {
        showErr(e.message || 'Something went wrong.');
    }

    setBtnReady();
}

// ══════════════════════════════════════════════
// DOWNLOAD — download card
// ══════════════════════════════════════════════

async function triggerDownload() {
    const sel    = document.getElementById('formatSelect');
    const format = sel?.value || '0';
    hideErr();

    // Engine ①
    if (dlMode === 'dlmp3' && activeYtId) {
        setDlBtn('⏳ Getting link…', true);
        try {
            if (format === 'dlmp3_audio') {
                const mp3 = await dlmp3_audio(activeYtId);
                dl(mp3.url, `${stvTitle || 'OmniFetch'}.mp3`);
                setDlBtn(`✅ MP3 — ${mp3.bitrate}kbps${mp3.size ? ' · ' + mp3.size : ''}`);
            } else if (format.startsWith('dlmp3_video_')) {
                const i    = parseInt(format.replace('dlmp3_video_', ''), 10);
                const link = dlmp3Links[i] || dlmp3Links[0];
                if (!link) throw new Error('Quality unavailable');
                dl(link.url, `${stvTitle || 'OmniFetch'}_${link.quality}p.${link.ftype}`);
                setDlBtn(`✅ ${link.quality}p${link.size ? ' · ' + link.size : ''} — Downloading!`);
            } else throw new Error('Unknown format');
        } catch (e) {
            console.warn('[DL-MP3 dl]', e.message, '→ yt-dlp');
            ytdlpDownload(window.currentDownloadUrl, format === 'dlmp3_audio' ? 'mp3' : '480');
        }
        setTimeout(() => setDlBtn('⬇ Download Now'), 6000);
        return;
    }

    // Engine ②
    if (dlMode === 'stv' && stvLinks.length) {
        if (format === 'ytdlp_mp3') { ytdlpDownload(window.currentDownloadUrl, 'mp3'); return; }
        let link;
        if (format.startsWith('stv_video_')) {
            link = stvLinks.filter(l => l.type !== 'mp3' && l.type !== 'audio')[parseInt(format.replace('stv_video_',''), 10)];
        } else if (format.startsWith('stv_audio_')) {
            link = stvLinks.filter(l => l.type === 'mp3' || l.type === 'audio')[parseInt(format.replace('stv_audio_',''), 10)];
        }
        if (!link?.url) return showErr('Link unavailable — try a different quality.');
        dl(link.url, `${stvTitle || 'OmniFetch'}.${(link.type || 'mp4').toLowerCase()}`);
        setDlBtn(`✅ ${link.quality || 'Downloading'}…`);
        setTimeout(() => setDlBtn('⬇ Download Now'), 6000);
        return;
    }

    // Engine ③
    const isAudio = format === 'ytdlp_mp3' || format === 'mp3';
    ytdlpDownload(window.currentDownloadUrl, isAudio ? 'mp3' : format);
}

function dl(url, filename) {
    const a = document.createElement('a');
    a.href = url; a.download = filename || ''; a.target = '_blank';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function ytdlpDownload(url, format) {
    if (!url) return showErr('No media loaded!');
    setDlBtn('🚀 Preparing via server…', true);
    dl(`${BACKEND_URL}/download?url=${encodeURIComponent(url)}&format=${encodeURIComponent(format)}&socketId=${encodeURIComponent(socketId)}`, '');
    setTimeout(() => setDlBtn('⬇ Download Now'), 6000);
}

// ══════════════════════════════════════════════
// ENGINE ③  yt-dlp metadata fallback
// ══════════════════════════════════════════════

async function ytdlpMeta(input) {
    dlMode = 'ytdlp'; stvLinks = []; activeYtId = null; dlmp3Links = [];
    for (let attempt = 0; attempt <= 1; attempt++) {
        try {
            if (attempt > 0) setBtnLoading('Retrying…');
            const res  = await fetch(`${BACKEND_URL}/api/info?url=${encodeURIComponent(input)}`, { headers: { Accept: 'application/json' } });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Server error');
            window.currentDownloadUrl = data.url || input;

            // Upgrade to engine ① if YouTube
            const ytId = getYtId(data.url || input);
            if (ytId) {
                try {
                    const vLinks = await dlmp3_videos(ytId);
                    if (vLinks.length) {
                        dlmp3Links = vLinks; activeYtId = ytId;
                        showYtResult(ytId, data.title || 'Unknown', data.thumbnail || '', data.uploader || '', data.duration || '', data.url || input);
                        return;
                    }
                } catch (_) {}
            }

            setDlTitle(data.title);
            setDlMeta([data.uploader, data.source, data.duration].filter(Boolean));
            setChip(data.source || platformOf(data.url || input));

            if (data.videoId && typeof csPlayer !== 'undefined') {
                setPreview(''); window.myPlayer = new csPlayer('#videoPreview', { id: data.videoId, theme: 'default', autoplay: false });
            } else if (data.thumbnail) {
                setPreview(`<img src="${data.thumbnail}" alt="" onerror="this.style.display='none'">`);
            }

            const sel = document.getElementById('formatSelect');
            if (sel) sel.innerHTML = `
                <option value="1080">📼 MP4 — Full HD 1080p</option>
                <option value="720">📼 MP4 — HD 720p</option>
                <option value="480" selected>📼 MP4 — SD 480p</option>
                <option value="360">📼 MP4 — SD 360p</option>
                <option value="ytdlp_mp3">🎵 MP3 Audio</option>`;

            setDlBtn('⬇ Download Now');
            showDownloadCard();
            addHistory(data.title || 'Unknown', data.thumbnail || '', window.currentDownloadUrl, 'ytdlp');
            return;
        } catch (e) {
            if (attempt >= 1) throw e;
            await wait(2000);
        }
    }
}

// ══════════════════════════════════════════════
// HISTORY
// ══════════════════════════════════════════════

function addHistory(title, thumbnail, url, src) {
    let h = JSON.parse(localStorage.getItem('omni_history') || '[]');
    h = h.filter(i => i.url !== url);
    h.unshift({ title, thumbnail, url, src });
    localStorage.setItem('omni_history', JSON.stringify(h.slice(0, 8)));
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
        <div class="hist-item" data-i="${i}">
            ${item.thumbnail
                ? `<img class="hist-thumb" src="${item.thumbnail}" onerror="this.style.display='none'" loading="lazy">`
                : `<div class="hist-no-thumb">🎬</div>`}
            <span class="hist-label">${item.title}</span>
            <span class="refetch-badge">RE-FETCH</span>
        </div>`).join('');

    list.querySelectorAll('.hist-item').forEach(el => {
        const item = history[parseInt(el.dataset.i, 10)];
        el.addEventListener('click', () => {
            const inp = document.getElementById('videoUrl');
            if (inp) { inp.value = item.url; fetchVideo(); }
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    });
}

// ══════════════════════════════════════════════
// CLEAR INPUT
// ══════════════════════════════════════════════

function clearInput() {
    const inp = document.getElementById('videoUrl');
    const btn = document.getElementById('clearBtn');
    if (inp) { inp.value = ''; inp.focus(); }
    if (btn) btn.style.display = 'none';
    hideErr();
    hideAll();
    closeMiniPlayer();
    closeQualityPicker();
}

// ══════════════════════════════════════════════
// SHARE
// ══════════════════════════════════════════════

function shareSite() {
    const p = { title: 'OmniFetch', text: 'Download any video or music instantly', url: window.location.href };
    if (navigator.share) { navigator.share(p).catch(() => {}); return; }
    navigator.clipboard.writeText(window.location.href)
        .then(() => {
            const b = document.querySelector('.share-btn');
            if (b) { const o = b.textContent; b.textContent = '✅ Copied!'; setTimeout(() => b.textContent = o, 2500); }
        })
        .catch(() => prompt('Copy this link:', window.location.href));
}

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    renderHistory();

    document.getElementById('videoUrl')?.addEventListener('keypress', e => {
        if (e.key === 'Enter') fetchVideo();
    });

    // Show/hide the ✕ clear button as user types
    document.getElementById('videoUrl')?.addEventListener('input', e => {
        const btn = document.getElementById('clearBtn');
        if (btn) btn.style.display = e.target.value.length ? 'block' : 'none';
    });

    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
        const saved = localStorage.getItem('omni_theme') || 'light';
        document.documentElement.setAttribute('data-theme', saved);
        themeBtn.textContent = saved === 'light' ? '🌙 Mode' : '☀️ Mode';
        themeBtn.addEventListener('click', () => {
            const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', next);
            themeBtn.textContent = next === 'light' ? '🌙 Mode' : '☀️ Mode';
            localStorage.setItem('omni_theme', next);
        });
    }
});