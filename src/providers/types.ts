export interface VideoMeta { id: string; title: string; duration: number; thumbnail: string }
export interface Word { text: string; start: number; end: number }
export interface Segment { text: string; start: number; end: number; words: Word[] }
export interface Transcript { language: string; segments: Segment[] }
export interface ClipPlan {
  title: string; start: number; end: number; viralScore: number;
  hook: string; reason: string; description: string; hashtags: string[];
}
export type StyleName = "bold" | "minimal" | "viral" | "clean" | "cinematic";
export interface CaptionStyle {
  name: StyleName; font?: string; color?: string; size?: number;
  position?: "bottom" | "center" | "top"; enabled?: boolean;
}

/** YouTube/indirme katmanı burada izole: başka kaynakla değiştirilebilir. */
export interface VideoSourceProvider {
  name: string;
  getMetadata(url: string): Promise<VideoMeta>;
  download(url: string, destDir: string): Promise<string>;
}
export interface TranscriptionProvider { transcribe(audioPath: string): Promise<Transcript> }
export interface AIAnalysisProvider { findClips(t: Transcript, meta: VideoMeta): Promise<ClipPlan[]> }
export interface CropStrategy {
  /** ffmpeg -vf parçası (9:16 kırpma). Yüz/konuşmacı takibi buraya takılır. */
  filter(srcW: number, srcH: number, start: number, end: number): string;
}
export interface CaptionRenderer { toAss(words: Word[], style: CaptionStyle): string }
export interface StorageProvider { dir(jobId: string): Promise<string>; url(jobId: string, file: string): string }
