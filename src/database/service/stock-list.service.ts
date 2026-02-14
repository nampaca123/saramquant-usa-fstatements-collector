import { Injectable } from '@nestjs/common';
import { DatabasePool } from '../lib/pool';

export interface StockEntry {
  stockId: number;
  symbol: string;
}

@Injectable()
export class StockListService {
  constructor(private readonly db: DatabasePool) {}

  async getActiveUsStocks(): Promise<StockEntry[]> {
    const { rows } = await this.db.query(
      `SELECT id, symbol FROM stocks
       WHERE market IN ('US_NYSE', 'US_NASDAQ') AND is_active = true`,
    );
    return rows.map((r) => ({ stockId: r.id, symbol: r.symbol }));
  }
}
