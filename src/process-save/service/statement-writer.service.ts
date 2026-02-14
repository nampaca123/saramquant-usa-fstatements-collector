import { Injectable, Logger } from '@nestjs/common';
import { DatabasePool } from '../../database/lib/pool';
import { FinancialStatement } from './facts-parser.service';

const CHUNK_SIZE = 2000;

@Injectable()
export class StatementWriterService {
  private readonly logger = new Logger(StatementWriterService.name);

  constructor(private readonly db: DatabasePool) {}

  async upsertBatch(statements: FinancialStatement[]): Promise<number> {
    if (statements.length === 0) return 0;

    let total = 0;
    for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
      const chunk = statements.slice(i, i + CHUNK_SIZE);
      await this.upsertChunk(chunk);
      total += chunk.length;
    }
    this.logger.log(`Upserted ${total} financial statements`);
    return total;
  }

  private async upsertChunk(chunk: FinancialStatement[]): Promise<void> {
    const stockIds: number[] = [];
    const fiscalYears: number[] = [];
    const reportTypes: string[] = [];
    const revenues: (string | null)[] = [];
    const operatingIncomes: (string | null)[] = [];
    const netIncomes: (string | null)[] = [];
    const totalAssets: (string | null)[] = [];
    const totalLiabilities: (string | null)[] = [];
    const totalEquities: (string | null)[] = [];
    const sharesOutstandings: (number | null)[] = [];

    for (const s of chunk) {
      stockIds.push(s.stockId);
      fiscalYears.push(s.fiscalYear);
      reportTypes.push(s.reportType);
      revenues.push(s.revenue);
      operatingIncomes.push(s.operatingIncome);
      netIncomes.push(s.netIncome);
      totalAssets.push(s.totalAssets);
      totalLiabilities.push(s.totalLiabilities);
      totalEquities.push(s.totalEquity);
      sharesOutstandings.push(s.sharesOutstanding);
    }

    await this.db.query(
      `INSERT INTO financial_statements
         (stock_id, fiscal_year, report_type, revenue, operating_income,
          net_income, total_assets, total_liabilities, total_equity,
          shares_outstanding)
       SELECT * FROM unnest(
         $1::bigint[], $2::int[], $3::report_type[],
         $4::numeric[], $5::numeric[], $6::numeric[],
         $7::numeric[], $8::numeric[], $9::numeric[], $10::bigint[]
       )
       ON CONFLICT (stock_id, fiscal_year, report_type) DO UPDATE SET
         revenue = EXCLUDED.revenue,
         operating_income = EXCLUDED.operating_income,
         net_income = EXCLUDED.net_income,
         total_assets = EXCLUDED.total_assets,
         total_liabilities = EXCLUDED.total_liabilities,
         total_equity = EXCLUDED.total_equity,
         shares_outstanding = EXCLUDED.shares_outstanding`,
      [
        stockIds,
        fiscalYears,
        reportTypes,
        revenues,
        operatingIncomes,
        netIncomes,
        totalAssets,
        totalLiabilities,
        totalEquities,
        sharesOutstandings,
      ],
    );
  }
}
