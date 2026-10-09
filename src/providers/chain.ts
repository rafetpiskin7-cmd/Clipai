import { withRetry, analysisPrompt, llmTimeout } from "./gemini.js";
import type { AIAnalysisProvider, ClipMode, ClipPart, ClipPlan, Segment, Transcript, TranscriptionProvider, VideoMeta } from "./types.js";

const msg = (e: any) => String(e?.message ?? e).slice(0, 220);

/** Sağlayıcıları sırayla dener; biri hata verirse sonrakine geçer. */
export class ChainTranscription implements TranscriptionProvider {
  constructor(private ps: { name: string; p: TranscriptionProvider }[]) {}
  async transcribe(audioPath: string): Promise<Transcript> {
    const errs: string[] = [];
    for (const { name, p } of this.ps) {
      try { return await p.transcribe(audioPath); }
      catch (e) { errs.push(`${name}: ${msg(e)}`); }
    }
    throw new Error("Transkript sağlayıcılarının hepsi başarısız → " + errs.join(" | "));
  }
}

/** LLM çıktısındaki metin/sayı karışıklıklarını düzeltir, geçersiz klipleri atar. Montaj parçalarını korur. */
export function normalizeClips(raw: any[]): ClipPlan[] {
  return (Array.isArray(raw) ? raw : []).map(c => {
    const segs: ClipPart[] = (Array.isArray(c?.segments) ? c.segments : [])
      .map((x: any) => ({ start: Number(x?.start), end: Number(x?.end), label: x?.label !== undefined && x?.label !== null ? String(x.label) : undefined }))
      .filter((x: ClipPart) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start);
    return {
      title: String(c?.title ?? "").trim() || "Klip",
      start: segs.length ? Math.min(...segs.map(x => x.start)) : Number(c?.start),
      end: segs.length ? Math.max(...segs.map(x => x.end)) : Number(c?.end),
      viralScore: Math.max(0, Math.min(100, Math.round(Number(c?.viralScore) || 0))),
      hook: String(c?.hook ?? ""), reason: String(c?.reason ?? ""), description: String(c?.description ?? ""),
      hashtags: Array.isArray(c?.hashtags) ? c.hashtags.map(String) : [],
      segments: segs.length ? segs : undefined,
    } as ClipPlan;
  }).filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
}

export class ChainAnalysis implements AIAnalysisProvider {
  constructor(private ps: { name: string; p: AIAnalysisProvider }[]) {}
  async findClips(t: Transcript, meta: VideoMeta, mode: ClipMode = "single"): Promise<ClipPlan[]> {
    const errs: string[] = [];
    for (const { name, p } of this.ps) {
      try {
        const clips = normalizeClips(await p.findClips(t, meta, mode));
        if (clips.length) return clips;
        errs.push(`${name}: geçerli klip yok`);
      } catch (e) { errs.push(`${name}: ${msg(e)}`); }
    }
    throw new Error("Analiz sağlayıcılarının hepsi başarısız → " + errs.join(" | "));
  }
}

/** Uzun transkripti, ücretsiz planların dakikalık token sınırına sığacak parçalara böler. */
export function chunkTranscript(t: Transcript, maxChars: number): Transcript[] {
  const out: Transcript[] = [];
  let cur: Segment[] = [], size = 0;
  for (const s of t.segments) {
    const len = s.text.length + 16;
    if (cur.length && size + len > maxChars) { out.push({ language: t.language, segments: cur }); cur = []; size = 0; }
    cur.push(s); size += len;
  }
  if (cur.length) out.push({ language: t.language, segments: cur });
  return out.length ? out : [t];
}

/** OpenAI uyumlu /chat/completions sunan herhangi bir sağlayıcı (Groq, Mistral, OpenRouter...). */
export class OpenAICompatAnalysis implements AIAnalysisProvider {
  constructor(private name: string, private baseUrl: string, private key: string, private models: string[]) {}

  private async chat(model: string, prompt: string): Promise<string> {
    const r = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(llmTimeout()),
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3 }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${this.name} ${r.status}: ${j?.error?.message ?? JSON.stringify(j).slice(0, 200)}`);
    return j.choices?.[0]?.message?.content ?? "";
  }

  async findClips(t: Transcript, meta: VideoMeta, mode: ClipMode = "single"): Promise<ClipPlan[]> {
    const chunks = chunkTranscript(t, Number(process.env.LLM_CHUNK_CHARS) || 12000);
    let last: any;
    for (const model of this.models) {
      try {
        const all: any[] = [];
        for (const c of chunks) {
          const text = await withRetry(() => this.chat(model, analysisPrompt(c, meta, mode)));
          const m = text.match(/\[[\s\S]*\]/);
          if (!m) throw new Error("geçerli JSON döndürmedi");
          all.push(...JSON.parse(m[0]));
        }
        return all as ClipPlan[];
      } catch (e) { last = e; }
    }
    throw new Error(`${this.name} (${this.models.join(", ")}): ${msg(last)}`);
  }
}
