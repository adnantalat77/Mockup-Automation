import path from 'node:path';

export interface AppConfig { dataDir: string; maxUploadBytes: number; webOrigin: string }

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const maxMb = Number(process.env.MAX_UPLOAD_MB ?? 12);
  return {
    dataDir: path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data')),
    maxUploadBytes: Number.isFinite(maxMb) && maxMb > 0 ? maxMb * 1024 * 1024 : 12 * 1024 * 1024,
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    ...overrides
  };
}
