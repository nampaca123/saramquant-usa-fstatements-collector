import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GlueClient, GetTableCommand } from '@aws-sdk/client-glue';
import { resolveCredentials } from '../../aws/credentials';

@Injectable()
export class GlueCatalogService {
  private readonly client: GlueClient;

  constructor(private readonly config: ConfigService) {
    this.client = new GlueClient({
      region: this.config.get<string>('app.dataRegion'),
      credentials: resolveCredentials(),
    });
  }

  async metadataLocation(table: string): Promise<string> {
    const res = await this.client.send(
      new GetTableCommand({
        DatabaseName: this.config.get<string>('app.glueDb'),
        Name: table,
      }),
    );
    const location = res.Table?.Parameters?.metadata_location;
    if (!location) {
      throw new Error(`${table}: metadata_location missing — not an Iceberg table?`);
    }
    return location;
  }
}
