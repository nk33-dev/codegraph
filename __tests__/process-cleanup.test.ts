import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { stopProcess } from './process-cleanup';

describe('stopProcess', () => {
  it('进程退出后不等待仍被共享的标准流关闭', async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid: 1234, exitCode: null, signalCode: null });
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
      return true;
    });

    await expect(stopProcess(child)).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
