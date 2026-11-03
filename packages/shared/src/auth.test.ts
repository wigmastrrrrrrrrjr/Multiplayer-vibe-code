import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  base64url,
  base64urlToBytes,
  fromBase64,
  newInviteToken,
  parseInviteToken,
  randomHex,
  sha256Hex,
  signMemberToken,
  toBase64,
  verifyMemberToken,
} from './auth.ts';

describe('invite tokens', () => {
  it('embed the lobby id and are parseable', () => {
    const token = newInviteToken('lobby-abc-123');
    const parsed = parseInviteToken(token);
    assert.ok(parsed);
    assert.equal(parsed.lobbyId, 'lobby-abc-123');
    assert.ok(parsed.token.length >= 32);
  });

  it('rejects malformed invites', () => {
    assert.equal(parseInviteToken('nocolonseparator'), null);
    assert.equal(parseInviteToken(':leading'), null);
    assert.equal(parseInviteToken('trailing:'), null);
  });

  it('randomHex is unique-ish and hex', () => {
    const a = randomHex(16);
    const b = randomHex(16);
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f]{32}$/);
  });

  it('sha256Hex is deterministic', async () => {
    const h1 = await sha256Hex('hello');
    const h2 = await sha256Hex('hello');
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });
});

describe('member tokens', () => {
  it('signs and verifies a round trip', async () => {
    const secret = 'unit-test-secret';
    const token = await signMemberToken(secret, {
      mid: 'member-1',
      lid: 'lobby-1',
      exp: Date.now() + 60_000,
    });
    const payload = await verifyMemberToken(secret, token);
    assert.ok(payload);
    assert.equal(payload.v, 1);
    assert.equal(payload.mid, 'member-1');
    assert.equal(payload.lid, 'lobby-1');
  });

  it('rejects a tampered token', async () => {
    const token = await signMemberToken('s', {
      mid: 'm1',
      lid: 'l1',
      exp: Date.now() + 60_000,
    });
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    assert.equal(await verifyMemberToken('s', tampered), null);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = await signMemberToken('s1', {
      mid: 'm1',
      lid: 'l1',
      exp: Date.now() + 60_000,
    });
    assert.equal(await verifyMemberToken('s2', token), null);
  });

  it('rejects an expired token', async () => {
    const token = await signMemberToken('s', {
      mid: 'm1',
      lid: 'l1',
      exp: Date.now() - 1_000,
    });
    assert.equal(await verifyMemberToken('s', token), null);
  });
});

describe('base64 helpers', () => {
  it('round-trips url-safe base64', () => {
    const bytes = new TextEncoder().encode('payload with / + =  chars');
    const s = base64url(bytes);
    assert.deepEqual(base64urlToBytes(s), bytes);
    assert.ok(!s.includes('+') && !s.includes('/') && !s.includes('='));
  });

  it('round-trips standard base64', () => {
    const bytes = new TextEncoder().encode('binary-ish 🙂');
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  });
});