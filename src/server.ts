import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { WebSocketServer, type WebSocket } from 'ws';
import { ADB, AVD, DATA_DIR, ORIGIN, PORT, ROOT, SDK, SERIAL } from './config.js';
import { ensureCredentials, login, logout, browserSession, ciAuthorized, dailyCiToken, sameOrigin, verifyPassword } from './auth.js';
import { acquire, getLease, release, renew, transfer } from './lease.js';
import { EmulatorBridge } from './emulator.js';
import { capabilityCatalog, DEFAULT_CAPS, installedApps, REQUIRED_CAPS } from './capabilities.js';

ensureCredentials();
const emulator = new EmulatorBridge();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use((_, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"); next(); });

const webDriverSessions = new Set<string>();
async function readBody(req: Request, maxBytes = 150_000_000): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) { const b = Buffer.from(part); size += b.length; if (size > maxBytes) throw new Error('request too large'); parts.push(b); }
  return Buffer.concat(parts);
}
app.use('/webdriver', async (req, res) => {
  if (!ciAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const pathname = new URL(req.originalUrl, 'http://localhost').pathname;
  const isCreate = req.method === 'POST' && pathname === '/webdriver/session';
  const sessionId = pathname.match(/^\/webdriver\/session\/([^/]+)/)?.[1];
  const pendingOwner = isCreate ? crypto.randomUUID() : '';
  if (isCreate && !acquire('appium', pendingOwner)) return res.status(423).json({ error: 'device busy', lease: getLease()?.kind });
  if (sessionId && (!webDriverSessions.has(sessionId) || !renew('appium', sessionId))) return res.status(423).json({ error: 'no active test lease' });
  try {
    let body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    if (isCreate) {
      const json = JSON.parse(body?.toString('utf8') || '{}');
      json.capabilities ||= {}; json.capabilities.alwaysMatch ||= {};
      const caps = json.capabilities.alwaysMatch;
      if (caps['appium:udid'] && caps['appium:udid'] !== 'emulator-5554') throw new Error('only emulator-5554 is allowed');
      Object.assign(caps, REQUIRED_CAPS);
      if (caps['appium:noReset'] === undefined && caps['appium:fullReset'] !== true) caps['appium:noReset'] = DEFAULT_CAPS['appium:noReset'];
      if (caps['appium:newCommandTimeout'] === undefined) caps['appium:newCommandTimeout'] = DEFAULT_CAPS['appium:newCommandTimeout'];
      json.capabilities.firstMatch = [{}];
      body = Buffer.from(JSON.stringify(json));
    }
    const upstream = await fetch(`http://127.0.0.1:4723${req.originalUrl}`, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] || 'application/json' },
      body: body?.toString('utf8'),
      signal: AbortSignal.timeout(300_000)
    });
    const response = Buffer.from(await upstream.arrayBuffer());
    if (isCreate) {
      const id = JSON.parse(response.toString('utf8')).value?.sessionId;
      if (upstream.ok && id) { transfer('appium', pendingOwner, id); webDriverSessions.add(id); }
      else release('appium', pendingOwner);
    }
    if (sessionId && req.method === 'DELETE' && pathname === `/webdriver/session/${sessionId}`) { release('appium', sessionId); webDriverSessions.delete(sessionId); }
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(response);
  } catch (error) {
    if (isCreate) release('appium', pendingOwner);
    res.status(502).json({ error: String(error) });
  }
});

app.use(express.json({ limit: '64kb' }));
function requireBrowser(req: Request, res: Response, next: () => void) {
  if (!browserSession(req)) return res.status(401).json({ error: 'sign in required' });
  next();
}
function requireOrigin(req: Request, res: Response, next: () => void) {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'origin rejected' });
  next();
}
function requireManual(req: Request, res: Response, next: () => void) {
  const id = browserSession(req)?.id;
  if (!id || !renew('manual', id)) return res.status(423).json({ error: 'take control first' });
  next();
}

app.post('/api/login', requireOrigin, (req, res) => {
  if (typeof req.body?.password !== 'string') return res.status(400).json({ error: 'password required' });
  if (!login(req.body.password, res)) return res.status(429).json({ error: 'invalid password or temporarily locked' });
  res.json({ ok: true });
});
app.post('/api/logout', requireOrigin, requireBrowser, (req, res) => {
  const id = browserSession(req)!.id; release('manual', id); logout(req, res); res.json({ ok: true });
});
app.get('/api/status', requireBrowser, (req, res) => res.json({
  avd: AVD, emulator: emulator.connected ? 'online' : emulator.restarting ? 'restarting' : 'offline',
  lease: getLease()?.kind || null, mine: getLease()?.kind === 'manual' && getLease()?.owner === browserSession(req)?.id,
  origin: ORIGIN
}));
app.get('/api/capabilities', requireBrowser, (_req, res) => {
  try { res.json({ required: REQUIRED_CAPS, defaults: DEFAULT_CAPS, ...capabilityCatalog() }); }
  catch (error) { res.status(503).json({ error: String(error) }); }
});
app.post('/api/ci-token', requireOrigin, requireBrowser, (req, res) => {
  if (typeof req.body?.password !== 'string' || !req.body.password || req.body.password.length > 1024) return res.status(400).json({ error: 'password required' });
  if (!verifyPassword(req.body.password)) return res.status(429).json({ error: 'invalid password or temporarily locked' });
  res.json(dailyCiToken());
});
app.get('/api/apps', requireBrowser, async (_req, res) => {
  try { res.json({ apps: await installedApps() }); }
  catch (error) { res.status(503).json({ error: String(error) }); }
});
app.post('/api/lease', requireOrigin, requireBrowser, (req, res) => {
  if (!acquire('manual', browserSession(req)!.id)) return res.status(423).json({ error: 'device busy', lease: getLease()?.kind });
  res.json({ ok: true });
});
app.post('/api/lease/heartbeat', requireOrigin, requireBrowser, (req, res) => {
  if (!renew('manual', browserSession(req)!.id)) return res.status(423).json({ error: 'lease expired' });
  res.json({ ok: true });
});
app.delete('/api/lease', requireOrigin, requireBrowser, (req, res) => { release('manual', browserSession(req)!.id); res.json({ ok: true }); });
app.get('/api/screenshot', requireBrowser, async (_req, res) => {
  try { res.type('png').send(await emulator.screenshot()); } catch (e) { res.status(503).json({ error: String(e) }); }
});
function adb(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ADB, ['-s', SERIAL, ...args], { stdio: 'ignore' });
    p.on('error', reject); p.on('exit', code => code === 0 ? resolve() : reject(new Error(`adb exit ${code}`)));
  });
}
app.post('/api/device-key', requireOrigin, requireBrowser, requireManual, async (req, res) => {
  const allowed = ['HOME', 'BACK', 'POWER', 'VOLUME_UP', 'VOLUME_DOWN'];
  if (!allowed.includes(req.body?.key)) return res.status(400).json({ error: 'invalid key' });
  try { await adb(['shell', 'input', 'keyevent', `KEYCODE_${req.body.key}`]); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ error: String(e) }); }
});
app.post('/api/rotate', requireOrigin, requireBrowser, requireManual, async (req, res) => {
  if (!Number.isInteger(req.body?.rotation) || req.body.rotation < 0 || req.body.rotation > 3) return res.status(400).json({ error: 'rotation must be 0-3' });
  try {
    await adb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
    await adb(['shell', 'settings', 'put', 'system', 'user_rotation', String(req.body.rotation)]);
    res.json({ ok: true });
  } catch (e) { res.status(503).json({ error: String(e) }); }
});

const mediaDir = path.join(DATA_DIR, 'camera');
fs.mkdirSync(mediaDir, { recursive: true });
const upload = multer({ dest: mediaDir, limits: { fileSize: 250 * 1024 * 1024, files: 1 } });
function findFfmpeg(): string | null {
  if (process.env.FFMPEG_EXE && fs.existsSync(process.env.FFMPEG_EXE)) return process.env.FFMPEG_EXE;
  const packages = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  const folder = fs.existsSync(packages) ? fs.readdirSync(packages).find(x => x.startsWith('Gyan.FFmpeg_')) : undefined;
  if (!folder) return null;
  const root = path.join(packages, folder);
  for (const sub of fs.readdirSync(root)) { const exe = path.join(root, sub, 'bin', 'ffmpeg.exe'); if (fs.existsSync(exe)) return exe; }
  return null;
}
function ffmpeg(input: string, output: string) {
  return new Promise<void>((resolve, reject) => {
    const exe = findFfmpeg(); if (!exe) return reject(new Error('FFmpeg not installed'));
    const p = spawn(exe, ['-y', '-i', input, '-t', '300', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', output], { stdio: 'ignore' });
    p.on('error', reject); p.on('exit', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`)));
  });
}
app.post('/api/camera', requireOrigin, requireBrowser, requireManual, upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file required' });
  const magic = Buffer.alloc(16); const fd = fs.openSync(file.path, 'r'); fs.readSync(fd, magic, 0, 16, 0); fs.closeSync(fd);
  const image = magic.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || (magic[0] === 0xff && magic[1] === 0xd8);
  const video = file.mimetype.startsWith('video/') || magic.subarray(4, 8).toString('ascii') === 'ftyp' || magic.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'));
  if (!image && !video) { fs.unlinkSync(file.path); return res.status(415).json({ error: 'PNG, JPEG, or video required' }); }
  const output = path.join(mediaDir, image ? 'rear-camera.jpg' : 'rear-camera.mp4');
  try {
    if (image) await sharp(file.path).rotate().resize(1280, 720, { fit: 'contain', background: '#000000' }).jpeg({ quality: 90 }).toFile(output);
    else await ffmpeg(file.path, output);
    fs.unlinkSync(file.path);
    fs.writeFileSync(path.join(DATA_DIR, 'camera-source.json'), JSON.stringify({ file: output }));
    await emulator.restartWithCamera(output);
    res.json({ ok: true, rebooting: true, source: image ? 'image' : 'video' });
  } catch (error) { try { fs.unlinkSync(file.path); } catch {} res.status(500).json({ error: String(error) }); }
});
app.post('/api/camera/reset', requireOrigin, requireBrowser, requireManual, async (_req, res) => {
  try {
    fs.rmSync(path.join(DATA_DIR, 'camera-source.json'), { force: true });
    await emulator.restartWithCamera();
    res.json({ ok: true, rebooting: true });
  } catch (error) { res.status(500).json({ error: String(error) }); }
});

app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: 0 }));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url?.split('?')[0] !== '/ws/device' || ![ORIGIN, 'http://127.0.0.1:8765', 'http://localhost:8765'].includes(req.headers.origin || '')) return socket.destroy();
  const fake = req as Request;
  if (!browserSession(fake)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, fake));
});
wss.on('connection', (ws: WebSocket, req: Request) => {
  const id = browserSession(req)?.id;
  if (!id) return ws.close();
  emulator.addViewer(ws);
  const authCheck = setInterval(() => { if (!browserSession(req)) ws.close(1008, 'session expired'); }, 2500);
  let inputQueue = Promise.resolve();
  ws.on('message', raw => {
    try {
      if (!browserSession(req)) return ws.close(1008, 'session expired');
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'frame-ack') { emulator.frameDisplayed(ws); return; }
      if (msg.type === 'audio') { emulator.setAudio(ws, msg.enabled === true); return; }
      inputQueue = inputQueue.then(async () => {
        if (!browserSession(req) || !renew('manual', id)) return;
        if (msg.type === 'touch' && Number.isFinite(msg.x) && Number.isFinite(msg.y)) await emulator.touch(Math.max(0, Math.min(1, msg.x)), Math.max(0, Math.min(1, msg.y)), msg.down ? 100 : 0);
        if (msg.type === 'key' && typeof msg.key === 'string' && msg.key.length < 32) await emulator.key(msg.key);
        if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.length <= 2000) await emulator.text(msg.text);
        if (msg.type === 'fingerprint' && Number.isInteger(msg.id) && msg.id >= 0 && msg.id <= 9999) await emulator.fingerprint(msg.id, Boolean(msg.down));
      }).catch(error => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: String(error) })); });
    } catch (e) { ws.send(JSON.stringify({ type: 'error', message: String(e) })); }
  });
  ws.on('close', () => { clearInterval(authCheck); emulator.removeViewer(ws); });
});
server.listen(PORT, '127.0.0.1', () => console.log(`Gateway listening at http://127.0.0.1:${PORT}`));
