import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsIn,
  listIn,
  mkdirIn,
  readBufferIn,
  readFileIn,
  removeIn,
  statIn,
  writeFileAtomicIn,
} from '../../../src/util/fs-safe.js';
import { isAirError } from '../../../src/errors/index.js';

describe('fs-safe jail operations', () => {
  let rootJail: string;

  beforeEach(async () => {
    rootJail = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'air-jail-'));
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(rootJail, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failure
    }
  });

  it('atomically writes and reads a text file', async () => {
    const filename = 'greeting.txt';
    const content = 'Hello AIR Runtime!';

    await writeFileAtomicIn(rootJail, filename, content);

    const exists = await existsIn(rootJail, filename);
    expect(exists).toBe(true);

    const read = await readFileIn(rootJail, filename);
    expect(read).toBe(content);
  });

  it('reads binary buffers accurately', async () => {
    const filename = 'binary.bin';
    const buffer = Buffer.from([0x00, 0xff, 0x42, 0x13, 0x37]);

    await writeFileAtomicIn(rootJail, filename, buffer);

    const readBuf = await readBufferIn(rootJail, filename);
    expect(readBuf).toEqual(buffer);
  });

  it('auto-creates nested directories on atomic write', async () => {
    const nested = 'deep/nested/sub/dir/config.json';
    const payload = JSON.stringify({ active: true });

    await writeFileAtomicIn(rootJail, nested, payload);

    const read = await readFileIn(rootJail, nested);
    expect(JSON.parse(read)).toEqual({ active: true });
  });

  it('throws AirError NOT_FOUND on missing file', async () => {
    await expect(readFileIn(rootJail, 'does_not_exist.txt')).rejects.toSatisfy((err: unknown) => {
      return isAirError(err) && err.code === 'NOT_FOUND';
    });
  });

  it('lists sorted directory contents', async () => {
    await writeFileAtomicIn(rootJail, 'z.txt', 'z');
    await writeFileAtomicIn(rootJail, 'a.txt', 'a');
    await writeFileAtomicIn(rootJail, 'm.txt', 'm');

    const list = await listIn(rootJail);
    expect(list).toEqual(['a.txt', 'm.txt', 'z.txt']);
  });

  it('creates directory and verifies stats', async () => {
    await mkdirIn(rootJail, 'sub_dir');
    const stats = await statIn(rootJail, 'sub_dir');
    expect(stats.isDirectory()).toBe(true);
  });

  it('removes files and directories safely', async () => {
    await writeFileAtomicIn(rootJail, 'to_delete.txt', 'trash');
    expect(await existsIn(rootJail, 'to_delete.txt')).toBe(true);

    await removeIn(rootJail, 'to_delete.txt');
    expect(await existsIn(rootJail, 'to_delete.txt')).toBe(false);
  });

  it('strictly blocks reading or writing outside the jail with PATH_ESCAPE', async () => {
    const escapePath = '../escape_secret.txt';

    await expect(writeFileAtomicIn(rootJail, escapePath, 'pwned')).rejects.toSatisfy(
      (err: unknown) => isAirError(err) && err.code === 'PATH_ESCAPE',
    );

    await expect(readFileIn(rootJail, escapePath)).rejects.toSatisfy(
      (err: unknown) => isAirError(err) && err.code === 'PATH_ESCAPE',
    );

    await expect(readBufferIn(rootJail, escapePath)).rejects.toSatisfy(
      (err: unknown) => isAirError(err) && err.code === 'PATH_ESCAPE',
    );

    await expect(statIn(rootJail, escapePath)).rejects.toSatisfy(
      (err: unknown) => isAirError(err) && err.code === 'PATH_ESCAPE',
    );

    await expect(listIn(rootJail, escapePath)).rejects.toSatisfy(
      (err: unknown) => isAirError(err) && err.code === 'PATH_ESCAPE',
    );

    await expect(removeIn(rootJail, escapePath)).rejects.toSatisfy(
      (err: unknown) => isAirError(err) && err.code === 'PATH_ESCAPE',
    );

    await expect(mkdirIn(rootJail, escapePath)).rejects.toSatisfy(
      (err: unknown) => isAirError(err) && err.code === 'PATH_ESCAPE',
    );

    expect(await existsIn(rootJail, escapePath)).toBe(false);
  });

  it('throws NOT_FOUND when reading buffer or stat on non-existent file', async () => {
    await expect(readBufferIn(rootJail, 'missing_bin.bin')).rejects.toSatisfy(
      (err: unknown) => isAirError(err) && err.code === 'NOT_FOUND',
    );

    await expect(statIn(rootJail, 'missing_file.txt')).rejects.toSatisfy(
      (err: unknown) => isAirError(err) && err.code === 'NOT_FOUND',
    );

    await expect(listIn(rootJail, 'missing_dir')).rejects.toSatisfy(
      (err: unknown) => isAirError(err) && err.code === 'NOT_FOUND',
    );
  });

  it('handles recursive removal and existing directory creation', async () => {
    await mkdirIn(rootJail, 'folder/nested');
    await mkdirIn(rootJail, 'folder/nested'); // idempotent directory creation
    await writeFileAtomicIn(rootJail, 'folder/nested/item.txt', 'data');

    await removeIn(rootJail, 'folder');
    expect(await existsIn(rootJail, 'folder')).toBe(false);
  });

  it('supports operations with absolute paths inside jail', async () => {
    const absPath = path.join(rootJail, 'abs_file.txt');
    await writeFileAtomicIn(rootJail, absPath, 'absolute content');

    expect(await existsIn(rootJail, absPath)).toBe(true);
    expect(await readFileIn(rootJail, absPath)).toBe('absolute content');
    const buf = await readBufferIn(rootJail, absPath);
    expect(buf.toString('utf-8')).toBe('absolute content');
  });

  it('throws TOOL_EXECUTION_FAILED on incompatible operations', async () => {
    await mkdirIn(rootJail, 'a_directory');
    // Reading directory as file
    await expect(readFileIn(rootJail, 'a_directory')).rejects.toSatisfy(
      (err: unknown) => isAirError(err) && (err.code === 'TOOL_EXECUTION_FAILED' || err.code === 'PERMISSION_DENIED'),
    );

    // Reading buffer on directory
    await expect(readBufferIn(rootJail, 'a_directory')).rejects.toSatisfy(
      (err: unknown) => isAirError(err) && (err.code === 'TOOL_EXECUTION_FAILED' || err.code === 'PERMISSION_DENIED'),
    );

    // Listing file as directory
    await writeFileAtomicIn(rootJail, 'not_a_dir.txt', 'content');
    await expect(listIn(rootJail, 'not_a_dir.txt')).rejects.toSatisfy(
      (err: unknown) => isAirError(err) && err.code === 'TOOL_EXECUTION_FAILED',
    );
  });
});
