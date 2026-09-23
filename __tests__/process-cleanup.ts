import type { ChildProcess } from 'node:child_process';

/** kill() 只发送信号；收到 exit 后进程已释放数据库，管道可能稍后才关闭。 */
export async function stopProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`子进程 ${child.pid} 未能在 5 秒内退出`));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', exited);
      child.off('error', failed);
    };
    const exited = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    child.once('exit', exited);
    child.once('error', failed);
    child.kill('SIGKILL');
  });
}
