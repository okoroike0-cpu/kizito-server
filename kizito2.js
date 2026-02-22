// ==========================================
// 1. DYNAMIC SERVER CONFIGURATION
// ==========================================
const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000'
    : 'https://kizito-server.onrender.com';

const socket = io(BACKEND_URL);
let userSocketId = "";

// Monitor server health
setInterval(() => {
    const statusDot = document.getElementById('statusDot');
    if (!statusDot) return;
    statusDot.style.backgroundColor = socket.connected ? "#2ecc71" : "#e74c3c";
    statusDot.title = socket.connected ? "OmniFetch Online" : "OmniFetch Offline";
}, 5000);

socket.on('connect', () => {
    userSocketId = socket.id;
    console.log("OmniFetch Connected. ID:", userSocketId);
    const statusDot = document.getElementById('statusDot');
    if (statusDot) statusDot.style.backgroundColor = "#2ecc71";
});

socket.on('disconnect', () => {
    const statusDot = document.getElementById('statusDot');
    if (statusDot) statusDot.style.backgroundColor = "#e74c3c";
});

// Listener for download progress
socket.on('progress', (data) => {
    const bar     = document.getElementById('progressBar');
    const text    = document.getElementById('progressText');
    const wrapper = document.getElementById('progressWrapper');

    if (data.percent !== undefined && bar && text && wrapper) {
        wrapper.style.display = "block";
        text.style.display    = "block";

        const p = Math.round(data.percent);
        bar.style.width = p + "%";

        if (p < 100) {
            text.innerText = `Downloading: ${p}%`;
        } else {
            text.innerText = "✅ Download Complete!";
            if (navigator.vibrate) navigator.vibrate(200);
            setTimeout(() => {
                wrapper.style.display = "none";
                text.style.display    = "none";
                bar.style.width       = "0%";
            }, 4000);
        }
    }
});

// ==========================================
// 2. HELPER FUNCTIONS
// ==========================================

function formatInput(input) {
    const trimmed = input.trim();

    // Plain 11-char YouTube video ID (no dots or slashes)
    if (trimmed.length === 11 && !trimmed.includes('.') && !trimmed.includes('/')) {
        return `https://www.youtube.com/watch?v=${trimmed}`;
    }

    // Already a full URL — pass through unchanged
    if (trimmed.startsWith('http')) {
        return trimmed;
    }

    // FIX 2: Do NOT append 'movie' — let the user's own words be the query.
    // Previously: `gvsearch1:${trimmed} movie` caused searches like "Breaking Bad movie"
    return `gvsearch1:${trimmed}`;
}

function showError(message) {
    const errorBox = document.getElementById('errorBox');
    if (!errorBox) return alert(message);
    errorBox.innerText = message;
    errorBox.style.display = "block";
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function hideError() {
    const errorBox = document.getElementById('errorBox');
    if (errorBox) errorBox.style.display = "none";
}

const delay = ms => new Promise(res => setTimeout(res, ms));

// ==========================================
// 3. ACTION FUNCTIONS
// ==========================================

async function fetchVideo() {
    const rawInput = document.getElementById('videoUrl').value;
    if (!rawInput.trim()) {
        showError("Please enter a link or a name!");
        return;
    }

    const finalInput = formatInput(rawInput);

    const startBtn = document.getElementById('startBtn');
    const btnText  = document.getElementById('btnText');
    const spinner  = document.getElementById('spinner');

    hideError();
    startBtn.disabled = true;
    if (spinner) spinner.style.display = "inline-block";
    if (btnText) btnText.innerText = "Searching...";

    // Hide previous result while searching
    document.getElementById('result').style.display = "none";

    let attempts = 0;
    const maxRetries = 1;

    while (attempts <= maxRetries) {
        try {
            if (attempts > 0 && btnText) btnText.innerText = "Retrying...";

            const response = await fetch(
                `${BACKEND_URL}/api/info?url=${encodeURIComponent(finalInput)}`,
                { method: 'GET', headers: { 'Accept': 'application/json' } }
            );

            const data = await response.json();

            if (response.ok) {
                document.getElementById('title').innerText = data.title || "Unknown Title";
                window.currentDownloadUrl = data.url || finalInput;

                // FIX 3: Reset window.myPlayer to null before clearing the preview container.
                // Previously: innerHTML = '' destroyed the DOM node csPlayer was bound to,
                // but myPlayer still pointed at it — next .load() call hit a dead element.
                const previewEl = document.getElementById('videoPreview');
                if (previewEl) {
                    previewEl.innerHTML  = '';
                    window.myPlayer      = null;   // ← FIX 3
                }

                if (typeof csPlayer !== 'undefined' && data.videoId && previewEl) {
                    window.myPlayer = new csPlayer("#videoPreview", {
                        id:       data.videoId,
                        theme:    "default",
                        autoplay: false
                    });
                } else if (previewEl && data.thumbnail) {
                    previewEl.innerHTML = `<img src="${data.thumbnail}"
                        style="width:100%;height:100%;object-fit:cover;border-radius:8px;"
                        onerror="this.style.display='none'">`;
                }

                // Show source platform badge
                const sourceEl = document.getElementById('sourceIndicator');
                if (sourceEl) {
                    sourceEl.innerText     = data.source || '';
                    sourceEl.style.display = data.source ? "inline-block" : "none";
                }

                document.getElementById('result').style.display = "block";

                addToHistory(
                    data.title     || "Unknown",
                    data.thumbnail || '',
                    window.currentDownloadUrl
                );

                if (btnText) btnText.innerText = "Fetch";
                if (spinner) spinner.style.display = "none";
                startBtn.disabled = false;
                return;
            } else {
                throw new Error(data.error || "Server Error");
            }
        } catch (error) {
            attempts++;
            if (attempts > maxRetries) {
                showError(`Pathfinder Error: ${error.message}`);
            } else {
                await delay(2000);
            }
        }
    }

    if (btnText) btnText.innerText = "Fetch";
    if (spinner) spinner.style.display = "none";
    startBtn.disabled = false;
}

function triggerDownload() {
    const dlBtn = document.getElementById('downloadBtn');
    const url   = window.currentDownloadUrl;

    if (!url) return showError("No media loaded!");

    const formatSelect = document.getElementById('formatSelect');
    const format       = formatSelect ? formatSelect.value : '480';

    // FIX 4: Warn if socket hasn't connected yet — progress bar won't work without a socketId.
    // Previously: userSocketId was "" and server called io.to("").emit() → nobody received it.
    if (!userSocketId) {
        console.warn("Socket not connected yet — progress bar will not update for this download.");
    }

    dlBtn.innerText  = "🚀 Preparing Download...";
    dlBtn.disabled   = true;

    const downloadUrl = `${BACKEND_URL}/download`
        + `?url=${encodeURIComponent(url)}`
        + `&format=${encodeURIComponent(format)}`
        + `&socketId=${encodeURIComponent(userSocketId)}`;

    // Hidden anchor download — preserves Content-Disposition filename from server
    const anchor = document.createElement('a');
    anchor.href  = downloadUrl;
    anchor.download = '';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    setTimeout(() => {
        dlBtn.innerText = "⬇ Download Now";
        dlBtn.disabled  = false;
    }, 5000);
}

// ==========================================
// 4. THEME, HISTORY & UTILITY FUNCTIONS
// ==========================================

function shareSite() {
    const shareData = {
        title: 'OmniFetch',
        text:  'Download any video or audio instantly — Universal Media Pathfinder',
        url:   window.location.href
    };
    if (navigator.share) {
        navigator.share(shareData).catch(() => {});
    } else {
        navigator.clipboard.writeText(window.location.href).then(() => {
            const btn = document.querySelector('.share-btn');
            if (btn) {
                const orig = btn.innerText;
                btn.innerText = '✅ Link Copied!';
                setTimeout(() => btn.innerText = orig, 2500);
            }
        }).catch(() => {
            prompt('Copy this link:', window.location.href);
        });
    }
}

function clearHistory() {
    localStorage.removeItem('omni_history');
    renderHistory();
}

function addToHistory(title, thumbnail, url) {
    let history = JSON.parse(localStorage.getItem('omni_history') || "[]");
    history = history.filter(item => item.url !== url);
    history.unshift({ title, thumbnail, url });
    history = history.slice(0, 3);
    localStorage.setItem('omni_history', JSON.stringify(history));
    renderHistory();
}

function renderHistory() {
    const history = JSON.parse(localStorage.getItem('omni_history') || "[]");
    const section = document.getElementById('historySection');
    const list    = document.getElementById('historyList');

    if (!section || !list) return;
    if (history.length === 0) {
        section.style.display = "none";
        return;
    }

    section.style.display = "block";

    // FIX 1 (partial): store url in a data attribute to avoid apostrophe-in-onclick breakage.
    // Instead of onclick="reFetch('${url}')" which breaks on titles/URLs with apostrophes,
    // we use data-url and attach the listener in renderHistory itself.
    list.innerHTML = history.map((item, i) => `
        <div class="history-item" data-index="${i}">
            <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">
                ${item.thumbnail
                    ? `<img src="${item.thumbnail}"
                            style="width:60px;height:35px;object-fit:cover;border-radius:4px;"
                            onerror="this.style.display='none'">`
                    : `<div style="width:60px;height:35px;background:var(--step-bg);border-radius:4px;
                                   display:flex;align-items:center;justify-content:center;font-size:18px;">🎬</div>`
                }
                <div style="font-weight:bold;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                    ${item.title}
                </div>
            </div>
            <div class="copy-badge">RE-FETCH</div>
        </div>
    `).join('');

    // Attach click handlers via JS — safe no matter what characters are in the URL or title
    list.querySelectorAll('.history-item').forEach(el => {
        const i = parseInt(el.dataset.index, 10);
        el.addEventListener('click', () => reFetch(history[i].url));
    });
}

// reFetch: put the URL back in the input and search again
window.reFetch = (url) => {
    const input = document.getElementById('videoUrl');
    if (input) {
        input.value = url;
        fetchVideo();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
};

// ==========================================
// 5. TRENDING GRID & SEARCH
// ==========================================

async function searchMovies() {
    const searchInput = document.getElementById('searchInput');
    const grid        = document.getElementById('trendingGrid');
    const query       = searchInput ? searchInput.value.trim() : '';

    if (!query) return loadTrendingMovies();

    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;opacity:0.6;">Searching...</div>';

    try {
        const response = await fetch(`${BACKEND_URL}/api/search?q=${encodeURIComponent(query)}`);
        if (!response.ok) throw new Error('Search request failed');
        const data = await response.json();

        if (!data.results || data.results.length === 0) {
            grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;opacity:0.6;">No results found.</p>';
            return;
        }
        renderMovieGrid(data.results);
    } catch (err) {
        console.error("Search Error:", err);
        grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:#e74c3c;">Search failed. Check your connection.</p>';
    }
}

async function loadTrendingMovies() {
    const grid = document.getElementById('trendingGrid');
    if (!grid) return;

    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:20px;opacity:0.6;">Loading trending...</div>';

    try {
        const response = await fetch(`${BACKEND_URL}/api/trending`);
        if (!response.ok) throw new Error('Failed to load trending');
        const data = await response.json();
        if (data.results) renderMovieGrid(data.results);
    } catch (err) {
        console.error("Trending Error:", err);
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;opacity:0.5;padding:20px;">Could not load trending titles.</div>';
    }
}

function renderMovieGrid(movies) {
    const grid = document.getElementById('trendingGrid');
    if (!grid) return;

    // FIX 1 (main): use data-title attribute instead of inline onclick string.
    // Previously: onclick="reFetch('${safeTitle}')" broke on titles with apostrophes
    // e.g. "Don't Look Up" → onclick="reFetch('Don\'t Look Up')" → JS syntax error → silent fail.
    grid.innerHTML = movies.slice(0, 10).map((movie, i) => {
        const posterSrc = movie.poster_path
            ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
            : `https://placehold.co/500x750/1e1e1e/888?text=No+Poster`;
        return `
            <div class="movie-card" data-index="${i}">
                <img class="movie-poster"
                     src="${posterSrc}"
                     onerror="this.src='https://placehold.co/500x750/1e1e1e/888?text=No+Poster'"
                     loading="lazy">
                <div class="movie-info">${movie.title || 'Unknown'}</div>
            </div>
        `;
    }).join('');

    // Attach click handlers via JS — no string escaping needed, no apostrophe breakage
    const cards = grid.querySelectorAll('.movie-card');
    cards.forEach((card, i) => {
        card.addEventListener('click', () => {
            const title = movies[i].title || '';
            reFetch(title);   // reFetch → fetchVideo → formatInput → gvsearch1:TITLE
        });
    });
}

// ==========================================
// 6. INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    renderHistory();
    loadTrendingMovies();

    const searchBtn   = document.getElementById('searchBtn');
    const searchInput = document.getElementById('searchInput');

    if (searchBtn)   searchBtn.addEventListener('click', searchMovies);
    if (searchInput) searchInput.addEventListener('keypress', e => { if (e.key === 'Enter') searchMovies(); });

    // Enter key on main input triggers fetch
    const videoUrl = document.getElementById('videoUrl');
    if (videoUrl) videoUrl.addEventListener('keypress', e => { if (e.key === 'Enter') fetchVideo(); });

    // Theme toggle with persistence
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
        const saved = localStorage.getItem('omni_theme') || 'light';
        document.documentElement.setAttribute('data-theme', saved);
        themeBtn.innerText = saved === 'light' ? '🌙 Mode' : '☀️ Mode';

        themeBtn.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme');
            const next    = current === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', next);
            themeBtn.innerText = next === 'light' ? '🌙 Mode' : '☀️ Mode';
            localStorage.setItem('omni_theme', next);
        });
    }
});