
# Castwright Docker Setup

This setup runs **Castwright** in Docker with NVIDIA GPU support, persistent storage, LAN access, and optional connectivity to an Ollama container running in a separate Docker Compose project.

## Architecture

```text
                    Docker Host
                         │
                         │
                 Castwright Container
                 ┌───────────────────┐
                 │ Node.js Backend   │
                 │ Built Frontend    │
                 │ TTS Sidecar       │
                 │ NVIDIA GPU        │
                 └────────┬──────────┘
                          │
                          │ ai-net
                          │
                    ┌─────▼─────┐
                    │  Ollama   │
                    │  :11434   │
                    └───────────┘
```

Castwright and Ollama can live in completely separate Compose projects as long as both containers are attached to the external Docker network `ai-net`.

---

## Requirements

The host should have:

* Docker Engine
* Docker Compose
* NVIDIA drivers
* NVIDIA Container Toolkit
* A supported NVIDIA GPU
* An existing Castwright source checkout

Verify GPU access through Docker:

```bash
docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi
```

---

## Directory Structure

Example:

```text
todds-library/
├── docker-compose.yml
├── Dockerfile
└── Castwright/
    ├── package.json
    ├── server/
    │   ├── .env
    │   └── tts-sidecar/
    └── ...
```

---

# Dockerfile

Example Dockerfile:

```dockerfile
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# --------------------------------------------------
# System dependencies
# --------------------------------------------------

RUN apt-get update && apt-get install -y \
    python3.12 \
    python3.12-venv \
    python3.12-dev \
    python3-pip \
    ffmpeg \
    git \
    curl \
    ca-certificates \
    build-essential \
    libsndfile1 \
    gnupg \
    libnss3-tools \
    zstd \
    && rm -rf /var/lib/apt/lists/*


# --------------------------------------------------
# Node.js 24
# --------------------------------------------------

RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*


# --------------------------------------------------
# mkcert
# --------------------------------------------------

RUN curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64" \
    && chmod +x mkcert-* \
    && mv mkcert-* /usr/local/bin/mkcert


# --------------------------------------------------
# Application
# --------------------------------------------------

WORKDIR /app

COPY Castwright ./


# Disable Husky hooks during Docker build
ENV HUSKY=0


# --------------------------------------------------
# Node dependencies
# --------------------------------------------------

RUN npm ci

RUN npm --prefix server ci


# --------------------------------------------------
# TTS environment
# --------------------------------------------------

ENV ACCELERATOR=nvidia

RUN node server/tts-sidecar/scripts/bootstrap-venv.mjs python3.12


# --------------------------------------------------
# Build frontend/backend
# --------------------------------------------------

RUN npm run build


# --------------------------------------------------
# Runtime
# --------------------------------------------------

ENV NODE_ENV=production
ENV BIND_HOST=0.0.0.0

EXPOSE 8443


WORKDIR /app/server

CMD ["sh", "-c", "node /app/scripts/setup-lan-certs.mjs --best-effort && exec node dist/index.js"]
```

---

# Castwright Configuration

Create:

```text
Castwright/server/.env
```

A basic configuration might look like:

```env
# --------------------------------------------------
# Network
# --------------------------------------------------

BIND_HOST=0.0.0.0

LAN_HTTPS=1
LAN_HTTPS_PORT=8443


# --------------------------------------------------
# Ollama
# --------------------------------------------------

OLLAMA_URL=http://ollama:11434


# --------------------------------------------------
# TTS
# --------------------------------------------------

LOCAL_TTS_URL=http://localhost:9000


# --------------------------------------------------
# Workspace
# --------------------------------------------------

WORKSPACE_DIR=../audiobook-workspace


# --------------------------------------------------
# GPU
# --------------------------------------------------

ACCELERATOR=nvidia
```

If you prefer plain HTTP behind a reverse proxy such as Caddy:

```env
LAN_HTTPS=0
BIND_HOST=0.0.0.0
PORT=8080
```

The application would then be available internally over:

```text
http://castwright:8080
```

and Caddy can provide HTTPS externally.

---

# Docker Compose

Example `docker-compose.yml`:

```yaml
services:
  castwright:
    build:
      context: .
      dockerfile: Dockerfile

    container_name: castwright

    restart: unless-stopped

    gpus: all

    ports:
      - "8443:8443"

    environment:
      NODE_ENV: production
      ACCELERATOR: nvidia
      BIND_HOST: 0.0.0.0

      # Ollama is hosted in another container
      OLLAMA_URL: http://ollama:11434

    volumes:
      # Books, generated audio, metadata, etc.
      - castwright-workspace:/app/audiobook-workspace

      # Account/user settings
      - castwright-settings:/root/.castwright

      # Castwright runtime state / certificates
      - castwright-run:/app/.run

      # Keep server configuration outside the image
      - ./Castwright/server/.env:/app/server/.env:ro

    networks:
      - ai-net


volumes:
  castwright-workspace:
  castwright-settings:
  castwright-run:


networks:
  ai-net:
    external: true
    name: ai-net
```

---

# Create the Shared AI Network

The external network only needs to be created once:

```bash
docker network create ai-net
```

Verify:

```bash
docker network inspect ai-net
```

Both Castwright and Ollama should eventually appear under the network's `Containers` section.

---

# Ollama in Another Compose Project

Ollama does **not** need to be in the same Compose file.

Example Ollama Compose:

```yaml
services:
  ollama:
    image: ollama/ollama:latest

    container_name: ollama

    restart: unless-stopped

    gpus: all

    environment:
      OLLAMA_HOST: 0.0.0.0:11434

    volumes:
      - ollama-data:/root/.ollama

    networks:
      ai-net:
        aliases:
          - ollama


volumes:
  ollama-data:


networks:
  ai-net:
    external: true
    name: ai-net
```

The Ollama port does not need to be published to the host unless something outside Docker needs direct access to it.

Castwright accesses Ollama through Docker DNS:

```text
http://ollama:11434
```

Do **not** use:

```text
http://localhost:11434
```

inside Castwright when Ollama is running in another container.

`localhost` inside the Castwright container refers to the Castwright container itself.

---

# Start Castwright

Build:

```bash
docker compose build
```

Start:

```bash
docker compose up -d
```

Watch logs:

```bash
docker logs -f castwright
```

---

# Verify GPU Access

```bash
docker exec castwright nvidia-smi
```

The NVIDIA GPU should appear inside the container.

---

# Verify the TTS Sidecar

The TTS sidecar normally runs inside the Castwright container.

Check it with:

```bash
docker exec castwright curl http://127.0.0.1:9000/speakers
```

You can also check the health endpoint:

```bash
docker exec castwright curl http://127.0.0.1:9000/health
```

Port `9000` does **not** need to be published to the host.

---

# Verify Ollama Connectivity

From inside Castwright:

```bash
docker exec castwright curl http://ollama:11434/api/tags
```

If this returns JSON containing the installed models, Docker networking is working.

Check DNS resolution:

```bash
docker exec castwright getent hosts ollama
```

---

# Important: Castwright's Saved Ollama URL

Castwright can save its Ollama URL in:

```text
/root/.castwright/user-settings.json
```

This setting may override `OLLAMA_URL`.

Check it:

```bash
docker exec castwright \
  grep '"ollamaUrl"' /root/.castwright/user-settings.json
```

For a separate Ollama container it should be:

```json
"ollamaUrl": "http://ollama:11434"
```

If it still contains:

```json
"ollamaUrl": "http://localhost:11434"
```

Castwright may report Ollama as unavailable even though Docker networking is working.

After manually changing this file, restart Castwright:

```bash
docker restart castwright
```

---

# Persistent Storage

The example Compose file persists three important Castwright locations.

### Workspace

```text
/app/audiobook-workspace
```

Contains books, generated audio, analysis data, and other workspace files.

Docker volume:

```yaml
castwright-workspace:/app/audiobook-workspace
```

### User Settings

```text
/root/.castwright
```

Contains persistent Castwright user/account settings.

Docker volume:

```yaml
castwright-settings:/root/.castwright
```

### Runtime State

```text
/app/.run
```

Used for runtime state and LAN HTTPS certificate information.

Docker volume:

```yaml
castwright-run:/app/.run
```

---

# Using a Different External Port

Docker does not require Castwright's internal port to match the host port.

For example:

```yaml
ports:
  - "9990:8443"
```

means:

```text
LAN
https://SERVER-IP:9990
        │
        ▼
Docker host :9990
        │
        ▼
Castwright :8443
```

Castwright itself still listens on `8443`.

---

# Plain HTTP / Reverse Proxy Setup

If Caddy, Nginx, Traefik, or another reverse proxy provides HTTPS, Castwright can run HTTP internally.

`server/.env`:

```env
LAN_HTTPS=0
BIND_HOST=0.0.0.0
PORT=8080
```

Compose:

```yaml
services:
  castwright:
    environment:
      LAN_HTTPS: "0"
      BIND_HOST: 0.0.0.0
      PORT: "8080"

    networks:
      - ai-net
      - proxy
```

A reverse proxy on the `proxy` network can then connect to:

```text
http://castwright:8080
```

There is no requirement to publish port `8080` to the host when the reverse proxy is also running in Docker.

---

# Useful Commands

Rebuild Castwright:

```bash
docker compose build castwright
```

Rebuild without cache:

```bash
docker compose build --no-cache castwright
```

Recreate:

```bash
docker compose up -d --force-recreate castwright
```

Logs:

```bash
docker logs -f castwright
```

Open a shell:

```bash
docker exec -it castwright bash
```

Check networks:

```bash
docker inspect castwright --format '{{json .NetworkSettings.Networks}}'
```

Check Ollama:

```bash
docker exec castwright curl http://ollama:11434/api/tags
```

Check TTS:

```bash
docker exec castwright curl http://localhost:9000/health
```

Check saved Ollama configuration:

```bash
docker exec castwright \
  grep '"ollamaUrl"' /root/.castwright/user-settings.json
```

Check GPU:

```bash
docker exec castwright nvidia-smi
```

---

# Troubleshooting

## Ollama says unreachable

Confirm:

```bash
docker exec castwright curl http://ollama:11434/api/tags
```

If that works, inspect:

```bash
docker exec castwright \
  grep '"ollamaUrl"' /root/.castwright/user-settings.json
```

It should point to:

```text
http://ollama:11434
```

---

## TTS sidecar unavailable

Check:

```bash
docker exec castwright curl http://127.0.0.1:9000/health
```

Then inspect:

```bash
docker logs castwright
```

Verify the Python environment:

```bash
docker exec castwright \
  /app/server/tts-sidecar/.venv/bin/python --version
```

It should use the Python version expected by Castwright's TTS dependencies.

---

## GPU unavailable

Check the host:

```bash
nvidia-smi
```

Then Docker:

```bash
docker run --rm --gpus all \
  nvidia/cuda:12.8.0-base-ubuntu24.04 \
  nvidia-smi
```

Then Castwright:

```bash
docker exec castwright nvidia-smi
```

---

## HTTP works but HTTPS fails

Make sure the URL matches the server mode.

For:

```env
LAN_HTTPS=0
PORT=9990
```

use:

```text
http://SERVER-IP:9990
```

not:

```text
https://SERVER-IP:9990
```

For:

```env
LAN_HTTPS=1
LAN_HTTPS_PORT=8443
```

use:

```text
https://SERVER-IP:8443
```

---

## Rebuilding Does Not Change Saved Settings

Docker image rebuilds do not erase named volumes.

If `castwright-settings` is mounted to:

```text
/root/.castwright
```

then settings stored there survive:

```bash
docker compose down
docker compose build
docker compose up -d
```

This is intentional.

To inspect the persistent settings:

```bash
docker exec castwright \
  cat /root/.castwright/user-settings.json
```

Do not delete the settings volume unless you intentionally want to reset Castwright's saved account configuration.
