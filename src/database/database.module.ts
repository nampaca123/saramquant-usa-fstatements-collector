import { Global, Module } from '@nestjs/common';
import { DatabasePool } from './lib/pool';
import { StockListService } from './service/stock-list.service';

@Global()
@Module({
  providers: [DatabasePool, StockListService],
  exports: [DatabasePool, StockListService],
})
export class DatabaseModule {}
