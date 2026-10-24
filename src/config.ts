import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
const WORK = path.resolve(ROOT, '..', '..', 'work');
export const DATA_DIR = process.env.GATEWAY_DATA_DIR || path.join(WORK, 'gateway-data');
export const SDK = process.env.ANDROID_HOME || path.join(WORK, 'android-sdk');
export const AVD = 'Pixel_10_Android_17';
export const SERIAL = 'emulator-5554';
export const ORIGIN = process.env.GATEWAY_ORIGIN || 'http://localhost:8765';
export const PORT = 8765;
export const APPIUM_PORT = 4723;
export const ADB = path.join(SDK, 'platform-tools', 'adb.exe');
export const EMULATOR = path.join(SDK, 'emulator', 'emulator.exe');
