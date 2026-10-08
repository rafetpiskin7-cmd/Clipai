# ShortifyAI

YouTube URL → transkript → yapay zekâ klip seçimi → 9:16 kırpma → yakılmış altyazı → MP4.

## Gereksinimler
- Node.js 20+
- `ffmpeg` ve `ffprobe` (PATH'te)
- `yt-dlp` (PATH'te)
- API anahtarı: `GEMINI_API_KEY` (transkript + klip analizi). `ANTHROPIC_API_KEY` sadece `AI_PROVIDER=claude` ise gerekir.

## Kurulum
```
npm install
cp .env.example .env     # anahtarları doldur
npm run dev              # http://localhost:3000
```
Üretim: `npm run build && npm start`

## Mimari (her aşama ayrı servis / sağlayıcı)
- `providers/youtube.ts` VideoSourceProvider: sadece burası YouTube'a dokunur. Başka kaynakla değiştirilebilir.
- `providers/gemini.ts` TranscriptionProvider (gemini-3.5-transcribe, kelime zaman damgalı) + AIAnalysisProvider
- `providers/claude.ts` alternatif AIAnalysisProvider (`AI_PROVIDER=claude`)
- `services/clipper.ts` VideoProcessor + CropStrategy (varsayılan: ortadan kırpma; yüz/konuşmacı takibi buraya takılır)
- `services/captions.ts` CaptionRenderer (ASS, kelime vurgulu, 5 stil)
- `pipeline.ts` aşamaları sırayla çalıştırır, `server.ts` HTTP API + statik arayüz

## Gerçek / harici
- Gerçek: FFmpeg kesme, 9:16 kırpma, altyazı yakma (test edildi), API, ilerleme, yeniden işleme (editör).
- Harici: yt-dlp (YouTube indirme), Gemini (transkript ve analiz).

## Bilinen sınırlamalar
- YouTube indirme varsayılan KAPALI (`ALLOW_YT_DOWNLOAD=true`). Sadece işleme hakkın olan videolar için aç; YouTube bazı sunucu IP'lerini engelleyebilir.
- Ses 20 dakikalık parçalara bölünüp ayrı ayrı transkribe edilir (kelime zaman damgası limiti 30 dk). Parça sınırında bir kelime bölünebilir.
- Gemini'de kelime zaman damgası açıkken doğruluk biraz düşebilir; model adları env'den değiştirilebilir (`GEMINI_*_MODEL`). Gerçek anahtarla denenmedi.
- Kırpma şu an ortadan; aktif konuşmacı takibi yok.
- İşler bellekte tutulur; sunucu yeniden başlarsa proje listesi kaybolur (dosyalar `data/` içinde kalır). Kimlik doğrulama, kuyruk ve veritabanı yok.
- Editörde stil değişiklikleri "Kaydet" ile klibi yeniden işler; canlı altyazı önizlemesi yok.
- Kontrol paneli ekranı örnek veridir.

## Canlıya alma (Docker)
`Dockerfile` ffmpeg + yt-dlp ile hazır. Railway/Render/Fly gibi Docker çalıştıran bir hosta GitHub reposunu bağla,
ortam değişkenlerini (`GEMINI_API_KEY`, `AI_PROVIDER`, `ALLOW_YT_DOWNLOAD`, ...) host panelinden gir. `.env` dosyasını yükleme.
Notlar: host disk'i geçici olabilir (üretilen klipler yeniden dağıtımda silinir); bulut IP'lerinden YouTube indirme
engellenebilir; Impact/Georgia fontları konteynerde yok, altyazı yedek fonta düşer.
