import { Module } from '@nestjs/common';
import { BulkDownloadService } from './service/bulk-download.service';
import { TickerMapService } from './service/ticker-map.service';

@Module({
  providers: [BulkDownloadService, TickerMapService],
  exports: [BulkDownloadService, TickerMapService],
})
export class FetchEdgarModule {}
