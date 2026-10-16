import * as fs from 'node:fs';
import * as path from 'node:path';
import { Writable } from 'node:stream';

export interface RotationOptions {
  filePath: string;
  maxSizeBytes: number;
  keep: number;
}

/**
 * A Writable stream that rotates files when maxSizeBytes is reached,
 * maintaining up to `keep` previous segments (e.g. name.1.log, name.2.log).
 */
export class RotatingFileStream extends Writable {
  private currentBytes = 0;
  private currentFd: number | null = null;
  private readonly targetDir: string;
  private readonly baseName: string;
  private readonly ext: string;

  constructor(private readonly options: RotationOptions) {
    super();
    this.targetDir = path.dirname(options.filePath);
    this.ext = path.extname(options.filePath);
    this.baseName = path.basename(options.filePath, this.ext);

    if (!fs.existsSync(this.targetDir)) {
      fs.mkdirSync(this.targetDir, { recursive: true });
    }

    this.openCurrentFile();
  }

  private openCurrentFile(): void {
    if (this.currentFd !== null) {
      try {
        fs.closeSync(this.currentFd);
      } catch {
        // Ignore close error
      }
      this.currentFd = null;
    }

    try {
      if (fs.existsSync(this.options.filePath)) {
        const stats = fs.statSync(this.options.filePath);
        this.currentBytes = stats.size;
      } else {
        this.currentBytes = 0;
      }
      this.currentFd = fs.openSync(this.options.filePath, 'a');
    } catch {
      this.currentFd = null;
    }
  }

  private rotate(): void {
    if (this.currentFd !== null) {
      try {
        fs.closeSync(this.currentFd);
      } catch {
        // Ignore close error
      }
      this.currentFd = null;
    }

    const { keep } = this.options;

    // Remove oldest if it exists
    const oldest = path.join(this.targetDir, `${this.baseName}.${keep}${this.ext}`);
    if (fs.existsSync(oldest)) {
      try {
        fs.unlinkSync(oldest);
      } catch {
        // Ignore unlink error
      }
    }

    // Shift existing rotated files
    for (let i = keep - 1; i >= 1; i--) {
      const src = path.join(this.targetDir, `${this.baseName}.${i}${this.ext}`);
      const dest = path.join(this.targetDir, `${this.baseName}.${i + 1}${this.ext}`);
      if (fs.existsSync(src)) {
        try {
          fs.renameSync(src, dest);
        } catch {
          // Ignore rename error
        }
      }
    }

    // Rotate main file to .1
    if (fs.existsSync(this.options.filePath)) {
      const dest = path.join(this.targetDir, `${this.baseName}.1${this.ext}`);
      try {
        fs.renameSync(this.options.filePath, dest);
      } catch {
        // Ignore rename error
      }
    }

    this.openCurrentFile();
  }

  public writeLine(line: string): void {
    if (this.currentFd === null) {
      this.openCurrentFile();
    }

    const buffer = Buffer.from(line, 'utf-8');

    if (this.currentBytes + buffer.length > this.options.maxSizeBytes) {
      this.rotate();
    }

    if (this.currentFd !== null) {
      fs.writeSync(this.currentFd, buffer);
      this.currentBytes += buffer.length;
    }
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const line = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
      this.writeLine(line);
      callback(null);
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.currentFd !== null) {
      try {
        fs.closeSync(this.currentFd);
        this.currentFd = null;
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
    callback(null);
  }

  public flushSync(): void {
    if (this.currentFd !== null) {
      try {
        fs.fsyncSync(this.currentFd);
      } catch {
        // Ignore fsync error
      }
    }
  }
}

/**
 * Enforces total disk size limit across log files in a directory.
 * Audit logs are NEVER deleted.
 */
export function enforceTotalLogBudget(
  logsDir: string,
  maxTotalBytes: number,
): void {
  if (!fs.existsSync(logsDir)) return;

  try {
    const files = fs.readdirSync(logsDir).map((f) => {
      const fullPath = path.join(logsDir, f);
      const stat = fs.statSync(fullPath);
      return {
        name: f,
        fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        isAudit: f.startsWith('audit'),
      };
    });

    let totalBytes = files.reduce((acc, f) => acc + f.size, 0);
    if (totalBytes <= maxTotalBytes) return;

    // Sort non-audit files oldest first
    const candidates = files
      .filter((f) => !f.isAudit)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const file of candidates) {
      if (totalBytes <= maxTotalBytes) break;
      try {
        fs.unlinkSync(file.fullPath);
        totalBytes -= file.size;
      } catch {
        // Ignore unlink error
      }
    }
  } catch {
    // Ignore error
  }
}
