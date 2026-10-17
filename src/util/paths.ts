/**
 * Windows-hardened path library for AIR (Rule R5).
 * Enforces canonicalization, jail containment, reparse-point defense, and rejects:
 * - DOS device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) with or without extensions
 * - Alternate Data Streams (ADS :stream)
 * - Trailing dots and spaces (silent Windows truncation)
 * - UNC paths and \\?\ prefix abuse
 * - Reparse-point / junction escapes
 */

import path from 'node:path';
import fs from 'node:fs';
import { AirError } from '../errors/index.js';

const RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

const INVALID_CHARS_SET = new Set(['<', '>', ':', '"', '|', '?', '*']);

export function hasInvalidPathChars(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    const char = name[i];
    if (code < 32 || (char !== undefined && INVALID_CHARS_SET.has(char))) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if a string segment represents a DOS reserved device name
 * (e.g. CON, con.txt, AUX.json, com1.tar.gz).
 */
export function isReservedDeviceName(segment: string): boolean {
  const trimmed = segment.trimEnd();
  if (!trimmed) {
    return false;
  }
  const dotIndex = trimmed.indexOf('.');
  const baseName = dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex);
  return RESERVED_DEVICE_NAMES.has(baseName.toUpperCase());
}

/**
 * Checks if a single path segment (filename or directory name) is safe.
 * Rejects illegal characters, reserved device names, and trailing dots/spaces.
 */
export function rejectUnsafeName(name: string): void {
  if (!name || name.length === 0) {
    throw new AirError('PATH_NOT_ALLOWED', 'Path segment cannot be empty');
  }

  if (name.includes('/') || name.includes('\\')) {
    throw new AirError('PATH_NOT_ALLOWED', `Path segment cannot contain slashes: "${name}"`);
  }

  if (name === '.' || name === '..') {
    return;
  }

  // Trailing dot or space check (Windows silently strips these)
  if (name.endsWith('.') || name.endsWith(' ')) {
    throw new AirError(
      'PATH_NOT_ALLOWED',
      `Path segment cannot end with a dot or space: "${name}"`,
    );
  }

  // Check for forbidden characters (< > : " | ? * and control chars)
  if (hasInvalidPathChars(name)) {
    throw new AirError(
      'PATH_NOT_ALLOWED',
      `Path segment contains invalid characters: "${name}"`,
    );
  }

  // Check for reserved DOS device names
  if (isReservedDeviceName(name)) {
    throw new AirError(
      'PATH_NOT_ALLOWED',
      `Path segment uses reserved Windows device name: "${name}"`,
    );
  }
}

/**
 * Normalizes all path separators to standard Windows backslash.
 */
export function normalizeSeparators(p: string): string {
  return p.replace(/\//g, '\\');
}

/**
 * Validates a path string for prohibited syntax:
 * - UNC paths (\\\\server\\share)
 * - Extended length prefixes (\\\\?\\, \\\\.\\)
 * - Alternate Data Streams (:stream)
 * - Reserved device names and trailing dots/spaces in any segment
 */
export function validatePathSyntax(rawPath: string): void {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'Path must be a non-empty string');
  }

  if (rawPath.includes('\0')) {
    throw new AirError('PATH_NOT_ALLOWED', 'Path cannot contain null bytes');
  }

  // Reject URL-encoded path traversal, separator sequences, null bytes, and double-encoding
  if (/%(2[eEfF]|5[cC]|00|25)/i.test(rawPath)) {
    throw new AirError('PATH_NOT_ALLOWED', `URL-encoded path traversal or separator sequences are forbidden: "${rawPath}"`);
  }

  const normalized = normalizeSeparators(rawPath);

  // Reject UNC paths and device namespaces
  if (normalized.startsWith('\\\\') || normalized.startsWith('\\??\\')) {
    throw new AirError('PATH_NOT_ALLOWED', `UNC and device namespace paths are forbidden: "${rawPath}"`);
  }

  // Reject drive-relative paths (e.g. "C:file.txt") and Alternate Data Streams (colon anywhere other than drive letter position, e.g. "C:\")
  const drivePrefix = /^[a-zA-Z]:/.exec(normalized)?.[0];
  if (drivePrefix) {
    if (normalized.length > 2 && normalized[2] !== '\\') {
      throw new AirError('PATH_NOT_ALLOWED', `Drive-relative paths without root slash are forbidden: "${rawPath}"`);
    }
  }
  const afterDrive = drivePrefix ? normalized.slice(2) : normalized;
  if (afterDrive.includes(':')) {
    throw new AirError('PATH_NOT_ALLOWED', `Alternate Data Streams (ADS) are forbidden: "${rawPath}"`);
  }

  // Check all segments
  const segments = normalized.split('\\');
  for (const seg of segments) {
    if (!seg || seg === drivePrefix) {
      continue;
    }
    rejectUnsafeName(seg);
  }
}

/**
 * Resolves a path, canonicalizing drive letters, expanding 8.3 short names,
 * and resolving any symbolic links or NTFS junctions for existing components.
 */
export function canonicalize(rawPath: string): string {
  validatePathSyntax(rawPath);

  const resolved = path.resolve(rawPath);

  // Normalize drive letter to uppercase for consistent comparison (e.g. c:\ -> C:\)
  let normalized = resolved;
  if (/^[a-z]:/i.test(normalized)) {
    const driveLetter = normalized[0]?.toUpperCase() ?? '';
    normalized = driveLetter + normalized.slice(1);
  }

  // Try realpathSync to resolve junctions, symlinks, and 8.3 short names
  try {
    const real = fs.realpathSync.native(normalized);
    if (/^[a-z]:/i.test(real)) {
      return (real[0]?.toUpperCase() ?? '') + real.slice(1);
    }
    return real;
  } catch {
    // If target does not exist, resolve the closest existing ancestor
    let current = path.dirname(normalized);
    const tails: string[] = [path.basename(normalized)];

    while (current && current !== path.dirname(current)) {
      try {
        const realAncestor = fs.realpathSync.native(current);
        const driveNormalized = /^[a-z]:/i.test(realAncestor)
          ? (realAncestor[0]?.toUpperCase() ?? '') + realAncestor.slice(1)
          : realAncestor;
        return path.join(driveNormalized, ...tails);
      } catch {
        tails.unshift(path.basename(current));
        current = path.dirname(current);
      }
    }

    return normalized;
  }
}

/**
 * Checks whether target path is strictly contained within root path.
 * Canonicalizes both paths, resolves all symlinks/junctions, and enforces
 * case-insensitive containment on Windows.
 */
export function isInside(root: string, target: string): boolean {
  try {
    const canonRoot = canonicalize(root);
    const canonTarget = canonicalize(target);

    // On Windows, filesystem comparisons are case-insensitive
    const lowerRoot = canonRoot.toLowerCase();
    const lowerTarget = canonTarget.toLowerCase();

    if (lowerTarget === lowerRoot) {
      return true;
    }

    const prefixWithSlash = lowerRoot.endsWith('\\') ? lowerRoot : `${lowerRoot}\\`;
    return lowerTarget.startsWith(prefixWithSlash);
  } catch {
    return false;
  }
}

/**
 * Asserts that target path is inside root.
 * Returns the canonicalized target path on success, or throws AirError('PATH_ESCAPE').
 */
export function assertInside(root: string, target: string): string {
  if (!isInside(root, target)) {
    throw new AirError(
      'PATH_ESCAPE',
      `Path "${target}" escapes root jail "${root}"`,
      { context: { root, target } },
    );
  }
  return canonicalize(target);
}
