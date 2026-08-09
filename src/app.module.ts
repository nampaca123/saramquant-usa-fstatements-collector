import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from './config';
import { AwsModule } from './aws/aws.module';
import { DatabaseModule } from './database/database.module';
import { FetchEdgarModule } from './fetch-edgar/fetch-edgar.module';
import { ProcessSaveModule } from './process-save/process-save.module';
import { PipelineRunnerService } from './pipeline-runner.service';
import { RunSummaryService } from './run-summary.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig] }),
    AwsModule,
    DatabaseModule,
    FetchEdgarModule,
    ProcessSaveModule,
  ],
  providers: [PipelineRunnerService, RunSummaryService],
})
export class AppModule {}
