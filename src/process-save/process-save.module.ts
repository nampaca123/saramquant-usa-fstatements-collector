import { Module } from '@nestjs/common';
import { FactsParserService } from './service/facts-parser.service';
import { FactsReaderService } from './service/facts-reader.service';
import { StatementWriterService } from './service/statement-writer.service';

@Module({
  providers: [FactsParserService, FactsReaderService, StatementWriterService],
  exports: [FactsReaderService, StatementWriterService],
})
export class ProcessSaveModule {}
