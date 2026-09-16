import type { ChildProcess } from 'node:child_process';

/** kill() 只发送信号；收到 close 后才可以删除子进程使用的数据库目录。 */
export async function stopProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`子进程 ${child.pid} 未能在 5 秒内退出`));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('close', closed);
      child.off('error', failed);
    };
    const closed = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    child.once('close', closed);
    child.once('error', failed);
    child.kill('SIGKILL');
  });
}
