import { Global, Module } from '@nestjs/common';
import { AthenaClientService } from './athena-client.service';
import { S3ClientService } from './s3-client.service';

@Global()
@Module({
  providers: [AthenaClientService, S3ClientService],
  exports: [AthenaClientService, S3ClientService],
})
export class AwsModule {}
