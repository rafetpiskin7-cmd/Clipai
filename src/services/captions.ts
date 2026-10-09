import type { CaptionRenderer, CaptionStyle, Word } from "../providers/types.js";

const bgr = (hex: string) => { const h = hex.replace("#", ""); return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`; };
const ts = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
const PRESET: Record<string, { font: string; size: number; color: string; outline: number; upper: boolean; italic: number }> = {
  bold: { font: "Arial", size: 84, color: "#FFE23A", outline: 6, upper: false, italic: 0 },
  minimal: { font: "Arial", size: 60, color: "#FFFFFF", outline: 2, upper: false, italic: 0 },
  viral: { font: "Impact", size: 96, color: "#FFE23A", outline: 7, upper: true, italic: 0 },
  clean: { font: "Arial", size: 70, color: "#6D9BFF", outline: 3, upper: false, italic: 0 },
  cinematic: { font: "Georgia", size: 68, color: "#FFFFFF", outline: 2, upper: false, italic: 1 },
};
const ALIGN = { bottom: 2, center: 5, top: 8 } as const;

export class AssCaptionRenderer implements CaptionRenderer {
  /** words: klip başlangıcına göre göreli saniyeler. Konuşulan kelime vurgulanır. */
  toAss(words: Word[], style: CaptionStyle, labels: { start: number; end: number; text: string }[] = []): string {
    const p = PRESET[style.name] ?? PRESET.bold;
    const font = style.font ?? p.font, size = style.size ?? p.size, color = style.color ?? p.color;
    const al = ALIGN[style.position ?? "bottom"];
    let ev = "";
    for (let i = 0; i < words.length; i += 3) {
      const chunk = words.slice(i, i + 3);
      chunk.forEach((w, k) => {
        const end = k < chunk.length - 1 ? chunk[k + 1].start : w.end;
        const txt = chunk.map((c, j) => {
          const t = (p.upper ? c.text.toUpperCase() : c.text).trim();
          return j === k ? `{\\c${bgr(color)}}${t}{\\c&H00FFFFFF&}` : t;
        }).join(" ");
        ev += `Dialogue: 0,${ts(w.start)},${ts(end)},D,,0,0,0,,${txt}\n`;
      });
    }
    for (const l of labels) ev += `Dialogue: 1,${ts(l.start)},${ts(l.end)},N,,0,0,0,,#${l.text.replace(/^#/, "").replace(/[{}\\]/g, "")}\n`;
    return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: D,${font},${size},&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H80000000&,1,${p.italic},0,0,100,100,0,0,1,${p.outline},1,${al},60,60,220,1
Style: N,Impact,150,&H0000E5FF&,&H0000E5FF&,&H00000000&,&H80000000&,1,0,0,0,100,100,0,0,1,8,2,7,60,60,150,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
${ev}`;
  }
}
