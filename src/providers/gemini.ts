import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI, createPartFromUri } from "@google/genai";
import { run } from "../services/shell.js";
import type { AIAnalysisProvider, ClipPlan, Segment, Transcript, TranscriptionProvider, VideoMeta, Word } from "./types.js";

const CHUNK_SEC = 1200; // kelime zaman damgası açıkken ses başına limit 30 dk; 20 dk'lık parçalara böleriz

const sec = (v: unknown) => parseFloat(String(v ?? "0").replace("s", "")) || 0;

/** Kelime listesini cümle/duraklama sınırlarında segmentlere böler. Saf fonksiyon, test edilebilir. */
export function wordsToSegments(words: Word[]): Segment[] {
  const out: Segment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ text: cur.map(w => w.text).join(" "), start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };
  words.forEach((w, i) => {
    cur.push(w);
    const gap = words[i + 1] ? words[i + 1].start - w.end : 0;
    if (/[.?!…]$/.test(w.text) || gap > 0.8 || w.end - cur[0].start > 12) flush();
  });
  flush();
  return out;
}

/** API cevabındaki kelime anotasyonlarını çıkarır (parts[].audioTranscription.words). */
export function extractWords(resp: any, offset: number): Word[] {
  const words: Word[] = [];
  for (const c of resp?.candidates ?? [])
    for (const part of c?.content?.parts ?? [])
      for (const w of part?.audioTranscription?.words ?? [])
        if (w?.word) words.push({ text: String(w.word).trim(), start: offset + sec(w.startOffset), end: offset + sec(w.endOffset) });
  return words;
}

async function uploadAudio(ai: GoogleGenAI, file: string) {
  let f = await ai.files.upload({ file, config: { mimeType: "audio/mp3" } });
  while (f.state === "PROCESSING" && f.name) {
    await new Promise(r => setTimeout(r, 2000));
    f = await ai.files.get({ name: f.name });
  }
  if (f.state === "FAILED") throw new Error("Gemini ses dosyasını işleyemedi.");
  return f;
}

/** SDK yeni alanları (audioTranscriptionConfig) silebildiği için isteği doğrudan REST ile atıyoruz. */
export async function callTranscribe(fileUri: string, mimeType: string): Promise<any> {
  const base = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  const model = process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.5-transcribe";
  const r = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY || "", "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ fileData: { fileUri, mimeType } }] }],
      generationConfig: { audioTranscriptionConfig: { wordTimestamp: true } },
    }),
  });
  const json: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${json?.error?.message ?? JSON.stringify(json).slice(0, 300)}`);
  return json;
}

export class GeminiTranscription implements TranscriptionProvider {
  private ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  async transcribe(audioPath: string): Promise<Transcript> {
    const dir = path.dirname(audioPath);
    await run("ffmpeg", ["-y", "-i", audioPath, "-f", "segment", "-segment_time", String(CHUNK_SEC), "-c", "copy", path.join(dir, "chunk%03d.mp3")]);
    const chunks = (await fs.readdir(dir)).filter(f => /^chunk\d+\.mp3$/.test(f)).sort();
    const all: Word[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const up = await uploadAudio(this.ai, path.join(dir, chunks[i]));
      const resp = await callTranscribe(up.uri!, up.mimeType!);
      const got = extractWords(resp, i * CHUNK_SEC);
      if (!got.length) throw new Error("Gemini kelime zaman damgası döndürmedi. Cevap: " + JSON.stringify(resp).slice(0, 400));
      all.push(...got);
      if (up.name) await this.ai.files.delete({ name: up.name }).catch(() => {});
    }
    if (!all.length) throw new Error("Gemini kelime zaman damgası döndürmedi.");
    return { language: "auto", segments: wordsToSegments(all) };
  }
}

export function analysisPrompt(t: Transcript, meta: VideoMeta): string {
  const lines = t.segments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n");
  return `Aşağıda "${meta.title}" videosunun zaman damgalı transkripti var (saniye cinsinden).
Videoyu sabit aralıklarla bölme. Kendi başına anlamlı 5-10 kısa klip seç (tercihen 20-60 sn; cümle ortasında kesme).
Ölçütler: güçlü giriş, şaşırtıcı bilgi, duygusal an, tartışmalı ifade, faydalı bilgi, komik an, hikaye doruğu, merak, güçlü son.
Klip kancadan hemen önce başlasın, sonuçtan sonra bitsin. Başlık/hook/açıklama transkriptin dilinde olsun.
SADECE JSON dizisi döndür:
[{"title":"","start":0,"end":0,"viralScore":0-100,"hook":"","reason":"","description":"","hashtags":["#..."]}]

TRANSKRİPT:
${lines}`;
}

export class GeminiAnalysis implements AIAnalysisProvider {
  private ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  async findClips(t: Transcript, meta: VideoMeta): Promise<ClipPlan[]> {
    const res = await this.ai.models.generateContent({
      model: process.env.GEMINI_ANALYSIS_MODEL || "gemini-3-flash-preview",
      contents: analysisPrompt(t, meta),
      config: { responseMimeType: "application/json" },
    });
    const m = (res.text ?? "").match(/\[[\s\S]*\]/);
    if (!m) throw new Error("Gemini geçerli JSON döndürmedi.");
    return JSON.parse(m[0]) as ClipPlan[];
  }
}
