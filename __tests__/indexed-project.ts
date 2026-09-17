import { CodeGraph, type IndexOptions, type IndexResult } from '../src';

/** 测试持有实例后再启动索引，超时清理也能找到并等待仍在运行的任务。 */
export class IndexedProject {
  readonly graph: CodeGraph;
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<IndexResult>>();
  private closing: Promise<void> | undefined;

  constructor(root: string) {
    this.graph = CodeGraph.initSync(root);
  }

  index(options: Omit<IndexOptions, 'signal'> = {}): Promise<IndexResult> {
    return this.run(() => this.graph.indexAll({ ...options, signal: this.controller.signal }));
  }

  sync(): Promise<IndexResult> {
    return this.run(() => this.graph.sync());
  }

  private run(start: () => Promise<IndexResult>): Promise<IndexResult> {
    if (this.controller.signal.aborted) return Promise.reject(new Error('测试项目已关闭'));
    const task = start().then(result => {
      // Vitest 超时不会取消原 Promise；阻止它恢复后继续查询或启动下一次索引。
      if (this.controller.signal.aborted) throw new Error('测试项目正在清理，索引已取消');
      return result;
    });
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.controller.abort();
      this.closing = (async () => {
        // 等待索引的 finally 释放 worker/锁并完成指标写入，再关闭 SQLite。
        await Promise.allSettled([...this.pending]);
        this.graph.close();
      })();
    }
    return this.closing;
  }
}
