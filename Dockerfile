FROM node:20-slim

# yt-dlp needs: python3 + ffmpeg (muxing), curl (fetch binary), and a JS
# runtime (Deno) — YouTube's extraction now requires running a bit of JS
# to build valid stream URLs; without it yt-dlp falls back to a client
# that's both incomplete and much more likely to get 429 rate-limited.
RUN apt-get update && \
    apt-get install -y python3 ffmpeg curl unzip && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    curl -fsSL https://deno.land/install.sh | sh -s -- -y --no-modify-path && \
    mv /root/.deno/bin/deno /usr/local/bin/deno && \
    rm -rf /root/.deno /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

EXPOSE 3000
CMD ["npm", "start"]
