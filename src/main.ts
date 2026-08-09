import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { PipelineRunnerService } from './pipeline-runner.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  let exitCode = 1;
  try {
    const status = await app.get(PipelineRunnerService).runWithSummary();
    exitCode = status === 'error' ? 1 : 0;
  } catch (err) {
    Logger.error(`pipeline crashed: ${err}`, undefined, 'Bootstrap');
  } finally {
    await app.close();
  }
  process.exit(exitCode);
}
bootstrap();
