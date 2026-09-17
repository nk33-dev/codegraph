import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db';

// 分开发送 message 和 exit，稳定复现“SQL 已完成但线程尚未退出”的窗口。
const workers: EventEmitter[] = [];
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor() { super(); workers.push(this); }
    terminate() { return Promise.resolve(1); }
  },
}));

let dir: string;
let db: DatabaseConnection;
beforeEach(() => {
  workers.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-db-worker-'));
  db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
});
afterEach(() => {
  for (const worker of workers) worker.emit('exit', 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

it('维护收到完成消息后仍等待线程退出', async () => {
  let finished = false;
  const task = db.runMaintenance().then(() => { finished = true; });
  await nextTurn();
  const worker = workers[0];
  expect(worker).toBeDefined();
  worker.emit('message', 'done');
  await nextTurn();
  expect(finished).toBe(false);
  worker.emit('exit', 0);
  await task;
  expect(finished).toBe(true);
});

it('checkpoint 等待退出且保留返回的 WAL 统计', async () => {
  let finished = false;
  const task = db.checkpointWalPassive().then(result => { finished = true; return result; });
  await nextTurn();
  const worker = workers[0];
  const row = { busy: 0, log: 10, checkpointed: 10 };
  worker.emit('message', { row });
  await nextTurn();
  expect(finished).toBe(false);
  worker.emit('exit', 0);
  await expect(task).resolves.toEqual(row);
});

it('worker 报错后仍等待退出，且不返回成功统计', async () => {
  let finished = false;
  const task = db.checkpointWalPassive().then(result => { finished = true; return result; });
  await nextTurn();
  const worker = workers[0];
  worker.emit('message', { row: { busy: 0, log: 1, checkpointed: 1 } });
  worker.emit('error', new Error('模拟线程异常'));
  await nextTurn();
  expect(finished).toBe(false);
  worker.emit('exit', 1);
  await expect(task).resolves.toBeNull();
});
