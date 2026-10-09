import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline as pipe } from "node:stream/promises";
import { LocalFileSource } from "./providers/local.js";
import { setupAuth } from "./auth.js";
import { randomUUID } from "node:crypto";
import { YtDlpSource } from "./providers/youtube.js";
import { GeminiAnalysis, GeminiTranscription } from "./providers/gemini.js";
import { GroqTranscription } from "./providers/groq.js";
import { ChainAnalysis, ChainTranscription, OpenAICompatAnalysis } from "./providers/chain.js";
import { ClaudeAnalysis } from "./providers/claude.js";
import { newJob, rerender, runPipeline, type Deps, type Job } from "./pipeline.js";
import type { CaptionStyle, StorageProvider } from "./providers/types.js";

const DATA = path.resolve(process.env.DATA_DIR || "./data");
const storage: StorageProvider = {
  async dir(id) { const d = path.join(DATA, id); await fs.mkdir(d, { recursive: true }); return d; },
  url: (id, f) => `/media/${id}/${f}`,
};
// Sağlayıcıları burada değiştir: VideoSource / Transcription / AIAnalysis.
const E = process.env;
const list = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean);
const has: Record<string, boolean> = { gemini: !!E.GEMINI_API_KEY, groq: !!E.GROQ_API_KEY, mistral: !!E.MISTRAL_API_KEY, claude: !!E.ANTHROPIC_API_KEY };
const sttOrder = list(E.STT_PROVIDERS || "groq,gemini").filter(n => has[n] && (n === "groq" || n === "gemini"));
const aiOrder = list(E.ANALYSIS_PROVIDERS || (E.AI_PROVIDER === "claude" ? "claude,gemini,groq,mistral" : "gemini,groq,mistral,claude")).filter(n => has[n]);
const groqBase = E.GROQ_BASE_URL || "https://api.groq.com";
const sttMap: Record<string, () => any> = {
  groq: () => new GroqTranscription(E.GROQ_API_KEY!),
  gemini: () => new GeminiTranscription(),
};
const aiMap: Record<string, () => any> = {
  gemini: () => new GeminiAnalysis(),
  groq: () => new OpenAICompatAnalysis("Groq", `${groqBase}/openai/v1`, E.GROQ_API_KEY!,
    list(E.GROQ_ANALYSIS_MODELS || "meta-llama/llama-4-scout-17b-16e-instruct,llama-3.3-70b-versatile,openai/gpt-oss-120b")),
  mistral: () => new OpenAICompatAnalysis("Mistral", "https://api.mistral.ai/v1", E.MISTRAL_API_KEY!,
    list(E.MISTRAL_ANALYSIS_MODELS || "mistral-large-latest,mistral-small-latest")),
  claude: () => new ClaudeAnalysis(),
};
const keyError = () => (!sttOrder.length || !aiOrder.length)
  ? "Transkript için GROQ_API_KEY veya GEMINI_API_KEY, analiz için GEMINI_API_KEY, GROQ_API_KEY veya MISTRAL_API_KEY tanımlı olmalı." : null;
const deps: Deps = {
  source: new YtDlpSource(),
  stt: new ChainTranscription(sttOrder.map(name => ({ name, p: sttMap[name]() }))),
  ai: new ChainAnalysis(aiOrder.map(name => ({ name, p: aiMap[name]() }))),
  storage,
};
console.log("Transkript sırası:", sttOrder.join(" > ") || "-", "| Analiz sırası:", aiOrder.join(" > ") || "-");

const jobs = new Map<string, Job>();
const app = express();
app.use(express.json());
setupAuth(app, DATA);
app.use(express.static(path.resolve("public")));
app.use("/media", express.static(DATA));

const view = (j: Job) => ({
  id: j.id, status: j.status, error: j.error, steps: j.steps, meta: j.meta, total: j.plans.length,
  clips: j.clips.map(c => ({ ...c, file: storage.url(j.id, c.file) })),
});

app.post("/api/projects", async (req, res) => {
  const { url, rightsConfirmed, style, mode } = req.body ?? {};
  if (!rightsConfirmed) return res.status(400).json({ error: "Videoyu işleme hakkına sahip olduğunu onaylamalısın." });
  const ke = keyError(); if (ke) return res.status(500).json({ error: ke });
  const id = randomUUID();
  const job = newJob(id, String(url), (style as CaptionStyle) ?? { name: "bold" }, await storage.dir(id));
  job.mode = mode === "single" || mode === "montage" ? mode : undefined;
  jobs.set(id, job);
  runPipeline(job, deps);
  res.status(202).json({ id });
});

const MAX_UPLOAD = 300 * 1024 * 1024;
const EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
app.post("/api/projects/upload", async (req, res) => {
  try {
    if (req.header("x-rights") !== "true") return res.status(400).json({ error: "Videoyu işleme hakkına sahip olduğunu onaylamalısın." });
    const ke = keyError(); if (ke) return res.status(500).json({ error: ke });
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
    const m = req.header("x-mode");
    job.mode = m === "single" || m === "montage" ? m : undefined;
    jobs.set(id, job);
    runPipeline(job, deps);
    res.status(202).json({ id });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/api/projects/:id/transcript", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j?.transcript) return res.status(404).json({ error: "Transkript yok" });
  res.json(j.transcript.segments.map(x => ({ start: x.start, end: x.end, text: x.text })));
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
