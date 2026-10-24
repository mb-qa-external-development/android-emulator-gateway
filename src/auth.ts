import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { DATA_DIR, ORIGIN } from './config.js';

type Stored = { salt: string; passwordHash: string; ciSeed: string; ciTokenHash?: string };
type Session = { id: string; expires: number; authHash: string };
const statePath = path.join(DATA_DIR, 'state.json');
const oldTokenPath = path.join(DATA_DIR, 'initial-ci-token.txt');
const sessions = new Map<string, Session>();
const failures: number[] = [];

function hashPassword(password: string, salt: string) {
  return crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
}
function save(state: Stored) { fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 }); }
function state(): Stored { return JSON.parse(fs.readFileSync(statePath, 'utf8')) as Stored; }

function bangkokDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const field = (name: string) => parts.find(part => part.type === name)!.value;
  return `${field('year')}-${field('month')}-${field('day')}`;
}
export function dailyCiToken(now = new Date()): { token: string; date: string; expiresAt: string } {
  const date = bangkokDate(now);
  const s = state();
  const token = `gwci_${date.replaceAll('-', '')}_${crypto.createHmac('sha256', Buffer.from(s.ciSeed, 'hex')).update(`android-gateway-ci:${date}`).digest('base64url')}`;
  const [year, month, day] = date.split('-').map(Number);
  const expiresAt = new Date(Date.UTC(year, month - 1, day + 1) - 7 * 60 * 60_000).toISOString();
  return { token, date, expiresAt };
}

export function ensureCredentials() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(statePath)) {
    const current = state();
    if (!current.ciSeed) {
      current.ciSeed = crypto.randomBytes(32).toString('hex');
      delete current.ciTokenHash;
      save(current);
    }
    fs.rmSync(oldTokenPath, { force: true });
    return;
  }
  const password = crypto.randomBytes(24).toString('base64url');
  const salt = crypto.randomBytes(24).toString('hex');
  save({ salt, passwordHash: hashPassword(password, salt), ciSeed: crypto.randomBytes(32).toString('hex') });
  fs.writeFileSync(path.join(DATA_DIR, 'initial-password.txt'), password + '\n', { mode: 0o600 });
  console.log(`Initial credentials saved in ${DATA_DIR}`);
}

export function rotatePassword() {
  ensureCredentials();
  const password = crypto.randomBytes(24).toString('base64url');
  const salt = crypto.randomBytes(24).toString('hex');
  const s = state(); s.salt = salt; s.passwordHash = hashPassword(password, salt); s.ciSeed = crypto.randomBytes(32).toString('hex'); save(s);
  sessions.clear();
  fs.writeFileSync(path.join(DATA_DIR, 'initial-password.txt'), password + '\n', { mode: 0o600 });
  return password;
}
export function rotateCiToken() {
  ensureCredentials();
  const s = state(); s.ciSeed = crypto.randomBytes(32).toString('hex'); save(s);
  return dailyCiToken().token;
}

export function sameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === ORIGIN || origin === `http://127.0.0.1:8765` || origin === `http://localhost:8765`;
}
export function verifyPassword(password: string): boolean {
  const now = Date.now();
  while (failures.length && failures[0] < now - 15 * 60_000) failures.shift();
  if (failures.length >= 5) return false;
  const s = state();
  const actual = Buffer.from(hashPassword(password, s.salt), 'hex');
  const expected = Buffer.from(s.passwordHash, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    failures.push(now); return false;
  }
  failures.length = 0;
  return true;
}
export function login(password: string, res: Response): boolean {
  if (!verifyPassword(password)) return false;
  const now = Date.now();
  const s = state();
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, { id, expires: now + 8 * 60 * 60_000, authHash: s.passwordHash });
  res.setHeader('Set-Cookie', `gw_session=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`);
  return true;
}
export function browserSession(req: Request): Session | undefined {
  const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('gw_session='));
  const id = cookie?.slice('gw_session='.length);
  const s = id ? sessions.get(id) : undefined;
  if (!s || s.expires <= Date.now() || s.authHash !== state().passwordHash) { if (id) sessions.delete(id); return undefined; }
  return s;
}
export function logout(req: Request, res: Response) {
  const id = browserSession(req)?.id;
  if (id) sessions.delete(id);
  res.setHeader('Set-Cookie', 'gw_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
}
export function ciAuthorized(req: Request): boolean {
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) return false;
  const actual = Buffer.from(token);
  const expected = Buffer.from(dailyCiToken().token);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
