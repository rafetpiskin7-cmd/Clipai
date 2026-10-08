import Anthropic from "@anthropic-ai/sdk";
import { analysisPrompt } from "./gemini.js";
import type { AIAnalysisProvider, ClipPlan, Transcript, VideoMeta } from "./types.js";

export class ClaudeAnalysis implements AIAnalysisProvider {
  private ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  async findClips(t: Transcript, meta: VideoMeta): Promise<ClipPlan[]> {
    const prompt = analysisPrompt(t, meta);
    const res = await this.ai.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.map((c: any) => (c.type === "text" ? c.text : "")).join("");
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error("Yapay zekâ geçerli JSON döndürmedi.");
    return JSON.parse(m[0]) as ClipPlan[];
  }
}
