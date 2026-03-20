# YouTube to MP3 Service

Internal web service for extracting audio from authorized YouTube links and converting it to MP3.

## Stack

- Frontend: Next.js, React, Tailwind CSS 4
- Backend: FastAPI, yt-dlp, FFmpeg
- Runtime: Docker Compose

## Features

- Fetch video metadata by URL
- Start audio extraction and MP3 conversion job
- Poll job status
- Download converted MP3
- Light / dark mode UI
- Basic hardening: job limits, cleanup, timeouts, duplicate protection

## Project Structure

```text
backend/
frontend/
docker-compose.yml
```

## Requirements

### Local development
- Node.js 22+
- Python 3.12+
- FFmpeg available in `PATH`

### Docker
- Docker
- Docker Compose

## Environment

### Backend

```env
APP_DATA_DIR=./data
CORS_ALLOWED_ORIGINS=http://localhost:3000
MAX_DURATION_SECONDS=7200
MAX_ACTIVE_JOBS=2
JOB_TTL_SECONDS=3600
STALE_JOB_SECONDS=21600
CLEANUP_INTERVAL_SECONDS=300
COMMAND_TIMEOUT_SECONDS=1800
```

### Frontend

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
NEXT_PUBLIC_MAX_DURATION_SECONDS=7200
```

## Local Run

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Docker Run

```bash
docker compose up --build
```

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8000`
- Healthcheck: `http://localhost:8000/api/health`

## API

- `POST /api/info`
- `POST /api/jobs`
- `GET /api/jobs/{id}`
- `GET /api/jobs/{id}/download`
- `GET /api/health`

## Notes

Use the service only for content you are authorized to download and convert.
