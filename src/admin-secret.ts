import { timingSafeEqual } from 'node:crypto';

export function strongSecret(secret: string): boolean {
  return secret.length >= 24 && secret.length <= 256 && !secret.toLowerCase().includes('change-me');
}

export function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
