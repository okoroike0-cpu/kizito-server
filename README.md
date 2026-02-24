# 🚀 OmniFetch | Universal Media Pathfinder

A lightweight, high-performance media downloader and search engine built with **Node.js**, **Socket.io**, and **yt-dlp**. Designed for seamless deployment on Render with a "live-engine" strategy.

## 🌟 Key Features

* **Universal Support:** YouTube, TikTok, Instagram, Facebook, Twitter (X), Dailymotion, Vimeo, and more.
* **Intelligent Search:** Type a song or video name to search directly via YouTube without leaving the app.
* **Real-time Feedback:** Live download progress bars powered by WebSockets (Socket.io).
* **Format Flexibility:** One-click downloads for high-quality MP4 video or crystal-clear MP3 audio.
* **Mobile Optimized:** Fully responsive UI with vertical stacking for small devices (like iPhone SE).
* **Privacy First:** No user tracking, no sign-ups, and no logs of your fetches.

## 🛠 Tech Stack

- **Frontend:** HTML5, CSS3 (CSS Variables, Flexbox/Grid), Vanilla JavaScript.
- **Backend:** Node.js (Express), Socket.io.
- **Engine:** `yt-dlp` (Python-based media scraper).
- **Deployment:** Render-ready with automated dependency bootstrapping.

## 🚀 Deployment (Render)

This project uses a **Fresh Install Philosophy**. Instead of locking dependencies, it fetches the absolute latest `yt-dlp` binary at build-time to ensure compatibility with site API changes.

1. **Build Command:**
   ```bash
   npm install && npm run build

2. Start Command: npm start
3.  Environment Variables:YOUTUBE_COOKIES: Paste the contents of your cookies.txt here to bypass bot-checks and age-restrictions.
 

Project Structure
server.js: Express server and yt-dlp child-process management.

index.html: Modern, dark-mode-ready frontend.

kizito2.js: Frontend logic for API communication and UI updates.

package.json: Contains the pip bootstrap script for the media engine.

.gitignore: Prevents sensitive files like cookies.txt or node_modules from being committed.

📝 License
ISC License - Feel free to fork and use!


---

### Why this works for your repo:
* **The "Fresh Install" section:** Explains exactly why you chose that path so people understand the strategy.
* **Environment variable guide:** Reminds you (and others) how to handle the cookies on Render.
* **Minimalist:** It matches the lean, efficient style of your code.

**Since we've wrapped up the Code, the Server, and the Docs, is there any