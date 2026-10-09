import { spawn } from "node:child_process";

export function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const low = cmd === "ffmpeg" && process.platform === "linux"; // ffmpeg düşük öncelikli: sunucu istek cevaplamaya devam etsin
    const p = low ? spawn("nice", ["-n", "10", cmd, ...args], { cwd }) : spawn(cmd, args, { cwd });
    let out = "", err = "";
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", d => (err += d));
    p.on("error", e => reject(new Error(`${cmd} çalıştırılamadı (kurulu mu?): ${e.message}`)));
    p.on("close", code => code === 0 ? resolve(out) : reject(new Error(`${cmd} hata ${code}: ${err.slice(-600)}`)));
  });
}
