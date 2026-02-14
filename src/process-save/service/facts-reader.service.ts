import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { join } from 'path';
import pMap from 'p-map';
import { FactsParserService } from './facts-parser.service';
import type { FinancialStatement } from './facts-parser.service';
import type { StockEntry } from '../../database/service/stock-list.service';

const CONCURRENCY = 50;
const LOG_INTERVAL = 500;

export interface ParseResult {
  statements: FinancialStatement[];
  matched: number;
  failed: number;
}

@Injectable()
export class FactsReaderService {
  private readonly logger = new Logger(FactsReaderService.name);

  constructor(private readonly parser: FactsParserService) {}

  async readAndParse(
    dataDir: string,
    stocks: StockEntry[],
    tickerToCik: Map<string, number>,
    onProgress?: (parsed: number, total: number) => void,
  ): Promise<ParseResult> {
    const allStatements: FinancialStatement[] = [];
    let matched = 0;
    let failed = 0;
    let done = 0;

    await pMap(
      stocks,
      async ({ stockId, symbol }) => {
        const cik = tickerToCik.get(symbol.toUpperCase());
        if (!cik) { done++; return; }

        try {
          const filePath = join(dataDir, `CIK${String(cik).padStart(10, '0')}.json`);
          const raw = await readFile(filePath, 'utf-8').catch(() => null);
          if (!raw) { done++; return; }

          const stmts = this.parser.extractFromFacts(stockId, JSON.parse(raw));
          allStatements.push(...stmts);
          matched++;
        } catch (err) {
          this.logger.warn(`Skip ${symbol}: ${err}`);
          failed++;
        }

        done++;
        if (done % LOG_INTERVAL === 0) {
          onProgress?.(done, stocks.length);
          this.logger.log(`Parsed ${done}/${stocks.length}, ${allStatements.length} stmts`);
        }
      },
      { concurrency: CONCURRENCY },
    );

    onProgress?.(stocks.length, stocks.length);
    this.logger.log(`Done: ${matched} matched, ${failed} failed, ${allStatements.length} stmts`);
    return { statements: allStatements, matched, failed };
  }
}
