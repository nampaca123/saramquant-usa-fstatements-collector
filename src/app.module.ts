import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from './config';
import { DatabaseModule } from './database/database.module';
import { FetchEdgarModule } from './fetch-edgar/fetch-edgar.module';
import { ProcessSaveModule } from './process-save/process-save.module';
import { AppController } from './app.controller';
import { ApiKeyGuard } from './api-key.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig] }),
    DatabaseModule,
    FetchEdgarModule,
    ProcessSaveModule,
  ],
  controllers: [AppController],
  providers: [ApiKeyGuard],
})
export class AppModule {}
