/**
 * 持久化的跨文件编辑事务。
 *
 * 每个事务都位于项目自己的 `.codegraph/edit-transactions/`，因此暂存文件、备份和源码
 * 默认处在同一文件系统。提交前会再次核对设备号；跨卷目标会在写源码前被拒绝。
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../directory';
import { validatePathWithinRoot } from '../utils';
import {
  CodeEditRefusal,
  sha256,
  type CodeEditApplied,
  type CodeEditResult,
  type EditFileOperation,
  type EditFilePreview,
} from './contract';
import { applyTextEdits, detectEol, type InternalTextEdit } from './text-edits';

type TransactionState = 'prepared' | 'committing' | 'committed' | 'indexing' | 'complete'
  | 'rolling_back' | 'rolled_back' | 'recovery_required';

interface TransactionFile {
  filePath: string;
  operation: EditFileOperation;
  movedTo: string | null;
  baseHash: string | null;
  resultHash: string | null;
  stageFile: string | null;
  backupFile: string | null;
  committed: boolean;
  state: 'pending' | 'committed' | 'restored' | 'unchanged' | 'recovery_required';
  recoveryAction: string | null;
}

interface TransactionManifest {
  schemaVersion: 1;
  operationId: string;
  requestHash: string;
  previewHash: string;
  state: TransactionState;
  createdAt: string;
  updatedAt: string;
  files: TransactionFile[];
  result: CodeEditResult;
}

export interface EditRecoveryOutcome {
  operationId: string;
  state: 'rolled_back' | 'committed' | 'recovery_required';
  needsIndexSync: boolean;
  result: CodeEditResult;
}

export class EditTransactionError extends Error {
  constructor(message: string, readonly applied: CodeEditApplied) {
    super(message);
    this.name = 'EditTransactionError';
  }
}

const TRANSACTIONS_DIR = 'edit-transactions';
const LOCK_FILE = 'edit-transactions.lock';

class SimulatedEditInterruption extends Error {}
let faultHook: ((point: string) => void) | null = null;
let operationFaultHook: ((point: string) => void) | null = null;
let deviceHook: ((target: string, device: number, label: string) => number) | null = null;

/** 仅供契约测试模拟进程在持久化边界被终止。 */
export function __setEditTransactionFaultForTests(hook: ((point: string) => void) | null): void {
  faultHook = hook;
}

/** 仅供契约测试模拟可回滚的文件操作失败。 */
export function __setEditTransactionOperationFaultForTests(hook: ((point: string) => void) | null): void {
  operationFaultHook = hook;
}

/** 仅供契约测试模拟目标位于另一文件系统。 */
export function __setEditTransactionDeviceForTests(
  hook: ((target: string, device: number, label: string) => number) | null,
): void {
  deviceHook = hook;
}

function testFault(point: string): void {
  try { faultHook?.(point); } catch (error) {
    const interrupted = new SimulatedEditInterruption(error instanceof Error ? error.message : String(error));
    interrupted.cause = error;
    throw interrupted;
  }
}

function transactionRoot(root: string): string {
  return path.join(getCodeGraphDir(root), TRANSACTIONS_DIR);
}

function transactionDir(root: string, operationId: string): string {
  return path.join(transactionRoot(root), operationId);
}

function manifestPath(root: string, operationId: string): string {
  return path.join(transactionDir(root, operationId), 'manifest.json');
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* 保留原始错误。 */ }
    throw error;
  }
}

function readManifest(filePath: string): TransactionManifest | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<TransactionManifest>;
    if (value.schemaVersion !== 1 || typeof value.operationId !== 'string' || !Array.isArray(value.files)) return null;
    return value as TransactionManifest;
  } catch {
    return null;
  }
}

function saveManifest(root: string, manifest: TransactionManifest): void {
  manifest.updatedAt = new Date().toISOString();
  writeJsonAtomic(manifestPath(root, manifest.operationId), manifest);
}

function cleanupTerminalArtifacts(root: string, manifest: TransactionManifest): void {
  if (manifest.state !== 'complete' && manifest.state !== 'rolled_back') return;
  const directory = transactionDir(root, manifest.operationId);
  try { fs.rmSync(path.join(directory, 'staged'), { recursive: true, force: true }); } catch { /* 下次维护可再清。 */ }
  try { fs.rmSync(path.join(directory, 'backups'), { recursive: true, force: true }); } catch { /* 下次维护可再清。 */ }
  for (const file of manifest.files) {
    file.stageFile = null;
    file.backupFile = null;
  }
  if (manifest.result.applied) {
    for (const file of manifest.result.applied.fileStates) file.backupPath = null;
  }
  saveManifest(root, manifest);
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function withTransactionLock<T>(root: string, action: () => T): T {
  const codegraphDir = getCodeGraphDir(root);
  fs.mkdirSync(codegraphDir, { recursive: true });
  const lockPath = path.join(codegraphDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const raw = fs.readFileSync(lockPath, 'utf-8');
        const owner = JSON.parse(raw) as { pid?: number; createdAt?: number };
        if (typeof owner.pid !== 'number' || !processAlive(owner.pid)) {
          if (fs.readFileSync(lockPath, 'utf-8') === raw) fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (readError) {
        // wx 创建和写入之间锁可能暂时为空；不能把刚创建的锁当成损坏文件抢走。
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        try {
          if (readError instanceof SyntaxError && Date.now() - fs.statSync(lockPath).mtimeMs > 60_000) {
            const current = fs.readFileSync(lockPath, 'utf-8');
            try { JSON.parse(current); } catch {
              fs.rmSync(lockPath, { force: true });
              continue;
            }
          }
        } catch (retryError) {
          if ((retryError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        }
      }
      throw new CodeEditRefusal('another structured edit is currently committing in this project', 'conflict');
    }
    // 事务本身的 EEXIST 是写入失败，不能被获取锁的重试逻辑吞掉后再次执行。
    try { return action(); } finally {
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { pid?: number };
        if (owner.pid === process.pid) fs.rmSync(lockPath, { force: true });
      } catch { /* 锁已被清理。 */ }
    }
  }
  throw new CodeEditRefusal('the structured-edit transaction lock could not be acquired', 'conflict');
}

function toInternalEdits(file: EditFilePreview): InternalTextEdit[] {
  return file.edits.map((edit) => ({
    start: { line: edit.startLine - 1, character: edit.startColumn },
    end: { line: edit.endLine - 1, character: edit.endColumn },
    newText: edit.newText,
  }));
}

function sourcePath(root: string, file: TransactionFile): string {
  const resolved = validatePathWithinRoot(root, file.filePath);
  if (!resolved) throw new CodeEditRefusal(`${file.filePath} is no longer safely inside the project root`, 'conflict');
  return resolved;
}

function destinationPath(root: string, file: TransactionFile): string {
  const relative = file.movedTo ?? file.filePath;
  const resolved = validatePathWithinRoot(root, relative);
  if (!resolved) throw new CodeEditRefusal(`${relative} is no longer safely inside the project root`, 'conflict');
  return resolved;
}

function nearestExistingDirectory(target: string): string {
  let current = path.dirname(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function assertSameDevice(stageRoot: string, target: string, label: string): void {
  const stageDevice = fs.statSync(stageRoot).dev;
  const targetDirectory = nearestExistingDirectory(target);
  const actualTargetDevice = fs.statSync(targetDirectory).dev;
  const targetDevice = deviceHook?.(targetDirectory, actualTargetDevice, label) ?? actualTargetDevice;
  if (stageDevice !== targetDevice) {
    throw new CodeEditRefusal(
      `${label} is on another filesystem; cross-volume structured edits are refused before commit`,
      'rejected',
    );
  }
}

function writeFileAtomic(filePath: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.codegraph-restore-${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf-8', mode });
    if (mode !== undefined) fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* 保留原始错误。 */ }
    throw error;
  }
}

function contentHash(filePath: string): string | null {
  try { return sha256(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
}

function appliedFromManifest(root: string, manifest: TransactionManifest, replayed: boolean): CodeEditApplied {
  const terminal = manifest.state === 'rolled_back' ? 'rolled_back'
    : manifest.state === 'recovery_required' ? 'recovery_required' : 'committed';
  return {
    operationId: manifest.operationId,
    replayed,
    files: manifest.files.filter((file) => file.state === 'committed').map((file) => file.movedTo ?? file.filePath),
    indexSynced: manifest.result.applied?.indexSynced ?? false,
    indexFiles: manifest.result.applied?.indexFiles ?? 0,
    transactionState: terminal,
    fileStates: manifest.files.map((file) => ({
      filePath: file.filePath,
      operation: file.operation,
      state: file.state === 'pending' ? 'unchanged' : file.state,
      backupPath: file.backupFile
        ? path.relative(root, file.backupFile).replace(/\\/g, '/')
        : null,
      recoveryAction: file.recoveryAction,
    })),
    warnings: [],
  };
}

function prepareManifest(
  root: string,
  operationId: string,
  requestHash: string,
  previewHash: string,
  files: EditFilePreview[],
  result: CodeEditResult,
): TransactionManifest {
  const directory = transactionDir(root, operationId);
  if (fs.existsSync(directory)) {
    throw new CodeEditRefusal(`operationId "${operationId}" already has a non-terminal transaction record`, 'conflict');
  }
  fs.mkdirSync(path.join(directory, 'staged'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'backups'), { recursive: true });
  assertSameDevice(directory, root, 'the project root');

  const seenSources = new Set<string>();
  const seenDestinations = new Set<string>();
  const allSources = new Set(files.map((file) => path.resolve(root, file.filePath)));
  const transactionFiles: TransactionFile[] = [];
  for (const [index, file] of files.entries()) {
    const source = path.resolve(root, file.filePath);
    const destination = path.resolve(root, file.movedTo ?? file.filePath);
    if (seenSources.has(source) || seenDestinations.has(destination)) {
      throw new CodeEditRefusal(`${file.filePath}: duplicate source or destination in workspace edit`, 'rejected');
    }
    seenSources.add(source);
    seenDestinations.add(destination);
    if (file.operation === 'rename' && destination !== source && allSources.has(destination)) {
      throw new CodeEditRefusal(
        `${file.movedTo}: a rename destination is also another source in this workspace edit`,
        'rejected',
      );
    }

    const sourceSafe = file.operation === 'create' ? validatePathWithinRoot(root, file.filePath) : sourcePath(root, {
      filePath: file.filePath, operation: file.operation, movedTo: file.movedTo ?? null,
      baseHash: file.baseHash, resultHash: file.resultHash, stageFile: null, backupFile: null,
      committed: false, state: 'pending', recoveryAction: null,
    });
    if (!sourceSafe) throw new CodeEditRefusal(`${file.filePath} is outside the project root`, 'rejected');
    if (file.operation !== 'create' && fs.lstatSync(source).isSymbolicLink()) {
      throw new CodeEditRefusal(`${file.filePath} is a symbolic link; structured edits refuse link targets`, 'rejected');
    }
    const destinationSafe = destinationPath(root, {
      filePath: file.filePath, operation: file.operation, movedTo: file.movedTo ?? null,
      baseHash: file.baseHash, resultHash: file.resultHash, stageFile: null, backupFile: null,
      committed: false, state: 'pending', recoveryAction: null,
    });
    if (file.operation === 'rename' && fs.existsSync(destination)) {
      throw new CodeEditRefusal(`${file.movedTo} appeared after preview; refusing to overwrite it`, 'conflict');
    }
    assertSameDevice(directory, destinationSafe, file.movedTo ?? file.filePath);

    let current = '';
    let mode: number | undefined;
    if (file.operation === 'create') {
      if (fs.existsSync(source)) throw new CodeEditRefusal(`${file.filePath} appeared after preview`, 'conflict');
    } else {
      current = fs.readFileSync(source, 'utf-8');
      mode = fs.statSync(source).mode;
      if (sha256(current) !== file.baseHash) {
        throw new CodeEditRefusal(`${file.filePath} changed after preview; nothing was written`, 'conflict');
      }
    }

    const backupFile = file.operation === 'create' ? null : path.join(directory, 'backups', `${index}.bak`);
    if (backupFile) fs.copyFileSync(source, backupFile);
    let stageFile: string | null = null;
    if (file.operation !== 'delete') {
      const resultText = applyTextEdits(current, toInternalEdits(file), detectEol(current || '\n'));
      if (sha256(resultText) !== file.resultHash) {
        throw new CodeEditRefusal(`${file.filePath}: staged content does not match the preview`, 'error');
      }
      stageFile = path.join(directory, 'staged', `${index}.new`);
      fs.writeFileSync(stageFile, resultText, { encoding: 'utf-8', mode });
      if (mode !== undefined) fs.chmodSync(stageFile, mode);
    }
    transactionFiles.push({
      filePath: file.filePath, operation: file.operation, movedTo: file.movedTo ?? null,
      baseHash: file.baseHash, resultHash: file.resultHash, stageFile, backupFile,
      committed: false, state: 'pending', recoveryAction: null,
    });
  }
  const now = new Date().toISOString();
  const manifest: TransactionManifest = {
    schemaVersion: 1, operationId, requestHash, previewHash, state: 'prepared',
    createdAt: now, updatedAt: now, files: transactionFiles,
    result: { ...result, operationId, applied: null },
  };
  saveManifest(root, manifest);
  return manifest;
}

function commitFile(root: string, file: TransactionFile): void {
  const source = sourcePath(root, file);
  const destination = destinationPath(root, file);
  if (file.operation === 'create') {
    if (fs.existsSync(destination)) throw new CodeEditRefusal(`${file.filePath} appeared during staging`, 'conflict');
  } else {
    if (fs.lstatSync(source).isSymbolicLink() || contentHash(source) !== file.baseHash) {
      throw new CodeEditRefusal(`${file.filePath} changed during staging; refusing to overwrite it`, 'conflict');
    }
    if (file.operation === 'rename' && fs.existsSync(destination)) {
      throw new CodeEditRefusal(`${file.movedTo} appeared during staging`, 'conflict');
    }
  }
  if (file.operation === 'delete') {
    fs.rmSync(source);
  } else if (file.operation === 'rename') {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(file.stageFile!, destination);
    fs.rmSync(source);
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(file.stageFile!, destination);
  }
}

function restoreFile(root: string, file: TransactionFile): void {
  const source = sourcePath(root, file);
  const destination = destinationPath(root, file);
  const expectedResult = file.resultHash;
  // rename 消耗暂存文件；即使进程尚未来得及记录 committed，也能辨别是否已落盘。
  const stagedContentWritten = file.committed || (file.stageFile !== null && !fs.existsSync(file.stageFile));
  if (file.operation === 'create') {
    if (!stagedContentWritten) { file.state = 'unchanged'; return; }
    if (!fs.existsSync(destination)) { file.state = 'unchanged'; return; }
    if (contentHash(destination) !== expectedResult) {
      throw new Error(`${file.movedTo ?? file.filePath} no longer matches the transaction result; remove it manually only after review`);
    }
    fs.rmSync(destination);
    file.state = 'restored';
    return;
  }

  const sourceHash = contentHash(source);
  // 只撤销本事务写出的内容。外部修改、删除或不可读文件都保留，交给恢复清单处理。
  if ((sourceHash !== file.baseHash && sourceHash !== expectedResult && sourceHash !== null)
    || (file.operation === 'modify' && !stagedContentWritten && sourceHash !== file.baseHash)
    || (sourceHash === null && (fs.existsSync(source) || file.operation === 'modify'))
    || (fs.existsSync(source) && fs.lstatSync(source).isSymbolicLink())) {
    throw new Error(`${file.filePath} changed outside this transaction; preserve it and review the retained backup`);
  }
  const removeDestination = file.operation === 'rename' && stagedContentWritten && fs.existsSync(destination);
  if (removeDestination) {
    if (contentHash(destination) !== expectedResult) {
      throw new Error(`${file.movedTo} no longer matches the transaction result; preserve it and restore ${file.filePath} from backup`);
    }
  }
  if (!file.backupFile || !fs.existsSync(file.backupFile)) {
    throw new Error(`backup for ${file.filePath} is missing`);
  }
  const backup = fs.readFileSync(file.backupFile, 'utf-8');
  if (sha256(backup) !== file.baseHash) throw new Error(`backup for ${file.filePath} does not match the original content`);
  const mode = fs.statSync(file.backupFile).mode;
  if (sourceHash !== file.baseHash) writeFileAtomic(source, backup, mode);
  // 原路径成功恢复后再删除移动目标；备份损坏或恢复失败时仍保留提交后的内容。
  if (removeDestination) fs.rmSync(destination);
  file.state = 'restored';
}

function rollback(root: string, manifest: TransactionManifest, cause: string): CodeEditApplied {
  manifest.state = 'rolling_back';
  saveManifest(root, manifest);
  let recoveryRequired = false;
  for (const file of [...manifest.files].reverse()) {
    try {
      restoreFile(root, file);
      file.recoveryAction = null;
    } catch (error) {
      recoveryRequired = true;
      file.state = 'recovery_required';
      file.recoveryAction = error instanceof Error ? error.message : String(error);
    }
    saveManifest(root, manifest);
  }
  manifest.state = recoveryRequired ? 'recovery_required' : 'rolled_back';
  const applied = appliedFromManifest(root, manifest, false);
  applied.transactionState = recoveryRequired ? 'recovery_required' : 'rolled_back';
  applied.warnings.push(
    recoveryRequired
      ? `The edit failed (${cause}) and automatic rollback was incomplete; follow fileStates[].recoveryAction using the retained backups.`
      : `The edit failed (${cause}); every committed file was restored from the transaction backups.`,
  );
  manifest.result.status = 'error';
  manifest.result.applied = applied;
  manifest.result.warnings.push(...applied.warnings);
  saveManifest(root, manifest);
  cleanupTerminalArtifacts(root, manifest);
  return applied;
}

export function applyEditTransaction(
  root: string,
  operationId: string,
  requestHash: string,
  previewHash: string,
  files: EditFilePreview[],
  result: CodeEditResult,
): CodeEditApplied {
  return withTransactionLock(root, () => {
    const replay = readRecordedEdit(root, operationId, requestHash);
    if (replay) return { ...replay.applied!, replayed: true };

    const directory = transactionDir(root, operationId);
    const existed = fs.existsSync(directory);
    let manifest: TransactionManifest;
    try {
      manifest = prepareManifest(root, operationId, requestHash, previewHash, files, result);
    } catch (error) {
      if (!existed) {
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* 暂存残留不覆盖原始错误。 */ }
      }
      throw error;
    }
    testFault('after-prepare');
    manifest.state = 'committing';
    saveManifest(root, manifest);
    try {
      for (const [index, file] of manifest.files.entries()) {
        operationFaultHook?.(`before-commit:${index}`);
        commitFile(root, file);
        file.committed = true;
        file.state = 'committed';
        saveManifest(root, manifest);
        testFault(`after-commit:${index}`);
      }
      manifest.state = 'committed';
      const applied = appliedFromManifest(root, manifest, false);
      manifest.result.status = 'applied';
      manifest.result.applied = applied;
      saveManifest(root, manifest);
      return applied;
    } catch (error) {
      if (error instanceof SimulatedEditInterruption) throw error;
      const cause = error instanceof Error ? error.message : String(error);
      const applied = rollback(root, manifest, cause);
      throw new EditTransactionError(`transaction ${operationId} failed while committing: ${cause}`, applied);
    }
  });
}

export function markEditTransactionIndexing(root: string, operationId: string): void {
  const manifest = readManifest(manifestPath(root, operationId));
  if (!manifest || manifest.state !== 'committed') return;
  manifest.state = 'indexing';
  saveManifest(root, manifest);
}

export function completeEditTransaction(root: string, operationId: string, result: CodeEditResult): void {
  const manifest = readManifest(manifestPath(root, operationId));
  if (!manifest) return;
  manifest.state = result.applied?.transactionState === 'recovery_required' ? 'recovery_required'
    : result.applied?.transactionState === 'rolled_back' ? 'rolled_back' : 'complete';
  manifest.result = result;
  saveManifest(root, manifest);
  cleanupTerminalArtifacts(root, manifest);
}

export function readRecordedEdit(
  root: string,
  operationId: string,
  requestHash: string,
  expectPreviewHash?: string,
): CodeEditResult | null {
  const manifest = readManifest(manifestPath(root, operationId));
  if (!manifest) return null;
  if (manifest.requestHash !== requestHash) {
    throw new CodeEditRefusal(`operationId "${operationId}" belongs to a different edit request`, 'conflict');
  }
  if (expectPreviewHash !== undefined && manifest.previewHash !== expectPreviewHash) {
    throw new CodeEditRefusal(
      `expectPreviewHash does not match the recorded preview for operationId "${operationId}"`,
      'conflict',
    );
  }
  if (!['complete', 'rolled_back', 'recovery_required'].includes(manifest.state)) return null;
  const result = structuredClone(manifest.result);
  if (result.applied) result.applied.replayed = true;
  result.warnings.push(`operationId "${operationId}" was already terminal; returning its recorded result without writing again.`);
  return result;
}

/**
 * 恢复中断于暂存/部分提交的事务。已经完整提交但尚未刷新索引的事务会保留提交结果，
 * 由异步打开路径刷新索引后调用 completeEditTransaction 完成记录。
 */
export function recoverPendingEditTransactions(root: string): EditRecoveryOutcome[] {
  if (!fs.existsSync(transactionRoot(root))) return [];
  try {
    return withTransactionLock(root, () => {
      const outcomes: EditRecoveryOutcome[] = [];
      for (const entry of fs.readdirSync(transactionRoot(root), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(transactionRoot(root), entry.name);
        const manifest = readManifest(path.join(directory, 'manifest.json'));
        if (!manifest) {
          // manifest 之前只会写事务目录内的暂存/备份，不会碰源码，可直接清理。
          try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* 下次启动重试。 */ }
          continue;
        }
        if (['complete', 'rolled_back', 'recovery_required'].includes(manifest.state)) continue;
        if (manifest.state === 'committed' || manifest.state === 'indexing') {
          const applied = appliedFromManifest(root, manifest, false);
          manifest.result.status = 'applied';
          manifest.result.applied = applied;
          manifest.result.warnings.push('Recovered a fully committed edit whose index refresh was interrupted.');
          saveManifest(root, manifest);
          outcomes.push({ operationId: manifest.operationId, state: 'committed', needsIndexSync: true, result: manifest.result });
          continue;
        }
        const applied = rollback(root, manifest, 'the previous process stopped before the transaction completed');
        outcomes.push({
          operationId: manifest.operationId,
          state: applied.transactionState === 'recovery_required' ? 'recovery_required' : 'rolled_back',
          needsIndexSync: false,
          result: manifest.result,
        });
      }
      return outcomes;
    });
  } catch (error) {
    // 另一个活跃写入者持锁时不能把它当成崩溃事务；本次打开继续，下次启动再检查。
    if (error instanceof CodeEditRefusal && error.status === 'conflict') return [];
    throw error;
  }
}
