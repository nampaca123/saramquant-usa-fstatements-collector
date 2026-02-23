import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 8080;
  await app.listen(port);
  Logger.log(`Server running on port ${port}`, 'Bootstrap');
}
bootstrap();
