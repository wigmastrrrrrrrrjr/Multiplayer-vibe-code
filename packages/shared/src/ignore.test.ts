import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_IGNORE, isIgnored } from '../src/ignore.ts';

describe('isIgnored', () => {
  it('ignores node_modules anywhere in the tree', () => {
    assert.equal(isIgnored('node_modules/foo/index.js'), true);
    assert.equal(isIgnored('src/node_modules/x'), true);
  });

  it('ignores top-level .git and its contents', () => {
    assert.equal(isIgnored('.git/HEAD'), true);
    assert.equal(isIgnored('.git'), true);
  });

  it('ignores build/cache outputs', () => {
    assert.equal(isIgnored('dist/index.js'), true);
    assert.equal(isIgnored('coverage/lcov.info'), true);
    assert.equal(isIgnored('debug.log'), true);
  });

  it('keeps source files', () => {
    assert.equal(isIgnored('src/auth.ts'), false);
    assert.equal(isIgnored('package.json'), false);
    assert.equal(isIgnored('README.md'), false);
  });

  it('keeps dotfiles like .env.example unless explicitly ignored', () => {
    assert.equal(isIgnored('.env.example'), false);
    assert.equal(isIgnored('.github/workflows/ci.yml'), false);
  });

  it('ignores secret-shaped files by default', () => {
    assert.equal(isIgnored('.env'), true);
    assert.equal(isIgnored('apps/web/.env'), true);
    assert.equal(isIgnored('.env.local'), true);
    assert.equal(isIgnored('certs/server.pem'), true);
    assert.equal(isIgnored('certs/server.key'), true);
    assert.equal(isIgnored('home/.ssh/id_rsa'), true);
    assert.equal(isIgnored('id_ed25519'), true);
    assert.equal(isIgnored('.npmrc'), true);
    assert.equal(isIgnored('.aws/credentials'), true);
  });

  it('honours extra .lobbyignore patterns', () => {
    assert.equal(isIgnored('secrets/keys.json', ['secrets/**']), true);
  });

  it('handles windows-style separators', () => {
    assert.equal(isIgnored('src\\node_modules\\x'), true);
  });

  it('never hides the root or empty paths', () => {
    assert.equal(isIgnored(''), true);
    assert.equal(isIgnored('.'), true);
  });

  it('defaults are non-empty', () => {
    assert.ok(DEFAULT_IGNORE.length > 5);
  });
});