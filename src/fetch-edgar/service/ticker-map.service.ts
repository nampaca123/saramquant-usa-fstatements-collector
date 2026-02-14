import { Injectable, Logger } from '@nestjs/common';
import { createEdgarHttp } from '../lib/edgar-http';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const MAX_RETRIES = 3;

@Injectable()
export class TickerMapService {
  private readonly logger = new Logger(TickerMapService.name);
  private readonly http = createEdgarHttp();

  async fetch(): Promise<Map<string, number>> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { data } = await this.http.get(TICKERS_URL);
        const map = new Map<string, number>();

        for (const entry of Object.values<Record<string, unknown>>(data)) {
          const ticker = entry.ticker as string | undefined;
          const cik = entry.cik_str as number | undefined;
          if (ticker && cik) map.set(ticker.toUpperCase(), Number(cik));
        }

        this.logger.log(`Loaded ${map.size} ticker-to-CIK mappings`);
        return map;
      } catch (err) {
        this.logger.warn(`Ticker fetch attempt ${attempt} failed: ${err}`);
        if (attempt === MAX_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    throw new Error('Unreachable');
  }
}
