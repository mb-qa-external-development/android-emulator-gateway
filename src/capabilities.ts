import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ADB, DATA_DIR, SERIAL } from './config.js';

const execFileAsync = promisify(execFile);
const driverDir = path.join(DATA_DIR, 'appium', 'node_modules', 'appium-uiautomator2-driver');

export const REQUIRED_CAPS = {
  platformName: 'Android',
  'appium:automationName': 'UiAutomator2',
  'appium:udid': SERIAL,
} as const;
export const DEFAULT_CAPS = {
  'appium:noReset': true,
  'appium:newCommandTimeout': 300,
} as const;

export type InstalledApp = { packageName: string; activity: string; label: string };
export type CapabilityEntry = { name: string; description: string; category: string };

const knownLabels: Record<string, string> = {
  'com.android.camera2': 'Camera',
  'com.android.chrome': 'Chrome',
  'com.android.settings': 'Settings',
  'com.android.vending': 'Play Store',
  'com.google.android.apps.docs': 'Drive',
  'com.google.android.apps.maps': 'Maps',
  'com.google.android.apps.messaging': 'Messages',
  'com.google.android.apps.photos': 'Photos',
  'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.google.android.calendar': 'Calendar',
  'com.google.android.contacts': 'Contacts',
  'com.google.android.deskclock': 'Clock',
  'com.google.android.dialer': 'Phone',
  'com.google.android.gm': 'Gmail',
  'com.google.android.youtube': 'YouTube',
};

export async function installedApps(): Promise<InstalledApp[]> {
  const { stdout } = await execFileAsync(ADB, [
    '-s', SERIAL, 'shell', 'cmd', 'package', 'query-activities', '--brief', '--components',
    '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER'
  ], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  const apps = new Map<string, InstalledApp>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-zA-Z][\w.]*)\/([a-zA-Z.$][\w.$]*)$/);
    if (!match) continue;
    const [, packageName, activity] = match;
    const key = `${packageName}/${activity}`;
    apps.set(key, { packageName, activity, label: knownLabels[packageName] || packageName });
  }
  return [...apps.values()].sort((a, b) => a.label.localeCompare(b.label) || a.packageName.localeCompare(b.packageName));
}

function cleanDescription(value: string): string {
  return value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`/g, '').trim();
}

export function capabilityCatalog(): { driverVersion: string; entries: CapabilityEntry[] } {
  const readme = path.join(driverDir, 'README.md');
  const packageJson = path.join(driverDir, 'package.json');
  const driverVersion = JSON.parse(fs.readFileSync(packageJson, 'utf8')).version as string;
  const source = fs.readFileSync(readme, 'utf8');
  const section = source.split(/^## Capabilities\s*$/m)[1]?.split(/^## Element Attributes\s*$/m)[0] || '';
  let category = 'General';
  const entries: CapabilityEntry[] = [];
  const seen = new Set<string>();
  for (const line of section.split(/\r?\n/)) {
    const heading = line.match(/^### (.+)$/);
    if (heading) { category = heading[1]; continue; }
    const separator = line.indexOf(' | ');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    if (!/^(?:platformName|browserName|pageLoadStrategy|appium:[A-Za-z][\w]*)$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, category, description: cleanDescription(line.slice(separator + 3)) });
  }
  return { driverVersion, entries };
}
