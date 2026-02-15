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
        text.innerText = p < 100 ? `Fetching: ${p}%` : "✅ Ready!";

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
    }, 3000);
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
            
            const response = await fetch(`${BACKEND_URL}/info?url=${encodeURIComponent(finalInput)}`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
            
            const data = await response.json();

            if (response.ok) {
                // UI Update: Main Title
                document.getElementById('title').innerText = data.title;
                
                // UI Update: Source Badge (The new addition!)
                const sourceBadge = document.getElementById('sourceIndicator');
                if (sourceBadge && data.source) {
                    sourceBadge.innerText = data.source.toUpperCase();
                    sourceBadge.style.display = "inline-block";
                }

                // ✅ CSPLAYER INTEGRATION
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
                
                addToHistory(data.title, data.thumbnail, data.url || finalInput);

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
                showError(`Pathfinder Error: ${error.message}. Please check Render build permissions.`);
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
    const rawInput = document.getElementById('videoUrl').value;
    const selection = document.getElementById('formatSelect').value;
    const format = (selection === 'mp3') ? 'mp3' : 'mp4';
    
    if(!rawInput) return showError("No media loaded!");
    
    const dlUrl = `${BACKEND_URL}/download?url=${encodeURIComponent(rawInput)}&quality=${selection}&format=${format}&socketId=${userSocketId}`;
    window.location.href = dlUrl; 
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
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border-color);">
            <img src="${item.thumbnail}" style="width: 60px; height: 35px; object-fit: cover; border-radius: 4px;">
            <div style="flex: 1; min-width: 0;">
                <div style="font-weight: bold; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    ${item.title}
                </div>
            </div>
            <button onclick="reFetch('${item.url}')" style="padding: 4px 8px; font-size: 11px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">
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

document.addEventListener('DOMContentLoaded', renderHistory);