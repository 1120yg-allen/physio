// npm run dev:同時啟動後端(8787)與前端開發伺服器(5173)
import { spawn } from 'node:child_process';

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
const procs = [run('npx', ['tsx', 'watch', 'src/server/index.ts']), run('npx', ['vite'])];

const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', stop));
