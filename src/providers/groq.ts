import fs from "node:fs/promises";
import path from "node:path";
import { run } from "../services/shell.js";
import { withRetry, wordsToSegments } from "./gemini.js";
import type { Transcript, TranscriptionProvider, Word } from "./types.js";

const CHUNK_SEC = 1200; // 20 dk'lık parçalar: 32 kbps mp3 ≈ 5 MB, Groq ücretsiz dosya sınırı (25 MB) altında

/** Groq üzerinde barındırılan Whisper. Kelime zaman damgası verir, OpenAI hesabı gerekmez. */
export class GroqTranscription implements TranscriptionProvider {
  constructor(private key: string) {}

  private async call(file: string): Promise<any> {
    const base = process.env.GROQ_BASE_URL || "https://api.groq.com";
    const form = new FormData();
    form.append("file", new Blob([await fs.readFile(file)], { type: "audio/mpeg" }), "audio.mp3");
    form.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
    const r = await fetch(`${base}/openai/v1/audio/transcriptions`, {
      method: "POST", headers: { Authorization: `Bearer ${this.key}` }, body: form,
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Groq ${r.status}: ${j?.error?.message ?? JSON.stringify(j).slice(0, 200)}`);
    return j;
  }

  async transcribe(audioPath: string): Promise<Transcript> {
    const dir = path.dirname(audioPath);
    await run("ffmpeg", ["-y", "-i", audioPath, "-f", "segment", "-segment_time", String(CHUNK_SEC), "-c", "copy", path.join(dir, "gchunk%03d.mp3")]);
    const chunks = (await fs.readdir(dir)).filter(f => /^gchunk\d+\.mp3$/.test(f)).sort();
    const all: Word[] = [];
    let language = "auto";
    for (let i = 0; i < chunks.length; i++) {
      const j = await withRetry(() => this.call(path.join(dir, chunks[i])));
      language = j.language ?? language;
      for (const w of j.words ?? [])
        if (w?.word) all.push({ text: String(w.word).trim(), start: i * CHUNK_SEC + Number(w.start), end: i * CHUNK_SEC + Number(w.end) });
    }
    if (!all.length) throw new Error("Groq kelime zaman damgası döndürmedi.");
    return { language, segments: wordsToSegments(all) };
  }
}
