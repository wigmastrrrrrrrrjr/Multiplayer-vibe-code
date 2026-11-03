/**
 * Auth primitives: lobby invite tokens and HMAC-signed member tokens.
 * Uses WebCrypto (crypto.subtle) — available in the Workers runtime, Node ≥18,
 * and other modern runtimes. Pure functions; no I/O beyond crypto.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomHex(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Standard base64 (for file content in JSON bodies). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Lobby invite tokens ------------------------------------------------------- */

/** Invite tokens embed the lobby id so join can route to the right DO. */
export function newInviteToken(lobbyId: string): string {
  return `${lobbyId}:${randomHex(16)}`;
}

export function parseInviteToken(
  inviteToken: string,
): { lobbyId: string; token: string } | null {
  const i = inviteToken.indexOf(':');
  if (i <= 0 || i === inviteToken.length - 1) return null;
  return { lobbyId: inviteToken.slice(0, i), token: inviteToken.slice(i + 1) };
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* HMAC-SHA256 ---------------------------------------------------------------- */

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** The crypto provider's key type (works in Workers and Node webcrypto). */
export type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function hmacSign(secret: string, payload: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return base64url(new Uint8Array(sig));
}

async function hmacVerify(secret: string, payload: string, sigB64url: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      base64urlToBytes(sigB64url),
      encoder.encode(payload),
    );
  } catch {
    return false;
  }
}

/* Member tokens (signed, short-lived) --------------------------------------- */

export interface MemberTokenPayload {
  v: 1; // token version
  mid: string; // memberId
  lid: string; // lobbyId
  exp: number; // unix ms
}

export const MEMBER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function signMemberToken(
  secret: string,
  payload: Omit<MemberTokenPayload, 'v'>,
): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify({ v: 1, ...payload })));
  const sig = await hmacSign(secret, body);
  return `${body}.${sig}`;
}

/** Returns the payload if the token is well-formed and still valid, else null. */
export async function verifyMemberToken(
  secret: string,
  token: string,
): Promise<MemberTokenPayload | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!(await hmacVerify(secret, body, sig))) return null;
  try {
    const payload = JSON.parse(decoder.decode(base64urlToBytes(body))) as MemberTokenPayload;
    if (payload.v !== 1 || typeof payload.mid !== 'string' || typeof payload.lid !== 'string') {
      return null;
    }
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Extracts the lobby id from a member token WITHOUT verifying the signature.
 * Routing-only: the Durable Object re-verifies before acting, so this cannot
 * be used to authenticate — only to decide which DO handles a request.
 */
export function memberTokenLobbyId(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  try {
    const body = JSON.parse(decoder.decode(base64urlToBytes(token.slice(0, dot)))) as {
      lid?: unknown;
    };
    return typeof body.lid === 'string' ? body.lid : null;
  } catch {
    return null;
  }
}