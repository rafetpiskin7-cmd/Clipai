import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Express, Request, Response } from "express";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: string, len: number) => Promise<Buffer>;
interface User { id: string; name: string; email: string; salt: string; hash: string; created: number }

/** E-posta + şifre hesapları. Şifre scrypt ile hash'lenir, oturum imzalı HttpOnly çerezdir.
 *  Kullanıcılar DATA_DIR/users.json içinde tutulur (Render ücretsiz planda disk kalıcı değildir). */
export function setupAuth(app: Express, dataDir: string) {
  const file = path.join(dataDir, "users.json");
  const users = new Map<string, User>();
  const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
  const loaded = fs.readFile(file, "utf8").then(t => { for (const u of JSON.parse(t) as User[]) users.set(u.email, u); }).catch(() => {});
  const save = async () => { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(file, JSON.stringify([...users.values()])); };
  const sign = (v: string) => crypto.createHmac("sha256", secret).update(v).digest("base64url");
  const token = (u: User) => { const p = Buffer.from(JSON.stringify({ id: u.id, exp: Date.now() + 30 * 864e5 })).toString("base64url"); return `${p}.${sign(p)}`; };
  const current = (req: Request): User | null => {
    const m = /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie || "");
    if (!m) return null;
    const [p, s] = m[1].split(".");
    if (!p || !s) return null;
    const good = sign(p);
    if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
    try {
      const o = JSON.parse(Buffer.from(p, "base64url").toString());
      if (o.exp < Date.now()) return null;
      return [...users.values()].find(u => u.id === o.id) ?? null;
    } catch { return null; }
  };
  const cookie = (req: Request, res: Response, v: string, age: number) =>
    res.setHeader("Set-Cookie", `sid=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
  const pub = (u: User) => ({ name: u.name, email: u.email });
  const hits = new Map<string, { n: number; t: number }>();
  const limited = (req: Request) => {
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const h = hits.get(ip); const now = Date.now();
    if (!h || now - h.t > 10 * 60_000) { hits.set(ip, { n: 1, t: now }); return false; }
    return ++h.n > 15;
  };

  app.post("/api/auth/signup", async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: "Çok fazla deneme. Biraz sonra tekrar dene." });
    await loaded;
    const name = String(req.body?.name ?? "").trim().slice(0, 60);
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const pw = String(req.body?.password ?? "");
    if (!name) return res.status(400).json({ error: "Adını yaz." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return res.status(400).json({ error: "Geçerli bir e-posta yaz." });
    if (pw.length < 8 || pw.length > 200) return res.status(400).json({ error: "Şifre en az 8 karakter olmalı." });
    if (users.has(email)) return res.status(409).json({ error: "Bu e-posta zaten kayıtlı. Giriş yapmayı dene." });
    const salt = crypto.randomBytes(16).toString("hex");
    const u: User = { id: crypto.randomUUID(), name, email, salt, hash: (await scrypt(pw, salt, 64)).toString("hex"), created: Date.now() };
    users.set(email, u); await save();
    cookie(req, res, token(u), 30 * 86400);
    res.status(201).json({ user: pub(u) });
  });

  app.post("/api/auth/login", async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: "Çok fazla deneme. Biraz sonra tekrar dene." });
    await loaded;
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const pw = String(req.body?.password ?? "").slice(0, 200);
    const u = users.get(email);
    const calc = (await scrypt(pw, u?.salt ?? "0".repeat(32), 64)).toString("hex"); // kullanıcı yokken de aynı iş: zamanlama farkı olmasın
    if (!u || calc !== u.hash) return res.status(401).json({ error: "E-posta veya şifre hatalı." });
    cookie(req, res, token(u), 30 * 86400);
    res.json({ user: pub(u) });
  });

  app.post("/api/auth/logout", (req, res) => { cookie(req, res, "", 0); res.json({ ok: true }); });
  app.get("/api/auth/me", async (req, res) => { await loaded; const u = current(req); res.json({ user: u ? pub(u) : null }); });
}
