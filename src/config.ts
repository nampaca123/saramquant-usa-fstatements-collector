import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  bucket: process.env.SARAMQUANT_S3_BUCKET_NAME ?? 'saramquant-bucket',
  glueDb: process.env.SARAMQUANT_GLUE_DB ?? 'saramquant',
  athenaWorkgroup: process.env.SARAMQUANT_ATHENA_WORKGROUP ?? 'saramquant',
  dataRegion: process.env.SARAMQUANT_DATA_REGION ?? 'ap-northeast-2',
  runId: process.env.RUN_ID ?? `local-${Date.now()}`,
  symbolLimit: parseInt(process.env.SYMBOL_LIMIT ?? '0', 10),
}));

export const SEC_USER_AGENT = 'SaramQuant nampaca123@gmail.com';
export const DATA_DIR = '/tmp/edgar';
