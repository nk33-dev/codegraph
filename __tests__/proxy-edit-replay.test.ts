import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { spawn } from 'child_process';

describe('MCP 代理断线恢复', () => {
  it('未确认的编辑不重放，只读请求仍能在本地完成', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-proxy-replay-'));
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\${path.basename(root)}` : path.join(root, 'daemon.sock');
    const received: string[] = [];
    const peers = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      peers.add(socket);
      socket.on('error', () => undefined);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (request.method === 'tools/call') received.push(request.params.name);
        }
        if (received.length === 2) socket.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    const script = `
      const net = require('net');
      const { runLocalHandshakeProxy } = require(process.argv[1]);
      runLocalHandshakeProxy({
        root: process.argv[3],
        getDaemonSocket: () => new Promise(resolve => {
          const socket = net.createConnection(process.argv[2], () => resolve(socket));
        }),
        makeEngine: () => ({ ensureInitialized: async () => {}, stop: () => {},
          getToolHandler: () => ({ execute: async name => ({ content: [{ type: 'text', text: 'local:' + name }] }) }) })
      });
    `;
    const child = spawn(process.execPath, ['-e', script, path.resolve(__dirname, '../dist/mcp/proxy.js'), socketPath, root], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1' },
    });
    try {
      const replies = new Map<number, any>();
      const response = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('代理未回复断线请求')), 20_000);
        let output = '';
        child.once('error', reject);
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          let end: number;
          while ((end = output.indexOf('\n')) >= 0) {
            const message = JSON.parse(output.slice(0, end));
            output = output.slice(end + 1);
            replies.set(message.id, message);
          }
          if (replies.has(2) && replies.has(3)) { clearTimeout(timer); resolve(); }
        });
      });
      child.stderr.resume();
      child.stdin.write([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_edit', arguments: { apply: true } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codegraph_explore', arguments: { query: 'Widget' } } },
      ].map((request) => JSON.stringify(request)).join('\n') + '\n');
      await response;
      expect(received).toEqual(['codegraph_edit', 'codegraph_explore']);
      expect(replies.get(2).error.message).toContain('not replayed');
      expect(replies.get(2).result).toBeUndefined();
      expect(replies.get(3).result.content[0].text).toBe('local:codegraph_explore');
    } finally {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      if (child.exitCode === null && child.signalCode === null) await exited;
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
