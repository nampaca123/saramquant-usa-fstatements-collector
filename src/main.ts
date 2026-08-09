import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { PipelineRunnerService } from './pipeline-runner.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  let exitCode = 1;
  try {
    const status = await app.get(PipelineRunnerService).runWithSummary();
    // partial도 실패로 전파 — SFN Catch→온디맨드 1회 재시도 후에도 partial이면 알람이 울린다.
    // 무음으로 3개월(다음 분기까지) 스테일되는 것보다 시끄러운 게 낫다.
    exitCode = status === 'ok' ? 0 : 1;
  } catch (err) {
    Logger.error(`pipeline crashed: ${err}`, undefined, 'Bootstrap');
  } finally {
    await app.close();
  }
  // process.exit()는 awslogs로 가는 stdout 버퍼(마지막 줄이 run_summary JSON)를 버릴 수 있다
  process.exitCode = exitCode;
}
bootstrap();
