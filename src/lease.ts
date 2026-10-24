export type Lease = { kind: 'manual' | 'appium'; owner: string; expires: number };
let current: Lease | null = null;
const ttl = { manual: 60_000, appium: 310_000 };

export function getLease(): Lease | null {
  if (current && current.expires <= Date.now()) current = null;
  return current;
}
export function acquire(kind: Lease['kind'], owner: string): boolean {
  const active = getLease();
  if (active && (active.kind !== kind || active.owner !== owner)) return false;
  current = { kind, owner, expires: Date.now() + ttl[kind] };
  return true;
}
export function renew(kind: Lease['kind'], owner: string): boolean {
  const active = getLease();
  if (!active || active.kind !== kind || active.owner !== owner) return false;
  active.expires = Date.now() + ttl[kind];
  return true;
}
export function release(kind: Lease['kind'], owner: string) {
  const active = getLease();
  if (active?.kind === kind && active.owner === owner) current = null;
}
export function transfer(kind: Lease['kind'], oldOwner: string, newOwner: string) {
  const active = getLease();
  if (active?.kind === kind && active.owner === oldOwner) active.owner = newOwner;
}
