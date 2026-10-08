import { run } from "../services/shell.js";
import type { VideoMeta, VideoSourceProvider } from "./types.js";

/** Kullanıcının yüklediği dosya: YouTube'a hiç dokunmaz. */
export class LocalFileSource implements VideoSourceProvider {
  name = "local";
  constructor(private file: string, private title: string) {}
  async getMetadata(): Promise<VideoMeta> {
    const o = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", this.file]);
    const duration = parseFloat(o);
    if (!duration) throw new Error("Dosya geçerli bir video değil.");
    return { id: "local", title: this.title, duration, thumbnail: "" };
  }
  async download(): Promise<string> { return this.file; }
}
