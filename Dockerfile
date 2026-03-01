# ── Base: Node 20 on Debian Bookworm ─────────────────────────────────────────
FROM node:20-slim

# ── System deps ───────────────────────────────────────────────────────────────
# ffmpeg      — video mux/transcode/trim
# python3+pip — for yt-dlp and plugins
# curl-cffi   — TLS fingerprint spoofing (makes yt-dlp look like real Chrome)
# ca-certs    — HTTPS validation
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        python3-dev \
        build-essential \
        curl \
        wget \
        ca-certificates \
        gnupg && \
    rm -rf /var/lib/apt/lists/*

# ── Python packages ───────────────────────────────────────────────────────────
#
#  yt-dlp[default,curl-cffi]
#    └─ curl-cffi enables --impersonate chrome-124
#       (spoofs TLS fingerprint so sites can't detect server IP as bot)
#
#  bgutil-yt-dlp-plugin
#    └─ auto-generates YouTube PO tokens without needing cookies
#       (kills the "Sign in to confirm you're not a bot" error)
#
RUN pip3 install -U \
        "yt-dlp[default,curl-cffi]" \
        bgutil-yt-dlp-plugin \
        requests \
        --break-system-packages && \
    yt-dlp --version && \
    echo "✅ yt-dlp + plugins installed"

# ── Verify impersonate support ────────────────────────────────────────────────
RUN yt-dlp --help 2>&1 | grep -q "impersonate" && \
    echo "✅ --impersonate supported" || \
    echo "⚠️  --impersonate not available (curl-cffi may not have installed correctly)"

# ── App ───────────────────────────────────────────────────────────────────────
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# ── Cache dir for yt-dlp OAuth2 token persistence ────────────────────────────
# On Render: /tmp is writable. We pre-create the cache dir.
RUN mkdir -p /tmp/.cache/yt-dlp && chmod 777 /tmp/.cache/yt-dlp

# ── Environment ───────────────────────────────────────────────────────────────
ENV PORT=10000
ENV DOCKER=true
# Optional: set COBALT_API to your self-hosted Cobalt instance URL
# ENV COBALT_API=https://your-cobalt.example.com
# Optional: set PROXY_URL for residential proxy (helps with stubborn platforms)
# ENV PROXY_URL=http://user:pass@proxy-host:port

EXPOSE 10000
CMD ["node", "server.js"]