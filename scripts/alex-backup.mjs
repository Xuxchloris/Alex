import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TradeStore } from '../packages/alex-core/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function restoreBackup(snapshotDirectory, targetDirectory) {
  const snapshot = resolve(snapshotDirectory), target = resolve(targetDirectory);
  if (snapshot === target) throw new Error('恢复目标必须是新的空目录');
  if (existsSync(target) && readdirSync(target).length) throw new Error('恢复目标必须为空，禁止覆盖现有数据');
  const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.database?.file || !/^[\w.-]+$/u.test(manifest.database.file)) throw new Error('备份清单格式无效');
  const file = join(snapshot, manifest.database.file);
  const checksum = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (checksum !== manifest.database.sha256) throw new Error('备份校验失败，停止恢复');
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = source.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('备份数据库完整性校验失败');
  } finally { source.close(); }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  copyFileSync(file, join(target, 'alex.sqlite3'));
  writeFileSync(join(target, 'restored-from.json'), JSON.stringify({ restoredAt: new Date().toISOString(), manifest }, null, 2), { mode: 0o600 });
  return { directory: target, database: join(target, 'alex.sqlite3'), createdAt: manifest.createdAt, checks: ['sha256', 'sqlite_integrity'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'restore') {
    if (!first || !second) throw new Error('用法：node scripts/alex-backup.mjs restore <备份目录> <新的空数据目录>');
    console.log(JSON.stringify(restoreBackup(first, second), null, 2));
  } else {
    const dataDir = resolve(process.env.ALEX_DATA_DIR || join(root, 'work/alex'));
    if (!existsSync(join(dataDir, 'alex.sqlite3'))) throw new Error('尚无客户数据库，请先启动 Alex');
    const store = new TradeStore({ path: join(dataDir, 'alex.sqlite3'), workspaceId: 'local' });
    try {
      const result = await store.backup(resolve(first || process.env.ALEX_BACKUP_DIR || join(dataDir, 'backups')));
      console.log(JSON.stringify(result, null, 2));
    } finally { store.close(); }
  }
}
