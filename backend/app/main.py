from __future__ import annotations

import json
import locale
import os
import shlex
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

APP_DATA_DIR = Path(os.getenv("APP_DATA_DIR", "/data"))
TEMP_DIR = APP_DATA_DIR / "tmp"
OUTPUT_DIR = APP_DATA_DIR / "output"

TEMP_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOWED_ORIGINS", "http://localhost:3000").split(",")
    if origin.strip()
]

ALLOWED_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
}

MAX_DURATION_SECONDS = int(os.getenv("MAX_DURATION_SECONDS", "7200"))
MAX_ACTIVE_JOBS = int(os.getenv("MAX_ACTIVE_JOBS", "2"))
JOB_TTL_SECONDS = int(os.getenv("JOB_TTL_SECONDS", "3600"))
STALE_JOB_SECONDS = int(os.getenv("STALE_JOB_SECONDS", "21600"))
CLEANUP_INTERVAL_SECONDS = int(os.getenv("CLEANUP_INTERVAL_SECONDS", "300"))
COMMAND_TIMEOUT_SECONDS = int(os.getenv("COMMAND_TIMEOUT_SECONDS", "1800"))

JobStatus = Literal["queued", "downloading", "converting", "completed", "failed"]
ACTIVE_JOB_STATUSES = {"queued", "downloading", "converting"}
TERMINAL_JOB_STATUSES = {"completed", "failed"}


class VideoUrlRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class VideoInfoResponse(BaseModel):
    title: str
    duration: int | None = None
    thumbnail: str | None = None
    uploader: str | None = None
    webpage_url: str


class JobResponse(BaseModel):
    id: str
    url: str
    title: str | None = None
    status: JobStatus
    created_at: float
    updated_at: float
    error: str | None = None
    download_url: str | None = None
    file_name: str | None = None
    file_size_bytes: int | None = None


app = FastAPI(title="YouTube to MP3 API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

jobs: dict[str, JobResponse] = {}
job_files: dict[str, Path] = {}
jobs_lock = threading.Lock()
cleanup_lock = threading.Lock()
last_cleanup_at = 0.0


@app.get("/api/health")
def healthcheck() -> dict[str, str]:
    cleanup_expired_jobs(force=False)
    return {"status": "ok"}


@app.post("/api/info", response_model=VideoInfoResponse)
def get_video_info(payload: VideoUrlRequest) -> VideoInfoResponse:
    cleanup_expired_jobs(force=False)
    info = validate_and_extract_video_info(payload.url)
    return VideoInfoResponse(
        title=info.get("title") or "Unknown title",
        duration=info.get("duration"),
        thumbnail=info.get("thumbnail"),
        uploader=info.get("uploader"),
        webpage_url=info.get("webpage_url") or payload.url,
    )


@app.post("/api/jobs", response_model=JobResponse)
def create_job(payload: VideoUrlRequest, background_tasks: BackgroundTasks) -> JobResponse:
    cleanup_expired_jobs(force=False)
    info = validate_and_extract_video_info(payload.url)

    with jobs_lock:
        active_jobs = [job for job in jobs.values() if job.status in ACTIVE_JOB_STATUSES]
        if len(active_jobs) >= MAX_ACTIVE_JOBS:
            raise HTTPException(
                status_code=429,
                detail=(
                    "Too many active jobs. Try again after one of the current jobs finishes. "
                    f"Limit: {MAX_ACTIVE_JOBS}."
                ),
            )

        duplicate_job = next(
            (
                job
                for job in active_jobs
                if normalize_url(job.url) == normalize_url(payload.url)
            ),
            None,
        )
        if duplicate_job:
            raise HTTPException(
                status_code=409,
                detail=f"A conversion job for this URL is already running (job {duplicate_job.id}).",
            )

        job_id = uuid.uuid4().hex
        now = time.time()
        job = JobResponse(
            id=job_id,
            url=payload.url,
            title=info.get("title") or "Unknown title",
            status="queued",
            created_at=now,
            updated_at=now,
        )
        jobs[job_id] = job

    background_tasks.add_task(process_job, job_id, payload.url)
    return job


@app.get("/api/jobs/{job_id}", response_model=JobResponse)
def get_job(job_id: str) -> JobResponse:
    cleanup_expired_jobs(force=False)
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/api/jobs/{job_id}/download")
def download_result(job_id: str) -> FileResponse:
    cleanup_expired_jobs(force=False)

    with jobs_lock:
        job = jobs.get(job_id)
        file_path = job_files.get(job_id)

    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "completed":
        raise HTTPException(status_code=409, detail="Job is not completed yet")
    if not file_path or not file_path.exists():
        raise HTTPException(
            status_code=404,
            detail="Output file is no longer available. Please start a new conversion job.",
        )

    return FileResponse(
        path=file_path,
        media_type="audio/mpeg",
        filename=job.file_name or file_path.name,
    )


def process_job(job_id: str, url: str) -> None:
    source_path: Path | None = None
    output_path: Path | None = None

    try:
        update_job(job_id, status="downloading", error=None)
        source_path = download_source_audio(job_id=job_id, url=url)

        update_job(job_id, status="converting")

        with jobs_lock:
            current_job = jobs.get(job_id)

        safe_name = sanitize_filename(
            (current_job.title if current_job else None) or f"audio-{job_id}"
        )
        output_path = OUTPUT_DIR / f"{safe_name}-{job_id[:8]}.mp3"
        convert_to_mp3(source_path=source_path, output_path=output_path)

        file_size = output_path.stat().st_size

        with jobs_lock:
            job_files[job_id] = output_path

        update_job(
            job_id,
            status="completed",
            download_url=f"/api/jobs/{job_id}/download",
            file_name=output_path.name,
            file_size_bytes=file_size,
        )

    except Exception as exc:
        update_job(job_id, status="failed", error=normalize_runtime_error(exc))

    finally:
        if source_path and source_path.exists():
            source_path.unlink(missing_ok=True)
        cleanup_expired_jobs(force=False)


def update_job(job_id: str, **changes: object) -> None:
    with jobs_lock:
        current = jobs.get(job_id)
        if not current:
            return

        updated = current.model_copy(
            update={
                **changes,
                "updated_at": time.time(),
            }
        )
        jobs[job_id] = updated


def cleanup_expired_jobs(*, force: bool) -> None:
    global last_cleanup_at

    now = time.time()
    if not force and now - last_cleanup_at < CLEANUP_INTERVAL_SECONDS:
        return

    if not cleanup_lock.acquire(blocking=False):
        return

    try:
        if not force and now - last_cleanup_at < CLEANUP_INTERVAL_SECONDS:
            return

        expired_job_ids: list[str] = []

        with jobs_lock:
            for job_id, job in list(jobs.items()):
                age_seconds = now - job.updated_at
                is_terminal = (
                    job.status in TERMINAL_JOB_STATUSES and age_seconds >= JOB_TTL_SECONDS
                )
                is_stale = (
                    job.status in ACTIVE_JOB_STATUSES and age_seconds >= STALE_JOB_SECONDS
                )
                if is_terminal or is_stale:
                    expired_job_ids.append(job_id)

            for job_id in expired_job_ids:
                file_path = job_files.pop(job_id, None)
                if file_path and file_path.exists():
                    file_path.unlink(missing_ok=True)

                jobs.pop(job_id, None)

        for temp_file in TEMP_DIR.glob("*"):
            try:
                if now - temp_file.stat().st_mtime >= STALE_JOB_SECONDS:
                    temp_file.unlink(missing_ok=True)
            except FileNotFoundError:
                continue

        last_cleanup_at = now

    finally:
        cleanup_lock.release()


def validate_and_extract_video_info(url: str) -> dict[str, object]:
    ensure_youtube_url(url)
    info = extract_video_info(url)
    validate_video_info(info)
    return info


def ensure_youtube_url(url: str) -> None:
    parsed = urlparse(url.strip())
    hostname = (parsed.hostname or "").lower()

    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="Only http/https URLs are supported")

    if hostname not in ALLOWED_HOSTS:
        raise HTTPException(status_code=400, detail="Only YouTube URLs are supported")


def validate_video_info(info: dict[str, object]) -> None:
    if info.get("is_live"):
        raise HTTPException(status_code=400, detail="Live streams are not supported")

    duration = info.get("duration")
    if isinstance(duration, int) and duration > MAX_DURATION_SECONDS:
        raise HTTPException(
            status_code=400,
            detail=(
                "Video is too long. "
                f"Maximum supported duration is {format_seconds(MAX_DURATION_SECONDS)}."
            ),
        )


def extract_video_info(url: str) -> dict[str, object]:
    command = [
        "yt-dlp",
        "--dump-single-json",
        "--skip-download",
        "--no-warnings",
        "--no-playlist",
        url,
    ]
    completed = run_command(command)

    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Unable to parse video metadata") from exc


def download_source_audio(job_id: str, url: str) -> Path:
    output_template = str(TEMP_DIR / f"{job_id}.%(ext)s")
    command = [
        "yt-dlp",
        "--no-playlist",
        "--no-progress",
        "-f",
        "bestaudio/best",
        "--output",
        output_template,
        "--print",
        "after_move:filepath",
        url,
    ]
    completed = run_command(command)
    lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("yt-dlp did not return the downloaded file path")

    file_path = Path(lines[-1])
    if not file_path.exists():
        raise RuntimeError("Downloaded audio file is missing")

    return file_path


def convert_to_mp3(source_path: Path, output_path: Path) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(source_path),
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "2",
        str(output_path),
    ]
    run_command(command)


def decode_process_output(value: bytes | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value

    encodings_to_try: list[str] = ["utf-8"]

    preferred = locale.getpreferredencoding(False)
    if preferred and preferred.lower() not in {"utf-8"}:
        encodings_to_try.append(preferred)

    for encoding in encodings_to_try:
        try:
            return value.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue

    return value.decode("utf-8", errors="replace")


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            command,
            check=True,
            text=False,
            capture_output=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )

        return subprocess.CompletedProcess(
            args=completed.args,
            returncode=completed.returncode,
            stdout=decode_process_output(completed.stdout),
            stderr=decode_process_output(completed.stderr),
        )

    except FileNotFoundError as exc:
        joined = " ".join(shlex.quote(part) for part in command)
        raise RuntimeError(f"Missing executable while running: {joined}") from exc

    except subprocess.TimeoutExpired as exc:
        joined = " ".join(shlex.quote(part) for part in command)
        raise RuntimeError(f"Command timed out while running: {joined}") from exc

    except subprocess.CalledProcessError as exc:
        stderr = decode_process_output(exc.stderr).strip()
        stdout = decode_process_output(exc.stdout).strip()
        message = stderr or stdout or "Unknown command error"
        raise RuntimeError(message) from exc


def normalize_runtime_error(error: Exception) -> str:
    message = str(error).strip() or "Unknown error"
    lowered = message.lower()

    if "sign in to confirm" in lowered or "bot" in lowered:
        return "YouTube temporarily rejected the request. Please try again later."
    if "video unavailable" in lowered:
        return "The video is unavailable or restricted."
    if "private video" in lowered:
        return "Private videos are not supported."
    if "members-only" in lowered or "members only" in lowered:
        return "Members-only videos are not supported."
    if "copyright" in lowered and "blocked" in lowered:
        return "The video cannot be downloaded because of a copyright or regional restriction."
    if "ffmpeg" in lowered and "missing executable" in lowered:
        return "FFmpeg is not installed or is not available in PATH."
    if "yt-dlp" in lowered and "missing executable" in lowered:
        return "yt-dlp is not installed or is not available in PATH."
    if "timed out" in lowered:
        return "The operation took too long and was cancelled. Try a shorter video."
    if "unable to parse video metadata" in lowered:
        return "Unable to read video metadata. Please verify the URL and try again."
    if "downloaded audio file is missing" in lowered:
        return "The downloaded audio file is missing. Please try again."

    return message


def sanitize_filename(value: str) -> str:
    safe = "".join(char if char.isalnum() or char in {"-", "_"} else "-" for char in value)
    while "--" in safe:
        safe = safe.replace("--", "-")
    return safe.strip("-_")[:80] or "audio"


def normalize_url(url: str) -> str:
    return url.strip()


def format_seconds(total_seconds: int) -> str:
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60

    if hours:
        return f"{hours}h {minutes}m {seconds}s"
    if minutes:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"