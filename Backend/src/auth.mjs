import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const options = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Password must contain 12 to 256 characters');
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64, options);
  return `scrypt$16384$8$1$${salt}$${derived.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const parts = String(encoded).split('$');
  if (parts.length !== 6 || parts.slice(0,4).join('$') !== 'scrypt$16384$8$1' ||
      !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) return false;
  const derived = await scrypt(password, parts[4], 64, options);
  return timingSafeEqual(derived, Buffer.from(parts[5], 'hex'));
}
export const opaqueToken = () => randomBytes(32).toString('hex');
export const tokenDigest = token => createHash('sha256').update(token).digest('hex');
export function sessionCookie(token, secure, expires) {
  return `presence_session=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; ${expires ? `Expires=${expires.toUTCString()}` : 'Max-Age=0'}`;
}
export function readSessionCookie(header = '') {
  const value = header.split(';').map(v => v.trim()).find(v => v.startsWith('presence_session='))?.slice(17);
  return /^[a-f0-9]{64}$/.test(value ?? '') ? value : null;
}
