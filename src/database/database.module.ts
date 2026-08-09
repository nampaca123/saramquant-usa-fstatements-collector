import { Global, Module } from '@nestjs/common';
import { DuckDbClientService } from './lib/duckdb-client.service';
import { GlueCatalogService } from './lib/glue-catalog.service';
import { StockListService } from './service/stock-list.service';

@Global()
@Module({
  providers: [DuckDbClientService, GlueCatalogService, StockListService],
  exports: [DuckDbClientService, GlueCatalogService, StockListService],
})
export class DatabaseModule {}
