import { join, resolve } from 'node:path';

export interface Config {
  port: number;
  /** 預設只聽本機;經 Tailscale 存取時設 HOST=0.0.0.0 並確認未對公網開放 */
  host: string;
  dbPath: string;
  backupDir: string;
  /** 前端建置輸出目錄(npm run build) */
  staticDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.PHYSIO_DATA_DIR ?? 'data');
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    dbPath: env.PHYSIO_DB ?? join(dataDir, 'physio.sqlite'),
    backupDir: resolve(env.PHYSIO_BACKUP_DIR ?? join(dataDir, 'backups')),
    staticDir: resolve(env.PHYSIO_STATIC_DIR ?? 'dist'),
  };
}
