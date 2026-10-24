import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import sharp from 'sharp';
import type WebSocket from 'ws';
import { AVD, DATA_DIR, EMULATOR, SDK } from './config.js';

type Discovery = { port: number; token: string; file: string };
const protoFile = path.join(SDK, 'emulator', 'lib', 'emulator_controller.proto');
const definition = protoLoader.loadSync(protoFile, { includeDirs: [path.dirname(protoFile)], enums: String, longs: String, defaults: true, oneofs: true });
const packageObject = grpc.loadPackageDefinition(definition) as any;
const Controller = packageObject.android.emulation.control.EmulatorController;

function discover(): Discovery | null {
  const folder = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'avd', 'running');
  if (!fs.existsSync(folder)) return null;
  for (const name of fs.readdirSync(folder).filter(x => /^pid_.*\.ini$/.test(x))) {
    const file = path.join(folder, name);
    const fields = Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(x => x.includes('=')).map(x => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
    if (fields['avd.name'] === AVD && fields['grpc.port'] && fields['grpc.token']) return { port: Number(fields['grpc.port']), token: fields['grpc.token'], file };
  }
  return null;
}

export class EmulatorBridge {
  private client: any = null;
  private identity = '';
  private metadata = new grpc.Metadata();
  private screenStream: any = null;
  private audioStream: any = null;
  private notificationStream: any = null;
  private clients = new Set<WebSocket>();
  private frameReady = new Map<WebSocket, boolean>();
  private audioClients = new Set<WebSocket>();
  private encoding = false;
  private pendingFrame: any = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private lastFrame = 0;
  private frameId = 0;
  private sentFrame = new Map<WebSocket, number>();
  private loggedFrame = false;
  private lastImage: Buffer | null = null;
  width = 1080;
  height = 2424;
  connected = false;
  restarting = false;
  textFocused = false;

  constructor() { setInterval(() => this.reconnect(), 2500).unref(); this.reconnect(); }
  private reconnect() {
    if (this.restarting) return;
    const d = discover();
    if (!d && !this.identity) console.error('emulator discovery: no running AVD found');
    const identity = d ? `${d.file}:${d.port}:${d.token}` : '';
    if (identity === this.identity && this.connected) {
      if (this.clients.size && !this.notificationStream) this.startNotifications();
      return;
    }
    this.screenStream?.cancel(); this.audioStream?.cancel(); this.notificationStream?.cancel(); this.client?.close();
    this.screenStream = null; this.audioStream = null; this.notificationStream = null; this.lastImage = null; this.pendingFrame = null;
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;
    this.client = null; this.connected = false; this.identity = identity; this.textFocused = false;
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'text-focus', focused: false }));
    if (!d) return;
    this.metadata = new grpc.Metadata();
    this.metadata.set('authorization', `Bearer ${d.token}`);
    this.client = new Controller(`127.0.0.1:${d.port}`, grpc.credentials.createInsecure(), { 'grpc.max_receive_message_length': 32 * 1024 * 1024 });
    this.client.getStatus({}, this.metadata, { deadline: Date.now() + 5000 }, (error: Error | null) => {
      if (error || identity !== this.identity) { if (error) console.error('emulator gRPC status:', error.message); this.connected = false; return; }
      this.connected = true;
      if (this.clients.size) { this.startScreen(); this.startNotifications(); }
      if (this.audioClients.size) this.startAudio();
    });
  }
  private startNotifications() {
    if (this.notificationStream || !this.client) return;
    const stream = this.client.streamNotification({}, this.metadata);
    this.notificationStream = stream;
    stream.on('data', (notification: any) => {
      if (!notification.textViewFocus) return;
      this.textFocused = Boolean(notification.textViewFocus.textViewHasFocus);
      const message = JSON.stringify({ type: 'text-focus', focused: this.textFocused });
      for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(message);
    });
    stream.on('error', () => { if (this.notificationStream === stream) this.notificationStream = null; });
    stream.on('end', () => { if (this.notificationStream === stream) this.notificationStream = null; });
  }
  private flushFrame() {
    if (!this.pendingFrame || this.encoding || ![...this.clients].some(ws => this.frameReady.get(ws) && ws.readyState === ws.OPEN && ws.bufferedAmount < 64_000)) return;
    const delay = 50 - (Date.now() - this.lastFrame);
    if (delay > 0) {
      if (!this.frameTimer) this.frameTimer = setTimeout(() => { this.frameTimer = null; this.flushFrame(); }, delay);
      return;
    }
    const frame = this.pendingFrame;
    this.pendingFrame = null;
    const width = Number(frame.format?.width || frame.width);
    const height = Number(frame.format?.height || frame.height);
    if (!width || !height || frame.image.length !== width * height * 3) return;
    this.encoding = true; this.lastFrame = Date.now();
    void (async () => {
      try {
        const jpeg = await sharp(frame.image, { raw: { width, height, channels: 3 } }).jpeg({ quality: 60 }).toBuffer();
        this.lastImage = jpeg;
        this.frameId++;
        for (const ws of this.clients) this.sendFrame(ws);
        const rotation = Number(frame.format?.rotation?.rotation || 0);
        this.width = rotation % 2 ? 2424 : 1080;
        this.height = rotation % 2 ? 1080 : 2424;
      } catch (error) { console.error('frame encoding:', error); }
      finally { this.encoding = false; this.flushFrame(); }
    })();
  }
  private startScreen() {
    this.screenStream = this.client.streamScreenshot({ format: 'RGB888', width: 540 }, this.metadata);
    this.screenStream.on('data', (frame: any) => {
      if (!this.loggedFrame) { console.log('first frame', { width: frame.format?.width, height: frame.format?.height, bytes: frame.image?.length, format: frame.format?.format }); this.loggedFrame = true; }
      if (this.clients.size === 0 || !frame.image?.length) return;
      this.pendingFrame = frame;
      this.flushFrame();
    });
    this.screenStream.on('error', (error: Error) => { if (this.clients.size) { console.error('screen stream:', error.message); this.connected = false; } });
    this.screenStream.on('end', () => { if (this.clients.size) this.connected = false; });
  }
  private startAudio() {
    if (this.audioStream) return;
    this.audioStream = this.client.streamAudio({ samplingRate: '44100', channels: 'Stereo', format: 'AUD_FMT_S16' }, this.metadata);
    this.audioStream.on('data', (packet: any) => {
      if (!packet.audio?.length) return;
      const data = Buffer.concat([Buffer.from([2]), packet.audio]);
      for (const ws of this.audioClients) if (ws.readyState === ws.OPEN && ws.bufferedAmount < 64_000) ws.send(data);
    });
    this.audioStream.on('error', () => { this.audioStream = null; });
  }
  private sendFrame(ws: WebSocket) {
    if (!this.lastImage || !this.frameReady.get(ws) || this.sentFrame.get(ws) === this.frameId || ws.readyState !== ws.OPEN || ws.bufferedAmount > 64_000) return;
    this.frameReady.set(ws, false);
    this.sentFrame.set(ws, this.frameId);
    ws.send(Buffer.concat([Buffer.from([1]), this.lastImage]));
  }
  frameDisplayed(ws: WebSocket) { this.frameReady.set(ws, true); if (this.pendingFrame) this.flushFrame(); else this.sendFrame(ws); }
  setAudio(ws: WebSocket, enabled: boolean) {
    if (enabled) {
      this.audioClients.add(ws);
      if (this.connected && !this.audioStream) this.startAudio();
    } else {
      this.audioClients.delete(ws);
      if (!this.audioClients.size) { this.audioStream?.cancel(); this.audioStream = null; }
    }
  }
  addViewer(ws: WebSocket) {
    this.clients.add(ws);
    this.frameReady.set(ws, true);
    if (this.connected && !this.screenStream) this.startScreen();
    if (this.connected && !this.notificationStream) this.startNotifications();
    ws.send(JSON.stringify({ type: 'text-focus', focused: this.textFocused }));
    if (this.lastImage) this.sendFrame(ws);
    else this.screenshot().then(async png => {
      if (ws.readyState !== ws.OPEN) return;
      const jpeg = await sharp(png).resize({ width: 540, withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
      this.lastImage = jpeg;
      this.frameId++;
      this.sendFrame(ws);
    }).catch(() => {});
  }
  removeViewer(ws: WebSocket) {
    this.clients.delete(ws);
    this.frameReady.delete(ws);
    this.sentFrame.delete(ws);
    this.setAudio(ws, false);
    if (!this.clients.size) { this.screenStream?.cancel(); this.audioStream?.cancel(); this.notificationStream?.cancel(); this.screenStream = null; this.audioStream = null; this.notificationStream = null; this.pendingFrame = null; if (this.frameTimer) clearTimeout(this.frameTimer); this.frameTimer = null; }
  }
  private call(name: string, request: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.client) return reject(new Error('emulator offline'));
      this.client[name](request, this.metadata, { deadline: Date.now() + 10000 }, (error: Error | null, reply: any) => error ? reject(error) : resolve(reply));
    });
  }
  async screenshot(): Promise<Buffer> { const reply = await this.call('getScreenshot', { format: 'PNG' }); return Buffer.from(reply.image); }
  async touch(x: number, y: number, pressure: number) {
    return this.call('sendTouch', { touches: [{ x: Math.round(x * this.width), y: Math.round(y * this.height), identifier: 0, pressure }] });
  }
  async key(key: string) { return this.call('sendKey', { key }); }
  async text(value: string) { return this.call('sendKey', { text: value }); }
  async fingerprint(id: number, touching: boolean) { return this.call('sendFingerprint', { touchId: id, isTouching: touching }); }
  async restartWithCamera(cameraFile?: string) {
    this.restarting = true; this.connected = false;
    const restartMarker = path.join(DATA_DIR, 'camera-restart.lock');
    fs.writeFileSync(restartMarker, String(Date.now()));
    try {
      const old = discover();
      if (old) {
        const { execFileSync } = await import('node:child_process');
        try { execFileSync(path.join(SDK, 'platform-tools', 'adb.exe'), ['-s', 'emulator-5554', 'emu', 'kill'], { timeout: 10000 }); } catch { /* process may already be gone */ }
        for (let i = 0; i < 25 && discover(); i++) await new Promise(r => setTimeout(r, 400));
        if (discover()) {
          const pid = Number(path.basename(old.file).match(/^pid_(\d+)\.ini$/)?.[1]);
          if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        }
      }
      const args = ['-avd', AVD, '-gpu', 'host', '-no-window', '-no-snapshot-load'];
      if (cameraFile) args.push('-camera-back', `${/\.(png|jpe?g)$/i.test(cameraFile) ? 'imagefile' : 'videofile'}:${cameraFile}`);
      const child = spawn(EMULATOR, args, { detached: true, stdio: 'ignore' });
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      await new Promise(resolve => setTimeout(resolve, 1000));
    } finally {
      fs.rmSync(restartMarker, { force: true });
      this.restarting = false;
      this.identity = '';
      this.reconnect();
    }
  }
}
