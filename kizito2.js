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
    if (socket.connected) {
        statusDot.style.backgroundColor = "#2ecc71"; // Green
        statusDot.title = "OmniFetch Online";
    } else {
        statusDot.style.backgroundColor = "#e74c3c"; // Red
        statusDot.title = "OmniFetch Offline";
    }
}, 5000);

socket.on('connect', () => {
    userSocketId = socket.id;
    console.log("OmniFetch Connected. ID:", userSocketId);
});

// Listener for download progress
socket.on('progress', (data) => {
    const bar = document.getElementById('progressBar');
    const text = document.getElementById('progressText');
    const wrapper = document.getElementById('progressWrapper');

    if (data.percent !== undefined && bar && text && wrapper) {
        wrapper.style.display = "block";
        text.style.display = "block";
        
        const p = Math.round(data.percent);
        bar.style.width = p + "%";
        
        if (p < 100) {
            text.innerText = `Fetching: ${p}%`;
        } else {
            text.innerText = "✅ Download Finished!";
            showToast("🚀 Your file is ready! Check your downloads.");
            
            if (navigator.vibrate) navigator.vibrate(200);

            setTimeout(() => { 
                wrapper.style.display = "none"; 
                text.style.display = "none";
                bar.style.width = "0%"; 
            }, 4000);
        }
    }
});

// ==========================================
// 2. HELPER FUNCTIONS
// ==========================================

function formatInput(input) {
    const trimmed = input.trim();
    if (trimmed.length === 11 && !trimmed.includes('.') && !trimmed.includes('/')) {
        return `https://www.youtube.com/watch?v=${trimmed}`;
    }
    return trimmed; 
}

function showError(message) {
    const errorBox = document.getElementById('errorBox');
    if (!errorBox) return alert(message);
    errorBox.innerText = message;
    errorBox.style.display = "block";
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return console.log(message); 
    
    toast.innerText = message;
    toast.style.display = "block";
    toast.style.opacity = "1";

    setTimeout(() => {
        toast.style.transition = "opacity 0.5s ease";
        toast.style.opacity = "0";
        setTimeout(() => { toast.style.display = "none"; }, 500);
    }, 4000);
}

const delay = ms => new Promise(res => setTimeout(res, ms));

// ==========================================
// 3. ACTION FUNCTIONS
// ==========================================

async function fetchVideo() {
    const rawInput = document.getElementById('videoUrl').value;
    const finalInput = formatInput(rawInput); 
    const startBtn = document.getElementById('startBtn');
    const btnText = document.getElementById('btnText');
    const spinner = document.getElementById('spinner');
    
    if (!rawInput) {
        showError("Please enter a link or a name!");
        return;
    }

    const errorBox = document.getElementById('errorBox');
    if (errorBox) errorBox.style.display = "none";
    
    startBtn.disabled = true;
    if(spinner) spinner.style.display = "inline-block";

    let attempts = 0;
    const maxRetries = 1; 

    while (attempts <= maxRetries) {
        try {
            if(btnText) btnText.innerText = attempts > 0 ? `Retrying...` : "Searching...";
            
            const response = await fetch(`${BACKEND_URL}/api/info?url=${encodeURIComponent(finalInput)}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
            
            const data = await response.json();

            if (response.ok) {
                document.getElementById('title').innerText = data.title;
                
                window.currentDownloadUrl = data.url || finalInput;

                if (window.csPlayer && data.videoId) {
                    if (!window.myPlayer) {
                        window.myPlayer = new csPlayer("#videoPreview", {
                            id: data.videoId,
                            theme: "default",
                            autoplay: false
                        });
                    } else {
                        window.myPlayer.load(data.videoId);
                    }
                }

                document.getElementById('result').style.display = "block";
                addToHistory(data.title, data.thumbnail, window.currentDownloadUrl);

                if(btnText) btnText.innerText = "Fetch";
                if(spinner) spinner.style.display = "none";
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
    if(btnText) btnText.innerText = "Fetch";
    if(spinner) spinner.style.display = "none";
    startBtn.disabled = false;
}

function triggerDownload() {
    const dlBtn = document.getElementById('downloadBtn');
    const url = window.currentDownloadUrl;

    if (!url) {
        return showError("No media loaded! Please fetch a video first.");
    }

    dlBtn.innerText = "🚀 Locating High-Speed Link...";
    dlBtn.disabled = true;

    const downloadGateway = `https://getvideo.pwn.sh/?url=${encodeURIComponent(url)}`;
    window.open(downloadGateway, '_blank');

    setTimeout(() => {
        dlBtn.innerText = "Download Started";
        dlBtn.disabled = false;
        setTimeout(() => {
            dlBtn.innerText = "Download Now";
        }, 2000);
    }, 3000);
}

// ==========================================
// 4. THEME & HISTORY
// ==========================================
function addToHistory(title, thumbnail, url) {
    let history = JSON.parse(localStorage.getItem('omni_history') || "[]");
    history = history.filter(item => item.url !== url);
    history.unshift({ title, thumbnail, url, date: new Date().toLocaleTimeString() });
    history = history.slice(0, 3); 
    localStorage.setItem('omni_history', JSON.stringify(history));
    renderHistory();
}

function renderHistory() {
    const history = JSON.parse(localStorage.getItem('omni_history') || "[]");
    const section = document.getElementById('historySection');
    const list = document.getElementById('historyList');

    if (!section || !list) return;
    if (history.length === 0) {
        section.style.display = "none";
        return;
    }

    section.style.display = "block";
    list.innerHTML = history.map(item => `
        <div class="history-item" onclick="reFetch('${item.url}')">
            <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;">
                <img src="${item.thumbnail}" style="width: 60px; height: 35px; object-fit: cover; border-radius: 4px;">
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: bold; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                        ${item.title}
                    </div>
                </div>
            </div>
            <div class="copy-badge">RE-FETCH</div>
        </div>
    `).join('');
}

window.reFetch = (query) => {
    const input = document.getElementById('videoUrl');
    if (input) {
        input.value = query;
        fetchVideo(); 
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
};

// ==========================================
// 5. SECURE TRENDING GRID (Using Render Proxy)
// ==========================================
async function loadTrendingMovies() {
    const grid = document.getElementById('trendingGrid');
    if (!grid) return;

    try {
        // We call our OWN backend. The secret TMDB_TOKEN stays hidden on Render.
        const response = await fetch(`${BACKEND_URL}/api/trending`);
        const data = await response.json();
        
        if (!data.results) return;

        grid.innerHTML = data.results.slice(0, 10).map(movie => `
            <div class="movie-card" onclick="reFetch('${movie.title.replace(/'/g, "\\'")}')">
                <img class="movie-poster" 
                     src="https://image.tmdb.org/t/p/w500${movie.poster_path}" 
                     alt="${movie.title}"
                     onerror="this.src='https://via.placeholder.com/500x750?text=No+Poster'">
                <div class="movie-info">${movie.title}</div>
            </div>
        `).join('');

    } catch (err) {
        console.error("Michael, the Trending Grid failed. Check Render Environment Variables:", err);
    }
}

// ==========================================
// 6. INITIALIZATION & THEME
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    renderHistory();
    loadTrendingMovies();

    // Theme Toggle Logic
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', newTheme);
            themeBtn.innerText = newTheme === 'light' ? '🌙 Mode' : '☀️ Mode';
        });
    }
});