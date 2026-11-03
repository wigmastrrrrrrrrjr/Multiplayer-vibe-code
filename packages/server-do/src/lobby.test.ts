import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FileIndexEntry, FilePutRequest } from '@mvc/shared';
import {
  indexPaths,
  KEYS,
  quotaError,
  validLobbyPath,
  validateFilePut,
} from '../src/lobby.ts';

describe('KEYS', () => {
  it('builds namespaced storage keys', () => {
    assert.equal(KEYS.lobby('l1'), 'lobby:l1');
    assert.equal(KEYS.members('l1'), 'members:l1');
    assert.equal(KEYS.yDoc('l1', 'src/a.ts'), 'y:l1:src/a.ts');
    assert.equal(KEYS.fileContent('l1', 'src/a.ts'), 'f:l1:src/a.ts');
    assert.equal(KEYS.lock('l1', 'a.ts'), 'lock:l1:a.ts');
    assert.equal(KEYS.chatIndex('l1'), 'chatindex:l1');
    assert.equal(KEYS.totalBytes('l1'), 'totalbytes:l1');
  });
});

describe('quotaError', () => {
  const limits = { maxFiles: 2, maxBytes: 10 };
  const index: FileIndexEntry[] = [
    { path: 'a.ts', kind: 'text', size: 4, updatedAt: 0, updatedBy: 'm' },
    { path: 'b.ts', kind: 'text', size: 4, updatedAt: 0, updatedBy: 'm' },
  ];

  it('allows writes within the quota', () => {
    assert.equal(quotaError([], 'a.ts', 10, 0, limits), null);
    assert.equal(quotaError(index, 'a.ts', 4, 8, limits), null);
  });

  it('rejects new files once the file cap is reached', () => {
    assert.match(quotaError(index, 'c.ts', 1, 8, limits) ?? '', /file limit/);
  });

  it('counts only the delta when replacing a file', () => {
    assert.equal(quotaError(index, 'a.ts', 6, 8, limits), null);
    assert.match(quotaError(index, 'a.ts', 7, 8, limits) ?? '', /quota/);
  });

  it('rejects writes that exceed the byte quota', () => {
    assert.match(quotaError([], 'big.bin', 11, 0, limits) ?? '', /quota/);
    assert.match(quotaError([index[0]!], 'c.ts', 3, 8, limits) ?? '', /quota/);
  });
});

describe('validateFilePut', () => {
  const ok: FilePutRequest = { path: 'src/a.ts', content: 'x' };

  it('accepts a valid text put', () => {
    assert.equal(validateFilePut(ok), null);
  });

  it('accepts a valid binary put', () => {
    assert.equal(validateFilePut({ path: 'img/p.png', content_base64: 'AAAA' }), null);
  });

  it('accepts nested subdirectories', () => {
    assert.equal(validateFilePut({ path: 'src/deep/er/a.ts', content: 'y' }), null);
  });

  it('rejects missing body / path', () => {
    assert.ok(validateFilePut(null));
    assert.ok(validateFilePut({ path: '', content: 'x' }));
  });

  it('rejects absolute or traversal paths', () => {
    assert.ok(validateFilePut({ path: '/etc/passwd', content: 'x' }));
    assert.ok(validateFilePut({ path: 'a\\b', content: 'x' }));
    assert.ok(validateFilePut({ path: '../secret', content: 'x' }));
    assert.ok(validateFilePut({ path: 'a//b', content: 'x' }));
    assert.ok(validateFilePut({ path: 'a/./b', content: 'x' }));
  });

  it('rejects ignored paths', () => {
    assert.ok(validateFilePut({ path: 'node_modules/x.js', content: 'x' }));
    assert.ok(validateFilePut({ path: '.git/config', content: 'x' }));
    assert.ok(validateFilePut({ path: 'dist/main.js', content: 'x' }));
  });

  it('requires exactly one content field', () => {
    assert.ok(validateFilePut({ path: 'a.ts' }));
    assert.ok(validateFilePut({ path: 'a.ts', content: 'x', content_base64: 'eA==' }));
  });
});

describe('validLobbyPath', () => {
  it('accepts relative lobby paths', () => {
    assert.equal(validLobbyPath('src/a.ts'), null);
    assert.equal(validLobbyPath('README.md'), null);
    assert.equal(validLobbyPath('a/b/c/d.txt'), null);
  });

  it('rejects traversal and absolute paths', () => {
    assert.ok(validLobbyPath('../x'));
    assert.ok(validLobbyPath('/etc/passwd'));
    assert.ok(validLobbyPath('a\\b'));
    assert.ok(validLobbyPath('a/./b'));
    assert.ok(validLobbyPath('a//b'));
    assert.ok(validLobbyPath(''));
  });

  it('rejects ignored paths (live sync must respect ignores too)', () => {
    assert.ok(validLobbyPath('node_modules/x.js'));
    assert.ok(validLobbyPath('.git/config'));
    assert.ok(validLobbyPath('dist/main.js'));
  });

  it('rejects secret-shaped paths', () => {
    assert.ok(validLobbyPath('.env'));
    assert.ok(validLobbyPath('certs/server.pem'));
    assert.ok(validLobbyPath('id_rsa'));
    assert.ok(validLobbyPath('.aws/credentials'));
  });
});

describe('indexPaths', () => {
  it('sorts paths', () => {
    const entries: FileIndexEntry[] = [
      { path: 'b.ts', kind: 'text', updatedAt: 0, updatedBy: 'm1' },
      { path: 'a.ts', kind: 'text', updatedAt: 0, updatedBy: 'm1' },
    ];
    assert.deepEqual(indexPaths(entries), ['a.ts', 'b.ts']);
  });
});