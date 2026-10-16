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

    expect(await existsIn(rootJail, escapePath)).toBe(false);
  });
});
