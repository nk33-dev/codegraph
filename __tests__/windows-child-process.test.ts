import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const CHILD_PROCESS_CALLS = new Set([
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'spawn',
  'spawnSync',
]);

function testFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...testFiles(target));
    else if (entry.name.endsWith('.ts')) files.push(target);
  }
  return files;
}

function hasWindowsHideTrue(node: ts.CallExpression): boolean {
  return node.arguments.some((argument) =>
    ts.isObjectLiteralExpression(argument)
    && argument.properties.some((property) =>
      ts.isPropertyAssignment(property)
      && property.name.getText() === 'windowsHide'
      && property.initializer.kind === ts.SyntaxKind.TrueKeyword));
}

function childProcessModule(expression: ts.Expression): string | null {
  let current = expression;
  while (
    ts.isAwaitExpression(current)
    || ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  if (!ts.isCallExpression(current) || current.arguments.length !== 1) return null;
  const argument = current.arguments[0];
  if (!argument || !ts.isStringLiteral(argument)) return null;
  const isRequire = ts.isIdentifier(current.expression) && current.expression.text === 'require';
  const isImport = current.expression.kind === ts.SyntaxKind.ImportKeyword;
  return isRequire || isImport ? argument.text : null;
}

function visibleChildProcesses(filePath: string): string[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const importedCalls = new Set<string>();
  const importedNamespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !CHILD_PROCESS_MODULES.has(String(statement.moduleSpecifier.text))) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) importedNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (CHILD_PROCESS_CALLS.has(element.propertyName?.text ?? element.name.text)) {
          importedCalls.add(element.name.text);
        }
      }
    }
  }


  const collectDynamicImports = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const moduleName = childProcessModule(node.initializer);
      if (moduleName && CHILD_PROCESS_MODULES.has(moduleName)) {
        if (ts.isIdentifier(node.name)) importedNamespaces.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const original = element.propertyName?.getText(sourceFile) ?? element.name.text;
            if (CHILD_PROCESS_CALLS.has(original)) importedCalls.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, collectDynamicImports);
  };
  collectDynamicImports(sourceFile);

  const failures: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const direct = ts.isIdentifier(node.expression) && importedCalls.has(node.expression.text);
      const namespaced = ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && importedNamespaces.has(node.expression.expression.text)
        && CHILD_PROCESS_CALLS.has(node.expression.name.text);
      if ((direct || namespaced) && !hasWindowsHideTrue(node)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        failures.push(`${path.relative(process.cwd(), filePath)}:${line}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return failures;
}

describe('Windows 测试子进程', () => {
  it('所有测试子进程都隐藏控制台窗口', () => {
    const failures = testFiles(__dirname).flatMap(visibleChildProcesses);
    expect(failures, `以下测试调用缺少 windowsHide: true：\n${failures.join('\n')}`).toEqual([]);
  });
});
