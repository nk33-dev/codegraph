/**
 * Configurable fake LSP server (for tests).
 *
 * Implements only the slice of the protocol the tested behaviour needs, with fully
 * deterministic output so assertions stay stable:
 *   initialize / initialized / shutdown / exit / $/cancelRequest
 *   textDocument didOpen / didChange / didClose / publishDiagnostics
 *   definition / references / documentSymbol / diagnostic(pull)
 *
 * Command-line switches:
 *   --log <file>               append one JSON line per received event (tests assert the request sequence)
 *   --pull-diagnostics         declare diagnosticProvider and answer textDocument/diagnostic
 *   --push-diagnostics         publishDiagnostics on didOpen/didChange
 *   --slow-init <ms>           delay the initialize response
 *   --slow-definition <ms>     delay the definition response (timeout tests)
 *   --crash-on <method>        exit immediately on that method (simulated crash)
 *   --crash-after-init         exit right after initialized
 *   --no-document-symbol       do not declare documentSymbolProvider
 *   --probe-server-requests    send server->client requests workspace/configuration /
 *                              workspace/workspaceFolders / window/workDoneProgress/create
 *                              and log the client's answers (the client MUST answer them)
 *   --stderr <text>            write one line to stderr at startup
 *
 * Phase-4 rename switches:
 *   --rename                   declare renameProvider and answer textDocument/rename by replacing
 *                              every whole-word occurrence of the identifier at the position
 *   --rename-null              declare renameProvider but answer null (the server "cannot rename this")
 *   --rename-document-changes  answer with documentChanges instead of changes
 *   --rename-extra <file>      also emit an edit for that absolute path (cross-file rename, or — to
 *                              test the safety check — a path OUTSIDE the project root)
 */
'use strict';

const fs = require('fs');
const { pathToFileURL } = require('url');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
};

const logFile = opt('--log', null);
const pullDiagnostics = flag('--pull-diagnostics');
const pushDiagnostics = flag('--push-diagnostics');
const slowInitMs = Number(opt('--slow-init', '0'));
const slowDefinitionMs = Number(opt('--slow-definition', '0'));
const crashOn = opt('--crash-on', null);
const crashAfterInit = flag('--crash-after-init');
const noDocumentSymbol = flag('--no-document-symbol');
const mixedDiagnostics = flag('--mixed-diagnostics');
const probeRequests = flag('--probe-server-requests');
const stderrText = opt('--stderr', null);
const renameNull = flag('--rename-null');
const renameDocumentChanges = flag('--rename-document-changes');
const renameExtra = opt('--rename-extra', null);
const renameEnabled = flag('--rename') || renameNull || renameExtra !== null;
const fileOperations = flag('--file-operations');

const log = (entry) => {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch {
    /* a logging failure must not change protocol behaviour */
  }
};

if (stderrText) process.stderr.write(stderrText + '\n');

// ---------------------------------------------------------------- framing
let buffer = Buffer.alloc(0);

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf-8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value ?? null });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function request(id, method, params) {
  send({ jsonrpc: '2.0', id, method, params });
}

function drain() {
  for (;;) {
    const separator = buffer.indexOf('\r\n\r\n');
    if (separator < 0) return;
    const header = buffer.slice(0, separator).toString('ascii');
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.slice(separator + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = separator + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.slice(bodyStart, bodyStart + length).toString('utf-8');
    buffer = buffer.slice(bodyStart + length);
    try {
      handle(JSON.parse(body));
    } catch (err) {
      log({ event: 'parse-error', message: String(err) });
    }
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

// ---------------------------------------------------------------- behaviour
const documentText = new Map();

function range() {
  // Real servers point at the symbol NAME, not at the declaration keyword (`export`/`int`),
  // and the fake server does the same — otherwise the enrichment path is not exercised.
  return { start: { line: 0, character: 7 }, end: { line: 0, character: 13 } };
}

function publish(uri, items) {
  notify('textDocument/publishDiagnostics', { uri, diagnostics: items });
}

/**
 * Whole-word replacements of `oldName` with `newName`, one TextEdit per occurrence, with UTF-16
 * character columns (the unit this client negotiates). No occurrence → no edits, which is what a
 * server answers for a symbol it cannot rename.
 */
function renameEdits(text, oldName, newName) {
  const edits = [];
  if (!oldName) return edits;
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`, 'g');
  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      edits.push({
        range: {
          start: { line: lineIndex, character: match.index },
          end: { line: lineIndex, character: match.index + oldName.length },
        },
        newText: newName,
      });
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }
  return edits;
}

function diagnosticsFor(uri, count, message) {
  const items = [];
  for (let index = 0; index < count; index += 1) {
    items.push({
      range: { start: { line: index, character: 2 }, end: { line: index, character: 8 } },
      severity: 1,
      code: `FAKE${index}`,
      source: 'fake-lsp',
      message: `${message} #${index + 1}`,
    });
  }
  return items;
}

/** Server-request reply table: {id: verify(value)}. */
const serverRequestVerifiers = new Map();
let probeOk = true;
let probeOutstanding = 0;
let probeNextId = 9001;
const probeReplies = {};

function probeServerRequests() {
  const check = (method, params, verify) => {
    const id = probeNextId++;
    probeOutstanding += 1;
    serverRequestVerifiers.set(id, (value) => {
      const ok = verify(value);
      if (!ok) probeOk = false;
      probeReplies[method] = { ok, value };
      probeOutstanding -= 1;
      if (probeOutstanding === 0) log({ event: 'serverRequests', ok: probeOk, replies: probeReplies });
    });
    request(id, method, params);
  };
  check('workspace/configuration', { items: [{ section: 'a' }, { section: 'b' }] }, (value) =>
    Array.isArray(value) && value.length === 2 && value.every((entry) => entry === null));
  check('workspace/workspaceFolders', null, (value) =>
    Array.isArray(value) && value.length === 1 && typeof value[0].uri === 'string');
  check('window/workDoneProgress/create', { token: 'fake-progress' }, (value) => value === null);
}

function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    const verify = serverRequestVerifiers.get(message.id);
    if (verify) {
      serverRequestVerifiers.delete(message.id);
      verify(message.result);
    }
    return;
  }

  const { method, params, id } = message;
  log({ event: 'request', method, id: id ?? null, params: params ?? null });

  if (crashOn && method === crashOn) {
    log({ event: 'crash', method });
    process.exit(1);
  }

  switch (method) {
    case 'initialize': {
      const capabilities = {
        textDocumentSync: 1,
        definitionProvider: true,
        referencesProvider: true,
        positionEncoding: 'utf-16',
      };
      if (!noDocumentSymbol) capabilities.documentSymbolProvider = true;
      if (renameEnabled) capabilities.renameProvider = true;
      if (pullDiagnostics) capabilities.diagnosticProvider = { identifier: 'fake', interFileDependencies: false, workspaceDiagnostics: false };
      if (fileOperations) {
        capabilities.workspace = {
          fileOperations: {
            didCreate: { filters: [{ scheme: 'file', pattern: { glob: '**/*' } }] },
            didRename: { filters: [{ scheme: 'file', pattern: { glob: '**/*' } }] },
            didDelete: { filters: [{ scheme: 'file', pattern: { glob: '**/*' } }] },
          },
        };
      }
      const reply = () => result(id, {
        capabilities,
        serverInfo: { name: 'fake-lsp', version: '1.0.0' },
      });
      if (slowInitMs > 0) setTimeout(reply, slowInitMs);
      else reply();
      return;
    }
    case 'initialized':
      if (probeRequests) probeServerRequests();
      if (crashAfterInit) {
        log({ event: 'crash', method: 'initialized' });
        setTimeout(() => process.exit(1), 10);
      }
      return;
    case 'shutdown':
      result(id, null);
      return;
    case 'exit':
      log({ event: 'exit' });
      process.exit(0);
      return;
    case '$/cancelRequest':
      return;
    case 'textDocument/didOpen': {
      const uri = params.textDocument.uri;
      documentText.set(uri, params.textDocument.text);
      if (pushDiagnostics) setTimeout(() => publish(uri, diagnosticsFor(uri, 1, 'fake push diagnostic')), 5);
      return;
    }
    case 'textDocument/didChange': {
      const uri = params.textDocument.uri;
      const change = params.contentChanges[params.contentChanges.length - 1];
      documentText.set(uri, change.text);
      if (pushDiagnostics) setTimeout(() => publish(uri, diagnosticsFor(uri, 2, 'fake push diagnostic after change')), 5);
      return;
    }
    case 'textDocument/didClose':
      documentText.delete(params.textDocument.uri);
      return;
    case 'textDocument/definition': {
      const uri = params.textDocument.uri;
      const reply = () => result(id, [{ uri, range: range() }]);
      if (slowDefinitionMs > 0) setTimeout(reply, slowDefinitionMs);
      else reply();
      return;
    }
    case 'textDocument/references':
      result(id, [
        { uri: params.textDocument.uri, range: { start: { line: 1, character: 4 }, end: { line: 1, character: 9 } } },
        { uri: 'file:///codegraph-external/other.ts', range: { start: { line: 3, character: 1 }, end: { line: 3, character: 5 } } },
      ]);
      return;
    case 'textDocument/rename': {
      if (renameNull) {
        result(id, null);
        return;
      }
      const uri = params.textDocument.uri;
      const text = documentText.get(uri) ?? '';
      const lines = text.split(/\r?\n/);
      const line = lines[params.position.line] ?? '';
      // The identifier at the requested position, found by word boundary the way a real server does.
      let start = params.position.character;
      let end = params.position.character;
      while (start > 0 && /[A-Za-z0-9_$]/.test(line[start - 1])) start -= 1;
      while (end < line.length && /[A-Za-z0-9_$]/.test(line[end])) end += 1;
      const oldName = line.slice(start, end);
      const edits = renameEdits(text, oldName, params.newName);
      const changes = { [uri]: edits };
      if (renameExtra) {
        const extraText = fs.readFileSync(renameExtra, 'utf-8');
        changes[pathToFileURL(renameExtra).href] = renameEdits(extraText, oldName, params.newName);
      }
      if (renameDocumentChanges) {
        result(id, {
          documentChanges: Object.entries(changes).map(([documentUri, documentEdits]) => ({
            textDocument: { uri: documentUri, version: null },
            edits: documentEdits,
          })),
        });
        return;
      }
      result(id, { changes });
      return;
    }
    case 'textDocument/documentSymbol':
      result(id, [
        {
          name: 'Widget',
          kind: 5,
          range: { start: { line: 0, character: 7 }, end: { line: 4, character: 1 } },
          selectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 13 } },
          children: [
            {
              name: 'render',
              kind: 6,
              range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } },
              selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
            },
          ],
        },
        {
          name: 'helper',
          kind: 12,
          range: { start: { line: 5, character: 0 }, end: { line: 5, character: 20 } },
          selectionRange: { start: { line: 5, character: 9 }, end: { line: 5, character: 15 } },
        },
      ]);
      return;
    case 'textDocument/diagnostic': {
      const items = diagnosticsFor(params.textDocument.uri, 1, 'fake pull diagnostic');
      if (mixedDiagnostics) {
        items.push({
          range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } },
          severity: 4,
          code: 'HINT1',
          source: 'fake-lsp',
          message: 'fake hint diagnostic',
        });
      }
      result(id, { kind: 'full', items });
      return;
    }
    default:
      if (id !== undefined) result(id, null);
      return;
  }
}

process.stdin.on('end', () => process.exit(0));
