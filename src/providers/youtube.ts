import path from "node:path";
import { run } from "../services/shell.js";
import type { VideoMeta, VideoSourceProvider } from "./types.js";

const YT = /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]{11}/;

/** yt-dlp tabanlı kaynak. Sadece ALLOW_YT_DOWNLOAD=true iken indirir. */
export class YtDlpSource implements VideoSourceProvider {
  name = "yt-dlp";
  async getMetadata(url: string): Promise<VideoMeta> {
    if (!YT.test(url)) throw new Error("Geçerli bir YouTube URL'si değil.");
    const j = JSON.parse(await run("yt-dlp", ["-J", "--no-playlist", url]));
    return { id: j.id, title: j.title, duration: j.duration, thumbnail: j.thumbnail };
  }
  async download(url: string, destDir: string): Promise<string> {
    if (process.env.ALLOW_YT_DOWNLOAD !== "true")
      throw new Error("YouTube indirme kapalı. İşleme hakkına sahipsen .env içinde ALLOW_YT_DOWNLOAD=true yap.");
    const out = path.join(destDir, "source.mp4");
    await run("yt-dlp", ["--no-playlist", "-f", "bv*[height<=1080]+ba/b[height<=1080]", "--merge-output-format", "mp4", "-o", out, url]);
    return out;
  }
}
