// 以 createRequire 載入 node:sqlite:vite-node(測試環境)尚無法解析此內建模組。
import { createRequire } from 'node:module';
import type * as SqliteTypes from 'node:sqlite';

const mod = createRequire(import.meta.url)('node:sqlite') as typeof SqliteTypes;

export const DatabaseSync = mod.DatabaseSync;
export type DatabaseSync = SqliteTypes.DatabaseSync;
export type SQLInputValue = SqliteTypes.SQLInputValue;
