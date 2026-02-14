import axios, { AxiosInstance } from 'axios';
import { SEC_USER_AGENT } from '../../config';

let lastRequestTime = 0;
const MIN_INTERVAL_MS = 100; // SEC rate limit: 10 req/s

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

export function createEdgarHttp(): AxiosInstance {
  const instance = axios.create({
    headers: {
      'User-Agent': SEC_USER_AGENT,
      'Accept-Encoding': 'gzip, deflate',
    },
    timeout: 30_000,
  });

  instance.interceptors.request.use(async (config) => {
    await throttle();
    return config;
  });

  return instance;
}
