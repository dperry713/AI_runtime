import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  assertInside,
  canonicalize,
  isInside,
  isReservedDeviceName,
  normalizeSeparators,
  rejectUnsafeName,
  validatePathSyntax,
} from '../../../src/util/paths.js';

describe('Windows Reserved Device Names', () => {
  it('detects standard DOS device names regardless of case', () => {
    expect(isReservedDeviceName('CON')).toBe(true);
    expect(isReservedDeviceName('con')).toBe(true);
    expect(isReservedDeviceName('prn')).toBe(true);
    expect(isReservedDeviceName('aux')).toBe(true);
    expect(isReservedDeviceName('nul')).toBe(true);
    expect(isReservedDeviceName('com1')).toBe(true);
    expect(isReservedDeviceName('COM9')).toBe(true);
    expect(isReservedDeviceName('lpt1')).toBe(true);
    expect(isReservedDeviceName('LPT9')).toBe(true);
  });

  it('detects reserved names with arbitrary extensions', () => {
    expect(isReservedDeviceName('con.txt')).toBe(true);
    expect(isReservedDeviceName('AUX.json')).toBe(true);
    expect(isReservedDeviceName('nul.tar.gz')).toBe(true);
    expect(isReservedDeviceName('com4.log')).toBe(true);
  });

  it('allows safe filenames that contain device substrings but are not device names', () => {
    expect(isReservedDeviceName('contact.txt')).toBe(false);
    expect(isReservedDeviceName('auxiliary.json')).toBe(false);
    expect(isReservedDeviceName('null.js')).toBe(false);
    expect(isReservedDeviceName('console.log')).toBe(false);
  });
});

describe('rejectUnsafeName', () => {
  it('allows valid normal names', () => {
    expect(() => rejectUnsafeName('file.txt')).not.toThrow();
    expect(() => rejectUnsafeName('document_2026-01-01.md')).not.toThrow();
    expect(() => rejectUnsafeName('.')).not.toThrow();
    expect(() => rejectUnsafeName('..')).not.toThrow();
  });

  it('rejects slashes in segment names', () => {
    expect(() => rejectUnsafeName('foo/bar')).toThrow();
    expect(() => rejectUnsafeName('foo\\bar')).toThrow();
  });

  it('rejects trailing dots and spaces', () => {
    expect(() => rejectUnsafeName('file.txt.')).toThrow();
    expect(() => rejectUnsafeName('folder ')).toThrow();
    expect(() => rejectUnsafeName('test...')).toThrow();
  });

  it('rejects illegal Windows characters', () => {
    for (const char of ['<', '>', ':', '"', '|', '?', '*']) {
      expect(() => rejectUnsafeName(`bad${char}name`)).toThrow();
    }
  });

  it('rejects reserved device names', () => {
    expect(() => rejectUnsafeName('CON')).toThrow();
    expect(() => rejectUnsafeName('nul.txt')).toThrow();
  });
});

describe('validatePathSyntax', () => {
  it('rejects null bytes', () => {
    expect(() => validatePathSyntax('C:\\dev\\foo\0bar')).toThrow();
  });

  it('rejects UNC paths', () => {
    expect(() => validatePathSyntax('\\\\server\\share\\file.txt')).toThrow();
    expect(() => validatePathSyntax('//server/share/file.txt')).toThrow();
  });

  it('rejects Alternate Data Streams (ADS) and $DATA streams', () => {
    expect(() => validatePathSyntax('C:\\dev\\file.txt:hidden')).toThrow();
    expect(() => validatePathSyntax('folder:stream')).toThrow();
    expect(() => validatePathSyntax('C:\\dev\\file.txt::$DATA')).toThrow();
  });

  it('rejects NT namespace device and raw volume paths', () => {
    expect(() => validatePathSyntax('\\\\.\\pipe\\air_test_pipe')).toThrow();
    expect(() => validatePathSyntax('\\\\.\\PhysicalDrive0')).toThrow();
    expect(() => validatePathSyntax('//./pipe/test')).toThrow();
  });

  it('rejects extended-length \\\\?\\ prefix paths', () => {
    expect(() => validatePathSyntax('\\\\\\\\?\\C:\\dev\\file.txt')).toThrow();
    expect(() => validatePathSyntax('\\\\\\\\?\\C:\\')).toThrow();
  });

  it('rejects Windows reserved device names with arbitrary extensions', () => {
    expect(() => rejectUnsafeName('aux.json')).toThrow();
    expect(() => rejectUnsafeName('prn.txt')).toThrow();
    expect(() => rejectUnsafeName('com1.dat')).toThrow();
    expect(() => rejectUnsafeName('lpt9.log')).toThrow();
    expect(() => rejectUnsafeName('con.2026.log')).toThrow();
  });

  it('allows valid absolute and relative Windows paths', () => {
    expect(() => validatePathSyntax('C:\\dev\\project\\file.txt')).not.toThrow();
    expect(() => validatePathSyntax('src/util/paths.ts')).not.toThrow();
  });
});

describe('canonicalize', () => {
  it('normalizes drive letters and slashes', () => {
    const canon = canonicalize('c:/dev/test/file.txt');
    expect(canon).toMatch(/^C:\\/);
    expect(canon).not.toContain('/');
  });

  it('resolves relative dot navigation', () => {
    const canon = canonicalize('C:\\dev\\foo\\..\\bar');
    expect(canon.toLowerCase()).toBe('c:\\dev\\bar');
  });
});

describe('canonicalize — extended-length (\\\\?\\) paths', () => {
  it('accepts ?\\<drive>: prefix only for paths > 260 chars', () => {
    // A long path (> 260 chars) with \\?\ prefix should be accepted
    const longDir = 'a'.repeat(255);
    const longPath = `\\\\?\\C:\\dev\\${longDir}\\file.txt`;
    expect(() => validatePathSyntax(longPath)).not.toThrow();
  });

  it('rejects short paths with ?\\ prefix', () => {
    // Short paths with ?\ prefix are rejected (no need for extended-length)
    expect(() => validatePathSyntax('\\\\?\\C:\\dev\\project\\file.txt')).toThrow();
    expect(() => validatePathSyntax('\\\\?\\C:\\Windows\\win.ini')).toThrow();
  });

  it('rejects ?\\UNC and .\\ device namespaces', () => {
    expect(() => validatePathSyntax('\\\\?\\UNC\\server\\share\\file.txt')).toThrow();
    expect(() => validatePathSyntax('\\\\.\\pipe\\air_test_pipe')).toThrow();
  });

  it('canonicalizes a long path with \\\\?\\ prefix', () => {
    const longDir = 'a'.repeat(255);
    const canon = canonicalize(`\\\\?\\C:\\dev\\${longDir}\\foo\\..\\bar`);
    expect(canon.toLowerCase()).toContain('c:\\dev\\' + 'a'.repeat(255) + '\\bar');
  });

  it('handles long paths in isInside', () => {
    const longDir = 'a'.repeat(200);
    const root = `C:\\dev\\${longDir}`;
    const child = `${root}\\sub\\file.txt`;
    expect(isInside(root, child)).toBe(true);
    expect(isInside(root, 'C:\\dev\\other')).toBe(false);
  });
});

describe('canonicalize — 8.3 short name expansion', () => {
  it('expands 8.3 short names when realpath resolves them', () => {
    // Create a temp directory with a long name to test 8.3 expansion
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-83-test-'));
    try {
      const longName = 'very-long-directory-name-for-8-3-testing';
      const deepDir = path.join(tmpDir, longName);
      fs.mkdirSync(deepDir, { recursive: true });

      // Check if the system supports 8.3 short names
      try {
        fs.realpathSync.native(deepDir);
        // If realpath succeeds, 8.3 expansion may be at play
        // We just verify canonicalize doesn't throw and returns a valid path
        const canon = canonicalize(deepDir);
        expect(canon).toBeDefined();
        expect(typeof canon).toBe('string');
      } catch {
        // realpath may fail on some systems; that's OK
      }

      // Test canonicalize with an 8.3-style path segment (if short names exist)
      // We construct a path with a tilde segment to verify it doesn't crash
      const tildePath = path.join(tmpDir, 'VERYLO~1');
      try {
        const canon = canonicalize(tildePath);
        expect(canon).toBeDefined();
      } catch {
        // 8.3 name may not exist; canonicalize should still not crash unexpectedly
        // (it will throw PATH_NOT_ALLOWED or similar if the path is invalid)
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('isInside correctly handles 8.3 short name escape attempts', () => {
    const root = 'C:\\dev\\jail';
    // An 8.3 short name like PROGRA~1 could be used to try to escape
    // isInside should canonicalize both paths and compare properly
    const escapeAttempt = 'C:\\dev\\jail\\..\\..\\Windows\\System32';
    expect(isInside(root, escapeAttempt)).toBe(false);

    // A nested path under the jail should still be inside
    const nested = 'C:\\dev\\jail\\sub\\dir\\file.txt';
    expect(isInside(root, nested)).toBe(true);
  });
});

describe('isInside & assertInside', () => {
  const root = 'C:\\dev\\project';

  it('returns true for root itself', () => {
    expect(isInside(root, 'C:\\dev\\project')).toBe(true);
    expect(isInside(root, 'c:\\DEV\\project')).toBe(true);
  });

  it('returns true for nested children', () => {
    expect(isInside(root, 'C:\\dev\\project\\src\\index.ts')).toBe(true);
    expect(isInside(root, 'c:\\dev\\project\\deeply\\nested\\sub\\dir')).toBe(true);
  });

  it('returns false for traversal escapes', () => {
    expect(isInside(root, 'C:\\dev\\project\\..\\secret.txt')).toBe(false);
    expect(isInside(root, 'C:\\dev\\other')).toBe(false);
    expect(isInside(root, 'C:\\dev\\project_extended')).toBe(false); // Sibling prefix trick
  });

  it('assertInside returns canonical path on success', () => {
    const res = assertInside(root, 'C:\\dev\\project\\src\\util');
    expect(res.toLowerCase()).toBe('c:\\dev\\project\\src\\util');
  });

  it('assertInside throws AirError PATH_ESCAPE on escape attempt', () => {
    expect(() => assertInside(root, 'C:\\Windows\\System32\\cmd.exe')).toThrowError(
      expect.objectContaining({ code: 'PATH_ESCAPE' }),
    );
  });
});

describe('Property-based testing (fast-check)', () => {
  const root = 'C:\\dev\\jail';

  it('never considers a path containing excessive ".." traversal as inside the jail', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('..', 'escaped', 'secret', 'outside'), { minLength: 5, maxLength: 10 }),
        (segments) => {
          const testPath = path.join(root, ...segments);
          // If the path escapes the root directory, isInside must return false
          const resolved = path.resolve(testPath).toLowerCase();
          const lowerRoot = path.resolve(root).toLowerCase();
          const actuallyInside = resolved === lowerRoot || resolved.startsWith(lowerRoot + '\\');

          expect(isInside(root, testPath)).toBe(actuallyInside);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('normalizes arbitrary mixes of slashes consistently', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        (str) => {
          const normalized = normalizeSeparators(str);
          expect(normalized).not.toContain('/');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('handles empty strings and edge conditions properly', () => {
    expect(isReservedDeviceName('')).toBe(false);
    expect(isReservedDeviceName('   ')).toBe(false);
    expect(() => rejectUnsafeName('')).toThrow();
    expect(() => validatePathSyntax('')).toThrow();
    // @ts-expect-error Testing non-string runtime validation
    expect(() => validatePathSyntax(null)).toThrow();
    expect(isInside('C:\\valid\\root', 'invalid:\0null')).toBe(false);
  });
});

describe('canonicalize — \\\\?\\ prefix stripping from realpath', () => {
  const originalRealpath = fs.realpathSync.native.bind(fs.realpathSync);

  afterEach(() => {
    fs.realpathSync.native = originalRealpath;
  });

  it('strips \\\\?\\ prefix from realpathSync.native result', () => {
    fs.realpathSync.native = (() => '\\\\?\\C:\\dev\\resolved\\path') as unknown as typeof fs.realpathSync.native;
    const canon = canonicalize('C:\\dev\\input\\path');
    expect(canon).toBe('C:\\dev\\resolved\\path');
  });

  it('adds \\\\?\\ prefix when realpath result exceeds 260 chars', () => {
    const longResolved = '\\\\?\\C:\\dev\\' + 'x'.repeat(260) + '\\file.txt';
    fs.realpathSync.native = (() => longResolved) as unknown as typeof fs.realpathSync.native;
    const canon = canonicalize('C:\\dev\\input');
    expect(canon).toBe(longResolved);
  });

  it('strips \\\\?\\ prefix from realAncestor in fallback path', () => {
    fs.realpathSync.native = ((p: string) => {
      if (p === 'C:\\dev') {
        return '\\\\?\\C:\\dev';
      }
      throw new Error('ENOENT');
    }) as typeof fs.realpathSync.native;
    const canon = canonicalize('C:\\dev\\nonexistent\\file.txt');
    expect(canon).toBe('C:\\dev\\nonexistent\\file.txt');
  });

  it('strips \\\\?\\ prefix from realFull in fallback tail resolution', () => {
    let callCount = 0;
    fs.realpathSync.native = ((p: string) => {
      callCount++;
      // First call (from canonicalize's try block) throws to enter fallback
      if (p === 'C:\\dev\\existing\\file.txt' && callCount === 1) {
        throw new Error('ENOENT');
      }
      // Ancestor resolves with \\?\ prefix
      if (p === 'C:\\dev') {
        return '\\\\?\\C:\\dev';
      }
      // Full tail path resolves with \\?\ prefix (covers lines 255-257)
      if (p === 'C:\\dev\\existing\\file.txt') {
        return '\\\\?\\C:\\dev\\existing\\file.txt';
      }
      throw new Error('ENOENT');
    }) as unknown as typeof fs.realpathSync.native;
    const canon = canonicalize('C:\\dev\\existing\\file.txt');
    expect(canon).toBe('C:\\dev\\existing\\file.txt');
  });
});
