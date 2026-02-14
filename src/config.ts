import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiKey: process.env.API_KEY ?? '',
  databaseUrl: process.env.SUPABASE_DB_TRANSACTION_POOLER_URL ?? '',
}));

export const SEC_USER_AGENT = 'SaramQuant nampaca123@gmail.com';
export const DATA_DIR = '/tmp/edgar';
