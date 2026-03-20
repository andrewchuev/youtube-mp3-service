"use client";

import { useEffect, useMemo, useState } from "react";

type ThemeMode = "light" | "dark";

type VideoInfo = {
  title: string;
  duration: number | null;
  thumbnail: string | null;
  uploader: string | null;
  webpage_url: string;
};

type Job = {
  id: string;
  url: string;
  title: string | null;
  status: "queued" | "downloading" | "converting" | "completed" | "failed";
  created_at: number;
  updated_at: number;
  error: string | null;
  download_url: string | null;
  file_name: string | null;
  file_size_bytes: number | null;
};

type ApiError = {
  detail?: string | { msg?: string }[];
};

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:8000";
const MAX_DURATION_SECONDS = Number(process.env.NEXT_PUBLIC_MAX_DURATION_SECONDS || 7200);
const THEME_STORAGE_KEY = "youtube-mp3.theme";

function formatDuration(seconds: number | null): string {
  if (seconds == null) {
    return "Unknown duration";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return [
    hours > 0 ? String(hours).padStart(2, "0") : null,
    String(minutes).padStart(2, "0"),
    String(secs).padStart(2, "0"),
  ]
    .filter(Boolean)
    .join(":");
}

function formatSize(bytes: number | null): string {
  if (bytes == null) {
    return "";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function getErrorMessage(data: ApiError | null, fallback: string): string {
  if (!data?.detail) {
    return fallback;
  }

  if (typeof data.detail === "string") {
    return data.detail;
  }

  if (Array.isArray(data.detail)) {
    return data.detail.map((item) => item.msg).filter(Boolean).join("; ") || fallback;
  }

  return fallback;
}

function getStatusLabel(status: Job["status"] | undefined): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "downloading":
      return "Downloading source audio";
    case "converting":
      return "Converting to MP3";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return "Unknown";
  }
}

function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

export default function HomePage() {
  const [mounted, setMounted] = useState(false);

  const [theme, setTheme] = useState<ThemeMode>("light");
  const [themeReady, setThemeReady] = useState(false);

  const [url, setUrl] = useState("");
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingInfo, setIsLoadingInfo] = useState(false);
  const [isStartingJob, setIsStartingJob] = useState(false);

  const activeJobId = job?.id;

  useEffect(() => {
    setMounted(true);

    try {
      const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
      const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const nextTheme: ThemeMode =
        storedTheme === "dark" || storedTheme === "light"
          ? storedTheme
          : systemPrefersDark
            ? "dark"
            : "light";

      setTheme(nextTheme);
      applyTheme(nextTheme);
    } catch {
      setTheme("light");
      applyTheme("light");
    } finally {
      setThemeReady(true);
    }
  }, []);

  useEffect(() => {
    if (!themeReady) {
      return;
    }

    applyTheme(theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme, themeReady]);

  useEffect(() => {
    if (!activeJobId || job?.status === "completed" || job?.status === "failed") {
      return;
    }

    const intervalId = window.setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/jobs/${activeJobId}`, {
          cache: "no-store",
        });

        const data = (await response.json()) as Job | ApiError;

        if (!response.ok) {
          throw new Error(getErrorMessage(data as ApiError, "Unable to refresh job"));
        }

        setJob(data as Job);
      } catch (pollError) {
        setError(
          pollError instanceof Error
            ? pollError.message
            : "Unable to refresh job status",
        );
      }
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [activeJobId, job?.status]);

  const hasUrl = mounted && Boolean(url.trim());
  const canFetchInfo = hasUrl && !isLoadingInfo && !isStartingJob;
  const canConvert = hasUrl && !isStartingJob && !isLoadingInfo;

  const statusClassName = useMemo(() => {
    switch (job?.status) {
      case "completed":
        return "border border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
      case "failed":
        return "border border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300";
      case "queued":
      case "downloading":
      case "converting":
      default:
        return "border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    }
  }, [job?.status]);

  async function fetchInfo() {
    setError(null);
    setVideoInfo(null);
    setJob(null);
    setIsLoadingInfo(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/info`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });

      const data = (await response.json()) as VideoInfo | ApiError;

      if (!response.ok) {
        throw new Error(getErrorMessage(data as ApiError, "Unable to load video info"));
      }

      setVideoInfo(data as VideoInfo);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to load video info",
      );
    } finally {
      setIsLoadingInfo(false);
    }
  }

  async function startConversion() {
    setError(null);
    setJob(null);
    setIsStartingJob(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });

      const data = (await response.json()) as Job | ApiError;

      if (!response.ok) {
        throw new Error(getErrorMessage(data as ApiError, "Unable to start conversion"));
      }

      setJob(data as Job);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to start conversion",
      );
    } finally {
      setIsStartingJob(false);
    }
  }

  return (
    <main className="px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <span className="inline-flex items-center rounded-full border border-slate-200/80 bg-white/70 px-3 py-1 text-xs font-medium tracking-wide text-slate-600 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-300">
              Internal prototype
            </span>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 dark:text-white sm:text-4xl">
              YouTube → MP3
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300 sm:text-base">
              Paste a YouTube link, inspect the metadata, then convert the audio track into an MP3 file.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            className="inline-flex items-center justify-center rounded-2xl border border-slate-200/80 bg-white/80 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm backdrop-blur transition hover:border-slate-300 hover:bg-white dark:border-slate-800 dark:bg-slate-900/80 dark:text-slate-200 dark:hover:border-slate-700 dark:hover:bg-slate-900"
          >
            {themeReady && theme === "dark" ? "☀️ Light mode" : "🌙 Dark mode"}
          </button>
        </div>

        <section className="rounded-3xl border border-slate-200/70 bg-white/80 p-5 shadow-2xl shadow-slate-950/5 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 dark:shadow-black/20 sm:p-8">
          <div className="grid gap-6">
            <div className="grid gap-3 rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4 dark:border-slate-800 dark:bg-slate-950/60">
              <label
                htmlFor="video-url"
                className="text-sm font-medium text-slate-700 dark:text-slate-200"
              >
                YouTube URL
              </label>

              <input
                id="video-url"
                type="url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-red-400 focus:ring-4 focus:ring-red-500/15 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-red-500"
              />

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={fetchInfo}
                  disabled={!canFetchInfo}
                  className="inline-flex min-w-40 items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-slate-700 dark:hover:bg-slate-800"
                >
                  {isLoadingInfo ? "Loading info..." : "Get video info"}
                </button>

                <button
                  type="button"
                  onClick={startConversion}
                  disabled={!canConvert}
                  className="inline-flex min-w-40 items-center justify-center rounded-2xl bg-red-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-500 dark:hover:bg-red-400"
                >
                  {isStartingJob ? "Starting..." : "Convert to MP3"}
                </button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-200/70 bg-white/70 p-4 dark:border-slate-800 dark:bg-slate-950/50">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                  Usage
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  Use this service only for content you are authorized to download and convert.
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200/70 bg-white/70 p-4 dark:border-slate-800 dark:bg-slate-950/50">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                  Current limit
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  Maximum supported duration: {formatDuration(MAX_DURATION_SECONDS)}.
                </p>
              </div>
            </div>

            {error ? (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            ) : null}

            {videoInfo ? (
              <section className="overflow-hidden rounded-3xl border border-slate-200/70 bg-white/80 dark:border-slate-800 dark:bg-slate-950/50">
                <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[220px,1fr] lg:items-start">
                  {videoInfo.thumbnail ? (
                    <img
                      src={videoInfo.thumbnail}
                      alt={videoInfo.title}
                      className="aspect-video w-full rounded-2xl border border-slate-200 object-cover dark:border-slate-800"
                    />
                  ) : null}

                  <div className="min-w-0">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                      Video metadata
                    </div>
                    <h2 className="mt-2 text-xl font-semibold leading-tight text-slate-950 dark:text-white">
                      {videoInfo.title}
                    </h2>
                    <div className="mt-3 flex flex-wrap gap-2 text-sm text-slate-600 dark:text-slate-300">
                      {videoInfo.uploader ? (
                        <span className="rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-800">
                          {videoInfo.uploader}
                        </span>
                      ) : null}
                      <span className="rounded-full bg-slate-100 px-3 py-1 dark:bg-slate-800">
                        {formatDuration(videoInfo.duration)}
                      </span>
                    </div>

                    <a
                      href={videoInfo.webpage_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-4 inline-flex max-w-full items-center gap-2 break-all text-sm text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300"
                    >
                      <span className="font-medium">Source</span>
                      <span>{videoInfo.webpage_url}</span>
                    </a>
                  </div>
                </div>
              </section>
            ) : null}

            {job ? (
              <section className="rounded-3xl border border-slate-200/70 bg-white/80 p-5 dark:border-slate-800 dark:bg-slate-950/50 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                      Conversion job
                    </div>
                    <h2 className="mt-2 text-xl font-semibold leading-tight text-slate-950 dark:text-white">
                      {job.title || "Conversion job"}
                    </h2>
                    <p className="mt-2 break-all text-sm text-slate-500 dark:text-slate-400">
                      Job ID: {job.id}
                    </p>
                  </div>

                  <div
                    className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold tracking-wide ${statusClassName}`}
                  >
                    {getStatusLabel(job.status)}
                  </div>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {job.error ? (
                    <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300 sm:col-span-2">
                      Error: {job.error}
                    </div>
                  ) : null}

                  <div className="rounded-2xl border border-slate-200/70 bg-slate-50/80 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/70">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                      Status
                    </div>
                    <div className="mt-2 text-sm text-slate-700 dark:text-slate-200">
                      {getStatusLabel(job.status)}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200/70 bg-slate-50/80 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/70">
                    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                      Output size
                    </div>
                    <div className="mt-2 text-sm text-slate-700 dark:text-slate-200">
                      {job.file_size_bytes ? formatSize(job.file_size_bytes) : "—"}
                    </div>
                  </div>
                </div>

                {job.status === "completed" && job.download_url ? (
                  <a
                    href={`${API_BASE_URL}${job.download_url}`}
                    className="mt-5 inline-flex items-center justify-center rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-emerald-500 dark:bg-emerald-500 dark:hover:bg-emerald-400"
                  >
                    Download MP3
                  </a>
                ) : null}
              </section>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}