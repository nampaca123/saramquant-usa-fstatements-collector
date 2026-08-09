import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { resolveCredentials } from '../../aws/credentials';

const EXTENSIONS = ['httpfs', 'avro', 'iceberg'];

@Injectable()
export class DuckDbClientService implements OnModuleDestroy {
  private connection: DuckDBConnection | null = null;

  constructor(private readonly config: ConfigService) {}

  private async connect(): Promise<DuckDBConnection> {
    if (!this.connection) {
      const instance = await DuckDBInstance.create(':memory:');
      const con = await instance.connect();
      const extDir = process.env.DUCKDB_EXTENSION_DIR;
      if (extDir) {
        await con.run(`SET extension_directory='${extDir}'`);
      } else {
        // 로컬 개발 — 베이크 디렉토리가 없으면 명시적으로 설치
        for (const ext of EXTENSIONS) await con.run(`INSTALL ${ext}`);
      }
      // 암묵 네트워크 설치 금지는 무조건 — env 누락 시 조용한 런타임 다운로드 폴백을 막는다
      await con.run('SET autoinstall_known_extensions=false');
      await con.run('SET autoload_known_extensions=false');
      for (const ext of EXTENSIONS) await con.run(`LOAD ${ext}`);
      await con.run('SET http_retries=2');
      this.connection = con;
    }
    await this.mintSecret(this.connection);
    return this.connection;
  }

  // 연결은 재사용하되 시크릿은 호출마다 재발급 (태스크 롤 세션 토큰 만료 대비)
  private async mintSecret(con: DuckDBConnection): Promise<void> {
    const creds = await resolveCredentials()();
    const region = this.config.get<string>('app.dataRegion');
    const token = creds.sessionToken ?? '';
    try {
      await con.run(
        `CREATE OR REPLACE SECRET s3sec (TYPE s3, KEY_ID '${creds.accessKeyId}', ` +
          `SECRET '${creds.secretAccessKey}', SESSION_TOKEN '${token}', REGION '${region}')`,
      );
    } catch {
      // DuckDB 파서 에러는 statement 원문을 메시지에 싣는다 — 자격증명이 run-summary/로그로 새지 않게 마스킹
      throw new Error('duckdb s3 secret setup failed (credential values redacted)');
    }
  }

  async query(sql: string): Promise<unknown[][]> {
    const con = await this.connect();
    const reader = await con.runAndReadAll(sql);
    return reader.getRows();
  }

  async run(sql: string): Promise<void> {
    const con = await this.connect();
    await con.run(sql);
  }

  onModuleDestroy(): void {
    this.connection?.disconnectSync();
    this.connection = null;
  }
}
