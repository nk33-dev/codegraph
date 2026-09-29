/**
 * MCP 协议版本协商：客户端请求的版本受支持就原样返回，否则回落到服务端支持的最新版本。
 * 直接测纯函数，不依赖 dist 构建产物；真实握手路径由 mcp-initialize 等子进程测试覆盖。
 */
import { describe, expect, it } from 'vitest';
import {
  MCPSession,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  negotiateProtocolVersion,
} from '../src/mcp/session';
import type { MCPEngine } from '../src/mcp/engine';
import type { JsonRpcRequest, JsonRpcTransport, MessageHandler } from '../src/mcp/transport';
import { ToolHandler } from '../src/mcp/tools';

/** Drives a real MCPSession through a fake transport: only what `initialize`/`tools/list` touch is stubbed. */
async function handshake(requested: unknown) {
  const results = new Map<string | number, unknown>();
  let handler!: MessageHandler;
  const transport = {
    start: (h: MessageHandler) => { handler = h; },
    stop: () => {},
    send: () => {},
    notify: () => {},
    request: async () => ({}),
    sendResult: (id: string | number, result: unknown) => { results.set(id, result); },
    sendError: () => {},
  } as unknown as JsonRpcTransport;
  const engine = {
    ensureInitialized: async () => {},
    hasDefaultCodeGraph: () => true,
    getToolHandler: () => new ToolHandler(null),
  } as unknown as MCPEngine;
  new MCPSession(transport, engine, { explicitProjectPath: null }).start();
  await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: 't', version: '1' } } } as JsonRpcRequest);
  await handler({ jsonrpc: '2.0', id: 2, method: 'tools/list' } as JsonRpcRequest);
  return results as Map<number, any>;
}

describe('MCPSession handshake', () => {
  it('answers initialize with the negotiated version and lists both default tools as always-load', async () => {
    const results = await handshake('2025-06-18');
    expect(results.get(1).protocolVersion).toBe('2025-06-18');
    const tools = results.get(2).tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
    expect(tools.map((t) => t.name)).toEqual(['codegraph_explore', 'codegraph_edit']);
    for (const tool of tools) expect(tool._meta, tool.name).toEqual({ 'anthropic/alwaysLoad': true });
  });

  it('falls back to the latest supported version for a client from the future', async () => {
    const results = await handshake('2099-01-01');
    expect(results.get(1).protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe('negotiateProtocolVersion', () => {
  it('echoes every supported client version', () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(negotiateProtocolVersion(version)).toBe(version);
    }
  });

  it('falls back to the latest supported version for unknown or malformed requests', () => {
    expect(negotiateProtocolVersion('2099-01-01')).toBe(PROTOCOL_VERSION);
    expect(negotiateProtocolVersion('2023-01-01')).toBe(PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(20241105)).toBe(PROTOCOL_VERSION);
  });

  it('claims the newest entry of the supported list, and the list is ordered oldest first', () => {
    expect(PROTOCOL_VERSION).toBe(SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]);
    expect([...SUPPORTED_PROTOCOL_VERSIONS]).toEqual([...SUPPORTED_PROTOCOL_VERSIONS].sort());
  });
});
