import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
