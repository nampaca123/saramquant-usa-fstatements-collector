import { Module } from '@nestjs/common';
import { FactsParserService } from './service/facts-parser.service';
import { StatementWriterService } from './service/statement-writer.service';

@Module({
  providers: [FactsParserService, StatementWriterService],
  exports: [FactsParserService, StatementWriterService],
})
export class ProcessSaveModule {}
