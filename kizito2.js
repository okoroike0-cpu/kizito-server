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
    if (!trimmed.startsWith('http')) {
        return `gvsearch1:${trimmed} movie`;
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

const delay = ms => new Promise(res => setTimeout(res, ms));

// ==========================================
// 3. ACTION FUNCTIONS
// ==========================================

async function fetchVideo() {
    const rawInput = document.getElementById('videoUrl').value;
    if (!rawInput) {
        showError("Please enter a link or a name!");
        return;
    }

    const finalInput = formatInput(rawInput); 
    
    const startBtn = document.getElementById('startBtn');
    const btnText = document.getElementById('btnText');
    const spinner = document.getElementById('spinner');
    
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
                showError(`Pathfinder Error: ${error.message}. Try adding 'trailer' to the name.`);
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

    if (!url) return showError("No media loaded!");

    dlBtn.innerText = "🚀 Locating High-Speed Link...";
    dlBtn.disabled = true;

    const downloadGateway = `https://getvideo.pwn.sh/?url=${encodeURIComponent(url)}`;
    window.open(downloadGateway, '_blank');

    setTimeout(() => {
        dlBtn.innerText = "Download Now";
        dlBtn.disabled = false;
    }, 4000);
}

// ==========================================
// 4. THEME & HISTORY
// ==========================================
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
    const list = document.getElementById('historyList');

    if (!section || !list) return;
    if (history.length === 0) return section.style.display = "none";

    section.style.display = "block";
    list.innerHTML = history.map(item => `
        <div class="history-item" onclick="reFetch('${item.url}')">
            <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;">
                <img src="${item.thumbnail}" style="width: 60px; height: 35px; object-fit: cover; border-radius: 4px;">
                <div style="font-weight: bold; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${item.title}
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
// 5. SECURE GRID LOGIC (TRENDING & SEARCH)
// ==========================================

// Michael, this function searches for movies using your new backend proxy
async function searchMovies() {
    const searchInput = document.getElementById('searchInput'); 
    const grid = document.getElementById('trendingGrid');
    const query = searchInput.value.trim();

    if (!query) return loadTrendingMovies(); // Reset to trending if empty

    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center;">Searching for movies...</div>';

    try {
        const response = await fetch(`${BACKEND_URL}/api/search?q=${encodeURIComponent(query)}`);
        const data = await response.json();
        
        if (!data.results || data.results.length === 0) {
            grid.innerHTML = '<p style="grid-column: 1/-1; text-align: center;">No results found.</p>';
            return;
        }
        renderMovieGrid(data.results);
    } catch (err) {
        console.error("Search Error:", err);
        showError("Search failed.");
    }
}

async function loadTrendingMovies() {
    const grid = document.getElementById('trendingGrid');
    if (!grid) return;

    try {
        const response = await fetch(`${BACKEND_URL}/api/trending`);
        const data = await response.json();
        if (data.results) renderMovieGrid(data.results);
    } catch (err) {
        console.error("Trending Error:", err);
    }
}

// Function to actually draw the posters in the grid
function renderMovieGrid(movies) {
    const grid = document.getElementById('trendingGrid');
    grid.innerHTML = movies.slice(0, 10).map(movie => {
        const safeTitle = movie.title.replace(/'/g, "\\'");
        return `
            <div class="movie-card" onclick="reFetch('${safeTitle}')">
                <img class="movie-poster" 
                     src="https://image.tmdb.org/t/p/w500${movie.poster_path}" 
                     onerror="this.src='https://via.placeholder.com/500x750?text=No+Poster'">
                <div class="movie-info">${movie.title}</div>
            </div>
        `;
    }).join('');
}

// ==========================================
// 6. INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    renderHistory();
    loadTrendingMovies();

    // Michael, this links the Search Overlay button and the Enter key to the search function
    const searchBtn = document.getElementById('searchBtn');
    const searchInput = document.getElementById('searchInput');

    if (searchBtn) searchBtn.addEventListener('click', searchMovies);
    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') searchMovies();
        });
    }

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