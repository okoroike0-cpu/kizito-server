// ==========================================
// 1. DYNAMIC SERVER CONFIGURATION
// ==========================================
const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3000' 
    : 'https://kizito-server.onrender.com'; 

const socket = io(BACKEND_URL);
let userSocketId = "";

// Monitor server health every 5 seconds
setInterval(() => {
    const statusDot = document.getElementById('statusDot');
    if (!statusDot) return;
    if (socket.connected) {
        statusDot.style.backgroundColor = "#2ecc71"; // Green
        statusDot.title = "Server Online";
    } else {
        statusDot.style.backgroundColor = "#e74c3c"; // Red
        statusDot.title = "Server Offline";
    }
}, 5000);

socket.on('connect', () => {
    userSocketId = socket.id;
    console.log("Connected to server. ID:", userSocketId);
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
        text.innerText = p < 100 ? `Processing: ${p}%` : "✅ Ready!";

        if (p >= 100) {
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

function formatYoutubeUrl(input) {
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
    }, 3000);
}

const delay = ms => new Promise(res => setTimeout(res, ms));

// ==========================================
// 3. ACTION FUNCTIONS
// ==========================================

async function fetchVideo() {
    const rawInput = document.getElementById('videoUrl').value;
    const videoUrl = formatYoutubeUrl(rawInput);
    const startBtn = document.getElementById('startBtn');
    const btnText = document.getElementById('btnText');
    const spinner = document.getElementById('spinner');
    
    if (!rawInput) {
        showError("Please enter a YouTube ID or link!");
        return;
    }

    const errorBox = document.getElementById('errorBox');
    if (errorBox) errorBox.style.display = "none";
    
    startBtn.disabled = true;
    spinner.style.display = "inline-block";

    let attempts = 0;
    const maxRetries = 2; // Reduced retries for faster user feedback

    while (attempts <= maxRetries) {
        try {
            btnText.innerText = attempts > 0 ? `Retrying (${attempts})...` : "Loading...";
            
            // ✅ CORRECTION: Added headers to mimic a browser request more closely
            const response = await fetch(`${BACKEND_URL}/info?url=${encodeURIComponent(videoUrl)}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
            
            const data = await response.json();

            if (response.ok) {
                document.getElementById('title').innerText = data.title;
                document.getElementById('thumbImg').src = data.thumbnail;
                
                const sizeDisplay = document.getElementById('sizeInfo');
                const fileSizeText = document.getElementById('fileSize');
                if (data.size && sizeDisplay && fileSizeText) {
                    sizeDisplay.style.display = "block";
                    fileSizeText.innerText = data.size;
                }

                document.getElementById('result').style.display = "block";
                addToHistory(data.title, data.thumbnail, videoUrl);

                btnText.innerText = "Fetch";
                spinner.style.display = "none";
                startBtn.disabled = false;
                return; 
            } else {
                throw new Error(data.error || "YouTube Blocked");
            }
        } catch (error) {
            attempts++;
            if (attempts > maxRetries) {
                showError("YouTube is blocking requests. Please update your cookies.json in the backend and redeploy.");
            } else {
                await delay(2000);
            }
        }
    }
    btnText.innerText = "Fetch";
    spinner.style.display = "none";
    startBtn.disabled = false;
}

function triggerDownload() {
    const videoUrl = formatYoutubeUrl(document.getElementById('videoUrl').value);
    const selection = document.getElementById('formatSelect').value;
    const format = (selection === 'mp3') ? 'mp3' : 'mp4';
    // ✅ ADDED: Validation before redirect
    if(!videoUrl) return showError("No video loaded!");
    
    const dlUrl = `${BACKEND_URL}/download?url=${encodeURIComponent(videoUrl)}&quality=${selection}&format=${format}&socketId=${userSocketId}`;
    window.location.href = dlUrl; // Changed from window.open to location.href for better mobile support
}

function copyDownloadLink() {
    const videoUrl = formatYoutubeUrl(document.getElementById('videoUrl').value);
    const selection = document.getElementById('formatSelect').value;
    const format = (selection === 'mp3') ? 'mp3' : 'mp4';
    const dlUrl = `${BACKEND_URL}/download?url=${encodeURIComponent(videoUrl)}&quality=${selection}&format=${format}&socketId=${userSocketId}`;

    navigator.clipboard.writeText(dlUrl).then(() => {
        showToast("Link copied! 📋");
    }).catch(err => {
        showError("Could not copy link.");
    });
}

// ==========================================
// 4. PERSISTENT DARK MODE LOGIC
// ==========================================
const themeToggle = document.getElementById('themeToggle');
const htmlRoot = document.documentElement;

// Correctly load and apply the theme on start
const savedTheme = localStorage.getItem('theme') || 'light';
applyTheme(savedTheme);

if (themeToggle) {
    themeToggle.addEventListener('click', () => {
        const currentTheme = htmlRoot.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        applyTheme(newTheme);
    });
}

function applyTheme(theme) {
    htmlRoot.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    // ✅ Ensure text changes correctly
    if(themeToggle) {
        themeToggle.innerHTML = theme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
    }
    console.log("Theme applied:", theme);
}

// ==========================================
// 5. HISTORY LOGIC
// ==========================================

function addToHistory(title, thumbnail, url) {
    let history = JSON.parse(localStorage.getItem('conv_history') || "[]");
    history = history.filter(item => item.url !== url);
    history.unshift({ title, thumbnail, url, date: new Date().toLocaleTimeString() });
    history = history.slice(0, 3); 
    localStorage.setItem('conv_history', JSON.stringify(history));
    renderHistory();
}

function renderHistory() {
    const history = JSON.parse(localStorage.getItem('conv_history') || "[]");
    const section = document.getElementById('historySection');
    const list = document.getElementById('historyList');
    const zipBtn = document.getElementById('zipBtn');

    if (!section || !list) return;
    if (history.length === 0) {
        section.style.display = "none";
        return;
    }

    section.style.display = "block";
    if (zipBtn) zipBtn.innerText = `📦 Zip All (${history.length})`;

    list.innerHTML = history.map(item => `
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border-color); overflow: hidden;">
            <img src="${item.thumbnail}" style="width: 60px; height: 35px; object-fit: cover; border-radius: 4px;">
            <div style="flex: 1; min-width: 0;">
                <div style="font-weight: bold; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-color);">
                    ${item.title}
                </div>
                <small style="opacity: 0.6; font-size: 11px; color: var(--text-color);">${item.date}</small>
            </div>
            <button onclick="reFetch('${item.url}')" style="padding: 4px 8px; font-size: 11px; background: #007bff; color: white; border-radius: 4px; border: none; cursor: pointer;">
                Get
            </button>
        </div>
    `).join('');
}

window.reFetch = (url) => {
    document.getElementById('videoUrl').value = url;
    fetchVideo();
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// ==========================================
// 6. ZIP ALL DOWNLOAD
// ==========================================
async function downloadAllAsZip() {
    const history = JSON.parse(localStorage.getItem('conv_history') || "[]");
    if (history.length === 0) return;

    const zipBtn = document.getElementById('zipBtn');
    const originalText = zipBtn.innerText;
    
    zipBtn.innerText = "⚡ Zipping...";
    zipBtn.disabled = true;

    const zip = new JSZip();
    const selection = document.getElementById('formatSelect').value;
    const format = (selection === 'mp3') ? 'mp3' : 'mp4';

    const progressWrapper = document.getElementById('progressWrapper');
    const progressText = document.getElementById('progressText');
    const progressBar = document.getElementById('progressBar');

    try {
        let count = 0;
        for (let item of history) {
            count++;
            
            if (progressWrapper && progressText && progressBar) {
                progressWrapper.style.display = "block";
                progressText.style.display = "block";
                progressText.innerText = `Downloading ${count}/${history.length}...`;
                progressBar.style.width = `${(count / history.length) * 100}%`;
            }

            const dlUrl = `${BACKEND_URL}/download?url=${encodeURIComponent(item.url)}&quality=${selection}&format=${format}`;
            
            const response = await fetch(dlUrl);
            if (!response.ok) throw new Error(`Failed to fetch ${item.title}`);
            
            const blob = await response.blob();
            const safeName = item.title.replace(/[^\w\s]/gi, '') || 'video';
            zip.file(`${safeName}.${format}`, blob);
        }

        if (progressText) progressText.innerText = "📦 Saving Zip...";
        const content = await zip.generateAsync({ type: "blob" });
        
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = `YouTube_Pack_${Date.now()}.zip`;
        link.click();
        
        showToast("Success! 📦");
    } catch (err) {
        showError("Batch Zip failed.");
    } finally {
        zipBtn.innerText = originalText;
        zipBtn.disabled = false;
        setTimeout(() => {
            if (progressWrapper) progressWrapper.style.display = "none";
        }, 2000);
    }
}

document.addEventListener('DOMContentLoaded', renderHistory);