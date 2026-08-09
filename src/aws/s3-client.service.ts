import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { resolveCredentials } from './credentials';

@Injectable()
export class S3ClientService {
  private readonly client: S3Client;

  constructor(private readonly config: ConfigService) {
    this.client = new S3Client({
      region: this.config.get<string>('app.dataRegion'),
      credentials: resolveCredentials(),
    });
  }

  async putObject(key: string, body: Buffer | string, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.get<string>('app.bucket'),
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }
}
