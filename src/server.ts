import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline as pipe } from "node:stream/promises";
import { LocalFileSource } from "./providers/local.js";
import { randomUUID } from "node:crypto";
import { YtDlpSource } from "./providers/youtube.js";
import { GeminiAnalysis, GeminiTranscription } from "./providers/gemini.js";
import { ClaudeAnalysis } from "./providers/claude.js";
import { newJob, rerender, runPipeline, type Deps, type Job } from "./pipeline.js";
import type { CaptionStyle, StorageProvider } from "./providers/types.js";

const DATA = path.resolve(process.env.DATA_DIR || "./data");
const storage: StorageProvider = {
  async dir(id) { const d = path.join(DATA, id); await fs.mkdir(d, { recursive: true }); return d; },
  url: (id, f) => `/media/${id}/${f}`,
};
// Sağlayıcıları burada değiştir: VideoSource / Transcription / AIAnalysis.
const useClaude = process.env.AI_PROVIDER === "claude";
const deps: Deps = {
  source: new YtDlpSource(),
  stt: new GeminiTranscription(),
  ai: useClaude ? new ClaudeAnalysis() : new GeminiAnalysis(),
  storage,
};

const jobs = new Map<string, Job>();
const app = express();
app.use(express.json());
app.use(express.static(path.resolve("public")));
app.use("/media", express.static(DATA));

const view = (j: Job) => ({
  id: j.id, status: j.status, error: j.error, steps: j.steps, meta: j.meta,
  clips: j.clips.map(c => ({ ...c, file: storage.url(j.id, c.file) })),
});

app.post("/api/projects", async (req, res) => {
  const { url, rightsConfirmed, style } = req.body ?? {};
  if (!rightsConfirmed) return res.status(400).json({ error: "Videoyu işleme hakkına sahip olduğunu onaylamalısın." });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY .env içinde tanımlı olmalı." });
  if (useClaude && !process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "AI_PROVIDER=claude için ANTHROPIC_API_KEY gerekli." });
  const id = randomUUID();
  const job = newJob(id, String(url), (style as CaptionStyle) ?? { name: "bold" }, await storage.dir(id));
  jobs.set(id, job);
  runPipeline(job, deps);
  res.status(202).json({ id });
});

const MAX_UPLOAD = 300 * 1024 * 1024;
const EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
app.post("/api/projects/upload", async (req, res) => {
  try {
    if (req.header("x-rights") !== "true") return res.status(400).json({ error: "Videoyu işleme hakkına sahip olduğunu onaylamalısın." });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY .env içinde tanımlı olmalı." });
    if (Number(req.header("content-length") || 0) > MAX_UPLOAD) return res.status(413).json({ error: "Dosya çok büyük (en fazla 300 MB)." });
    const name = decodeURIComponent(req.header("x-filename") || "video.mp4");
    const ext = path.extname(name).toLowerCase();
    if (!EXTS.has(ext)) return res.status(400).json({ error: "Desteklenen formatlar: mp4, mov, mkv, webm, m4v." });
    const style = JSON.parse(decodeURIComponent(req.header("x-style") || '{"name":"bold"}')) as CaptionStyle;
    const id = randomUUID();
    const dir = await storage.dir(id);
    const file = path.join(dir, "upload" + ext);
    await pipe(req, createWriteStream(file));
    const job = newJob(id, name, style, dir);
    job.src = new LocalFileSource(file, path.basename(name, ext));
    jobs.set(id, job);
    runPipeline(job, deps);
    res.status(202).json({ id });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/api/projects/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  j ? res.json(view(j)) : res.status(404).json({ error: "Proje yok" });
});

app.post("/api/projects/:id/clips/:n/rerender", async (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "Proje yok" });
  try {
    const c = await rerender(j, Number(req.params.n), req.body ?? {});
    res.json({ ...c, file: storage.url(j.id, c.file) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get("/api/health", (_q, res) => res.json({ ok: true }));

app.listen(Number(process.env.PORT) || 3000, () => console.log("ShortifyAI → http://localhost:" + (process.env.PORT || 3000)));
