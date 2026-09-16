/**
 * LSP subsystem's public exports.
 *
 * Only index.ts / CLI / MCP need to import from here; LSP results themselves are still returned
 * through the unified contract in `src/graph/code-query.ts`.
 */
export {
  LspManager,
  LspUnavailableError,
  defaultJdtlsWorkspaceDir,
  liveLspChildCount,
  normalizeDocumentSymbols,
  normalizeLocations,
  normalizeWorkspaceEdit,
  SERVER_WARMUP_HINT_MS,
  type LspCapabilities,
  type LspDiagnostic,
  type LspLocation,
  type LspManagerOptions,
  type LspPosition,
  type LspRange,
  type LspServerState,
  type LspServerStatus,
  type LspStopReason,
  type LspSymbolNode,
  type LspTextEdit,
  type LspWorkspaceEditOperation,
} from './manager';
export {
  LSP_LEASE_SCHEMA_VERSION,
  LSP_LEASE_STALE_MS,
  acquireLspLease,
  countLiveLspLeases,
  getLspLeaseDir,
  heartbeatLspLease,
  listLiveLspLeases,
  releaseAllLspLeases,
  releaseLspLease,
  type AcquireLspLeaseOptions,
  type LspLeaseRecord,
} from './lease-registry';
export { LspConnection, LspError, parseContentLength } from './protocol';
export {
  DEFAULT_SERVERS,
  LANGUAGES_BY_FAMILY,
  LSP_FAMILIES,
  buildSpawnPlan,
  familyForLanguage,
  languageIdFor,
  resolveExecutable,
  type ExecutableLookup,
  type FamilyDefaults,
  type LspFamily,
} from './servers';
export {
  LSP_CONFIG_FILENAME,
  clearLspConfigCache,
  getLspConfigPath,
  loadLspConfig,
  type LspProjectConfig,
  type LspServerConfig,
} from './config';
export { byteColumnToUtf16Column, lspSymbolKindToNodeKind, queryCodeLsp, symbolNamePosition } from './code-query-lsp';
export { normalizeDriveLetter, pathToUri, uriKey, uriToNormalizedPath, uriToPath } from './uri';
