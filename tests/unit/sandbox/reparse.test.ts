import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  ReparseDefense,
  checkHardlinks,
  inspectReparseChain,
  isReparsePoint,
  openSafelyInJail,
} from '../../../src/sandbox/reparse.js';

describe('Reparse-Point Defense & TOCTOU Prevention (P7-T03)', () => {
  const defense = new ReparseDefense();

  describe('Basic Detection', () => {
    it('returns false for regular files and directories', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      try {
        const file = path.join(jail, 'file.txt');
        writeFileSync(file, 'normal file');

        expect(await isReparsePoint(jail)).toBe(false);
        expect(await isReparsePoint(file)).toBe(false);
      } finally {
        rmSync(jail, { recursive: true, force: true });
      }
    });

    it('returns false for non-existent paths without throwing', async () => {
      expect(
        await isReparsePoint('C:\\non_existent_path_123456789\\xyz.txt'),
      ).toBe(false);
      expect(
        await defense.isReparse('C:\\non_existent_path_123456789\\xyz.txt'),
      ).toBe(false);
    });
  });

  describe('NTFS Junction Detection & Jail Containment', () => {
    it('permits intra-jail directory junctions when allowed', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      const targetDir = path.join(jail, 'inner_target');
      const junctionPath = path.join(jail, 'inner_junction');

      try {
        execSync(`cmd /c mkdir "${targetDir}" && mklink /J "${junctionPath}" "${targetDir}"`);

        expect(await isReparsePoint(junctionPath)).toBe(true);

        const inspection = await defense.inspect(jail, junctionPath);
        expect(inspection.safe).toBe(true);
        expect(inspection.hasReparsePoints).toBe(true);
        expect(inspection.violations).toHaveLength(0);

        const safePath = await defense.assertSafe(jail, junctionPath);
        expect(safePath).toBeDefined();
      } finally {
        try {
          execSync(`cmd /c rmdir "${junctionPath}"`);
        } catch {
          // ignore
        }
        rmSync(jail, { recursive: true, force: true });
      }
    });

    it('detects and rejects extra-jail directory junctions escaping root jail', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-outside-'));
      const escapeJunction = path.join(jail, 'escape_link');

      try {
        execSync(`cmd /c mklink /J "${escapeJunction}" "${outsideDir}"`);

        expect(await isReparsePoint(escapeJunction)).toBe(true);

        const inspection = await defense.inspect(jail, escapeJunction);
        expect(inspection.safe).toBe(false);
        expect(inspection.hasReparsePoints).toBe(true);
        expect(inspection.violations.length).toBeGreaterThan(0);
        expect(inspection.violations[0]).toContain('escapes root jail');

        await expect(defense.assertSafe(jail, escapeJunction)).rejects.toThrow(
          AirError,
        );
        await expect(defense.assertSafe(jail, escapeJunction)).rejects.toThrow(
          /escapes root jail/,
        );
      } finally {
        try {
          execSync(`cmd /c rmdir "${escapeJunction}"`);
        } catch {
          // ignore
        }
        rmSync(jail, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('detects ancestral junction escapes on deep nested paths', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-outside-'));
      const outsideFile = path.join(outsideDir, 'secret.txt');
      writeFileSync(outsideFile, 'secret external content');

      const nestedJail = path.join(jail, 'sub', 'nested');
      const junctionInNested = path.join(nestedJail, 'junction_to_outside');

      try {
        execSync(
          `cmd /c mkdir "${nestedJail}" && mklink /J "${junctionInNested}" "${outsideDir}"`,
        );

        const deepTarget = path.join(junctionInNested, 'secret.txt');

        const inspection = await inspectReparseChain(jail, deepTarget);
        expect(inspection.safe).toBe(false);
        expect(inspection.violations.some((v) => v.includes('escapes root jail'))).toBe(true);

        await expect(defense.assertSafe(jail, deepTarget)).rejects.toThrow(AirError);
      } finally {
        try {
          execSync(`cmd /c rmdir "${junctionInNested}"`);
        } catch {
          // ignore
        }
        rmSync(jail, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('rejects junctions when disallowJunctions is configured', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      const targetDir = path.join(jail, 'target');
      const junctionPath = path.join(jail, 'junc');

      try {
        execSync(`cmd /c mkdir "${targetDir}" && mklink /J "${junctionPath}" "${targetDir}"`);

        await expect(
          defense.assertSafe(jail, junctionPath, { disallowJunctions: true }),
        ).rejects.toThrow(/Directory junctions are disallowed by policy/);

        await expect(
          defense.assertSafe(jail, junctionPath, { disallowAllSymlinks: true }),
        ).rejects.toThrow(/Symbolic links are disallowed by policy/);
      } finally {
        try {
          execSync(`cmd /c rmdir "${junctionPath}"`);
        } catch {
          // ignore
        }
        rmSync(jail, { recursive: true, force: true });
      }
    });
  });

  describe('Working Directory (cwd) Reparse Defense', () => {
    it('verifies safe working directory inside workspace', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      try {
        const sub = path.join(jail, 'src');
        execSync(`cmd /c mkdir "${sub}"`);

        const verified = await defense.verifyWorkingDirectory(jail, sub);
        expect(verified).toBeDefined();
      } finally {
        rmSync(jail, { recursive: true, force: true });
      }
    });

    it('rejects working directory that escapes through junction', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-outside-'));
      const escapeJunction = path.join(jail, 'cwd_escape');

      try {
        execSync(`cmd /c mklink /J "${escapeJunction}" "${outsideDir}"`);

        await expect(
          defense.verifyWorkingDirectory(jail, escapeJunction),
        ).rejects.toThrow(/escapes root jail/);
      } finally {
        try {
          execSync(`cmd /c rmdir "${escapeJunction}"`);
        } catch {
          // ignore
        }
        rmSync(jail, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('Hardlink Defenses', () => {
    it('identifies unlinked files as safe (nlink = 1)', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      try {
        const file = path.join(jail, 'normal.txt');
        writeFileSync(file, 'single link');

        const info = await checkHardlinks(file);
        expect(info.nlink).toBe(1);
        expect(info.hasMultipleLinks).toBe(false);
      } finally {
        rmSync(jail, { recursive: true, force: true });
      }
    });

    it('detects multiple hardlinks (nlink > 1)', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      const file = path.join(jail, 'orig.txt');
      const hardlink = path.join(jail, 'link.txt');

      try {
        writeFileSync(file, 'target data');
        execSync(`cmd /c mklink /H "${hardlink}" "${file}"`);

        const info = await defense.checkHardlinkCount(hardlink);
        expect(info.nlink).toBeGreaterThanOrEqual(2);
        expect(info.hasMultipleLinks).toBe(true);
      } finally {
        try {
          execSync(`cmd /c del "${hardlink}"`);
        } catch {
          // ignore
        }
        rmSync(jail, { recursive: true, force: true });
      }
    });
  });

  describe('TOCTOU-Resistant Safe Open', () => {
    it('opens and operates on normal files with verification', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      const file = path.join(jail, 'safe_file.txt');

      try {
        writeFileSync(file, 'initial content');

        const handle = await openSafelyInJail(jail, file, 'r+');
        try {
          expect(handle.nlink).toBe(1);
          const content = await handle.readFile({ encoding: 'utf-8' });
          expect(content).toBe('initial content');

          await handle.write('updated content');
          const stat = await handle.stat();
          expect(stat.size).toBeGreaterThan(0);
        } finally {
          await handle.close();
        }
      } finally {
        rmSync(jail, { recursive: true, force: true });
      }
    });

    it('supports async dispose protocol (using)', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      const file = path.join(jail, 'dispose_test.txt');

      try {
        writeFileSync(file, 'dispose content');
        const handle = await defense.openSafe(jail, file, 'r');
        await handle[Symbol.asyncDispose]();
      } finally {
        rmSync(jail, { recursive: true, force: true });
      }
    });

    it('refuses to open hardlinked files by default (hardlink attack defense)', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      const file = path.join(jail, 'base.txt');
      const hardlink = path.join(jail, 'hl.txt');

      try {
        writeFileSync(file, 'sensitive payload');
        execSync(`cmd /c mklink /H "${hardlink}" "${file}"`);

        await expect(
          openSafelyInJail(jail, hardlink, 'r', undefined, { allowHardlinks: false }),
        ).rejects.toThrow(/Hardlink attack detected/);

        // Allows open when explicitly opted in
        const handle = await openSafelyInJail(jail, hardlink, 'r', undefined, {
          allowHardlinks: true,
        });
        await handle.close();
      } finally {
        try {
          execSync(`cmd /c del "${hardlink}"`);
        } catch {
          // ignore
        }
        rmSync(jail, { recursive: true, force: true });
      }
    });

    it('rejects opening files through escaping junctions', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-outside-'));
      const escapeJunction = path.join(jail, 'junc');
      const outsideFile = path.join(outsideDir, 'target.txt');

      try {
        writeFileSync(outsideFile, 'secret data');
        execSync(`cmd /c mklink /J "${escapeJunction}" "${outsideDir}"`);

        const trappedPath = path.join(escapeJunction, 'target.txt');

        await expect(defense.openSafe(jail, trappedPath, 'r')).rejects.toThrow(
          /escapes root jail/,
        );
      } finally {
        try {
          execSync(`cmd /c rmdir "${escapeJunction}"`);
        } catch {
          // ignore
        }
        rmSync(jail, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('throws NOT_FOUND when file does not exist', async () => {
      const jail = mkdtempSync(path.join(os.tmpdir(), 'air-reparse-unit-'));
      try {
        await expect(
          defense.openSafe(jail, 'non_existent_file.txt', 'r'),
        ).rejects.toThrow(AirError);
      } finally {
        rmSync(jail, { recursive: true, force: true });
      }
    });
  });
});
