import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DuckDbClientService } from '../lib/duckdb-client.service';
import { GlueCatalogService } from '../lib/glue-catalog.service';

export interface StockEntry {
  stockId: number;
  symbol: string;
}

@Injectable()
export class StockListService {
  constructor(
    private readonly duckdb: DuckDbClientService,
    private readonly glue: GlueCatalogService,
    private readonly config: ConfigService,
  ) {}

  async getActiveUsStocks(): Promise<StockEntry[]> {
    const meta = await this.glue.metadataLocation('stocks');
    const rows = await this.duckdb.query(
      `SELECT id, symbol FROM iceberg_scan('${meta}')
       WHERE market IN ('US_NYSE', 'US_NASDAQ') AND is_active = true`,
    );
    const stocks = rows.map((r) => ({ stockId: Number(r[0]), symbol: String(r[1]) }));
    const limit = this.config.get<number>('app.symbolLimit') ?? 0;
    return limit > 0 ? stocks.slice(0, limit) : stocks;
  }
}
