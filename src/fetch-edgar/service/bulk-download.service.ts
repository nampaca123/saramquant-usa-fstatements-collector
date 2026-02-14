import { Injectable, Logger } from '@nestjs/common';
import { createWriteStream, existsSync, statSync, rmSync, mkdirSync } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DATA_DIR } from '../../config';
import { createEdgarHttp } from '../lib/edgar-http';

const execFileAsync = promisify(execFile);

const BULK_FACTS_URL =
  'https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip';
const MAX_RETRIES = 3;
const MAX_AGE_HOURS = 168; // 7 days

@Injectable()
export class BulkDownloadService {
  private readonly logger = new Logger(BulkDownloadService.name);
  private readonly http = createEdgarHttp();

  async download(): Promise<string> {
    const dest = join(DATA_DIR, 'companyfacts');
    const zipPath = join(DATA_DIR, 'companyfacts.zip');

    if (this.isFresh(dest)) {
      this.logger.log('Bulk data is fresh, skipping download');
      return dest;
    }

    if (existsSync(dest)) rmSync(dest, { recursive: true });
    mkdirSync(dest, { recursive: true });

    await this.downloadZip(zipPath);
    await this.extractZip(zipPath, dest);
    await unlink(zipPath).catch(() => {});

    this.logger.log(`Bulk data extracted to ${dest}`);
    return dest;
  }

  private isFresh(dir: string): boolean {
    if (!existsSync(dir)) return false;
    try {
      const ageHours =
        (Date.now() - statSync(dir).mtimeMs) / (1000 * 60 * 60);
      if (ageHours < MAX_AGE_HOURS) {
        this.logger.log(`Bulk data is ${ageHours.toFixed(1)}h old, reusing`);
        return true;
      }
      this.logger.log(`Bulk data is ${ageHours.toFixed(1)}h old, refreshing`);
    } catch {
      /* missing dir */
    }
    return false;
  }

  private async downloadZip(zipPath: string): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.logger.log(
          `Downloading companyfacts.zip (attempt ${attempt}/${MAX_RETRIES})...`,
        );
        const resp = await this.http.get(BULK_FACTS_URL, {
          responseType: 'stream',
          timeout: 14_400_000, // 4h max
        });

        const total = parseInt(resp.headers['content-length'] ?? '0', 10);
        let downloaded = 0;
        let lastLoggedPct = -1;

        await new Promise<void>((resolve, reject) => {
          const writer = createWriteStream(zipPath);
          resp.data.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            if (total) {
              const pct = Math.floor((downloaded / total) * 100);
              if (pct >= lastLoggedPct + 10) {
                lastLoggedPct = pct;
                this.logger.log(
                  `Download: ${pct}% (${(downloaded / 1024 / 1024).toFixed(0)}MB / ${(total / 1024 / 1024).toFixed(0)}MB)`,
                );
              }
            }
          });
          resp.data.pipe(writer);
          writer.on('finish', () => {
            if (total && downloaded < total) {
              reject(new Error(`Incomplete: ${downloaded}/${total} bytes`));
            } else {
              this.logger.log(
                `Download complete (${(downloaded / 1024 / 1024).toFixed(0)}MB)`,
              );
              resolve();
            }
          });
          writer.on('error', reject);
          resp.data.on('error', reject);
        });
        return;
      } catch (err) {
        this.logger.warn(`Download attempt ${attempt} failed: ${err}`);
        if (existsSync(zipPath)) await unlink(zipPath).catch(() => {});
        if (attempt === MAX_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 10_000 * attempt));
      }
    }
  }

  private async extractZip(zipPath: string, destDir: string): Promise<void> {
    this.logger.log('Extracting companyfacts.zip...');
    await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', destDir]);
  }
}
