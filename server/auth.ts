import { createHash, createHmac, randomBytes } from 'node:crypto';
import { importJWK, jwtVerify, SignJWT, type JWK } from 'jose';
import type { AppConfig, Role, Room } from '../shared/protocol.ts';
import { ApiFault } from './validation.ts';

export type Environment = Record<string, string | undefined>;
export const GUEST_TOKEN_SECONDS = 600;
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function appConfig(env: Environment): AppConfig {
  const missing = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'ELEVENLABS_API_KEY'].filter(key => !env[key]?.trim());
  if (!env.SUPABASE_JWT_SECRET?.trim()) {
    if (!env.SUPABASE_JWT_PRIVATE_KEY?.trim()) missing.push('SUPABASE_JWT_PRIVATE_KEY');
    let embeddedKid: unknown;
    try { embeddedKid = JSON.parse(env.SUPABASE_JWT_PRIVATE_KEY || '{}').kid; } catch { /* configuration validated when used */ }
    if (!env.SUPABASE_JWT_KEY_ID?.trim() && !embeddedKid) missing.push('SUPABASE_JWT_KEY_ID');
  }
  return { ready: missing.length === 0, missing, tier: 1 };
}

export function newRoomCode(): string {
  // Rejection sampling avoids bias if the readable alphabet changes in the future.
  let code = '';
  const ceiling = Math.floor(256 / ROOM_ALPHABET.length) * ROOM_ALPHABET.length;
  while (code.length < 6) for (const byte of randomBytes(12)) {
    if (byte < ceiling) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
    if (code.length === 6) break;
  }
  return code;
}

export function speakerSecret(): string { return `frs_${randomBytes(32).toString('base64url')}`; }
export function secretHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function isSpeakerSecret(value: string): boolean { return /^frs_[A-Za-z0-9_-]{43}$/.test(value); }

export function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ') || authorization.length > 5000) throw new ApiFault('UNAUTHORIZED', 'Please join this session again.', 401);
  const token = authorization.slice(7);
  if (!token || /\s/.test(token)) throw new ApiFault('UNAUTHORIZED', 'Please join this session again.', 401);
  return token;
}

export function rateKey(request: Request, env: Environment): string {
  // Store a daily keyed digest, never a raw address. Proxy headers are not authentication.
  const address = (request.headers.get('x-vercel-forwarded-for') || request.headers.get('x-forwarded-for') || 'local').split(',')[0].trim().slice(0,100);
  return createHmac('sha256', env.APP_SECRET || env.SUPABASE_SECRET_KEY || 'local-development')
    .update(`${new Date().toISOString().slice(0,10)}:${address}`).digest('hex');
}

type SigningMaterial = { algorithm: 'ES256' | 'HS256'; signingKey: CryptoKey | Uint8Array; verificationKey: CryptoKey | Uint8Array; kid?: string };

async function signingMaterial(env: Environment): Promise<SigningMaterial> {
  if (env.SUPABASE_JWT_PRIVATE_KEY) {
    let jwk: JWK;
    try { jwk = JSON.parse(env.SUPABASE_JWT_PRIVATE_KEY) as JWK; }
    catch { throw new ApiFault('CONFIGURATION_ERROR', 'Front Row needs a server configuration update.', 503); }
    const kid = env.SUPABASE_JWT_KEY_ID || jwk.kid;
    if (!jwk.d || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !kid) {
      throw new ApiFault('CONFIGURATION_ERROR', 'Front Row needs a server configuration update.', 503);
    }
    const { d: _private, ...publicJwk } = jwk;
    return {
      algorithm: 'ES256', kid,
      signingKey: await importJWK(jwk, 'ES256') as CryptoKey,
      verificationKey: await importJWK(publicJwk, 'ES256') as CryptoKey,
    };
  }
  if (!env.SUPABASE_JWT_SECRET) throw new ApiFault('CONFIGURATION_ERROR', 'Front Row needs a server configuration update.', 503);
  const key = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
  return { algorithm: 'HS256', signingKey: key, verificationKey: key };
}

export interface GuestClaims { roomId: string; code: string; role: Role; subject: string; }

export async function issueGuestToken(env: Environment, room: Room, role: Role, subject: string): Promise<{ token: string; expiresAt: number }> {
  const material = await signingMaterial(env);
  const expiresAt = Math.floor(Date.now() / 1000) + GUEST_TOKEN_SECONDS;
  const token = await new SignJWT({ role: 'authenticated', front_row_room: room.id, front_row_code: room.code, front_row_role: role })
    .setProtectedHeader({ alg: material.algorithm, typ: 'JWT', ...(material.kid ? { kid: material.kid } : {}) })
    .setIssuer(`${env.SUPABASE_URL?.replace(/\/$/, '')}/auth/v1`).setAudience('authenticated')
    .setSubject(subject).setIssuedAt().setExpirationTime(expiresAt).sign(material.signingKey);
  return { token, expiresAt };
}

export async function verifyGuestToken(env: Environment, token: string, code: string): Promise<GuestClaims> {
  try {
    const material = await signingMaterial(env);
    const { payload, protectedHeader } = await jwtVerify(token, material.verificationKey, {
      algorithms: [material.algorithm], issuer: `${env.SUPABASE_URL?.replace(/\/$/, '')}/auth/v1`, audience: 'authenticated',
    });
    if (material.kid && protectedHeader.kid !== material.kid) throw new Error('key');
    if (payload.role !== 'authenticated' || payload.front_row_code !== code
      || payload.front_row_role !== 'audience' || typeof payload.sub !== 'string'
      || typeof payload.front_row_room !== 'string'
      || !/^[0-9a-f-]{36}$/.test(payload.sub) || !/^[0-9a-f-]{36}$/.test(payload.front_row_room)) throw new Error('claims');
    return { roomId: payload.front_row_room, code, role: 'audience', subject: payload.sub };
  } catch {
    throw new ApiFault('UNAUTHORIZED', 'This session link has expired. Please join again.', 401);
  }
}
