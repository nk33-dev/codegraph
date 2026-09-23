import * as fs from 'fs';
import * as path from 'path';

const packageRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
  name: string; version: string;
  codegraphDistribution?: { channel: string; repository: string; ref: string };
};

export interface BuildInfo {
  schemaVersion: number;
  distribution: string;
  repository: string | null;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  buildId: string;
}

export interface RuntimeBuildIdentity {
  version: string;
  distribution: 'personal' | 'upstream';
  build: BuildInfo | null;
}

export function readBuildInfo(): BuildInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(packageRoot, 'dist', 'build-info.json'), 'utf8')) as BuildInfo;
    return info.schemaVersion === 1 && typeof info.buildId === 'string' ? info : null;
  } catch { return null; }
}

/** 返回当前进程实际加载的版本与构建身份，不暴露安装路径等环境信息。 */
export function runtimeBuildIdentity(): RuntimeBuildIdentity {
  return {
    version: pkg.version,
    distribution: PERSONAL_DISTRIBUTION ? 'personal' : 'upstream',
    build: readBuildInfo(),
  };
}

export const PERSONAL_DISTRIBUTION = pkg.codegraphDistribution?.channel === 'personal';
export const PERSONAL_REPOSITORY = pkg.codegraphDistribution?.repository ?? 'nk33-dev/codegraph';
export const PERSONAL_INSTALL_SPEC = `github:${PERSONAL_REPOSITORY}#${pkg.codegraphDistribution?.ref ?? 'personal'}`;
export const PERSONAL_UPDATE_COMMAND = `npm pack "${PERSONAL_INSTALL_SPEC}"\nnpm install -g "./${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz"`;

export function personalReleaseAssetUrl(version: string): string {
  const tag = version.startsWith('v') ? version : `v${version}`;
  const packageVersion = tag.slice(1);
  const asset = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${packageVersion}.tgz`;
  return `https://github.com/${PERSONAL_REPOSITORY}/releases/download/${tag}/${asset}`;
}

/** 显示 PATH 中的所有入口，只读文件，不执行可能指向其他安装的命令。 */
function pathCommands(): string[] {
  const names = process.platform === 'win32' ? ['codegraph.ps1', 'codegraph.cmd', 'codegraph.exe', 'codegraph'] : ['codegraph'];
  const found = new Set<string>();
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.resolve(directory.replace(/^"|"$/g, ''), name);
      try { if (fs.statSync(file).isFile()) found.add(file); } catch { /* 跳过不存在的入口。 */ }
    }
  }
  return [...found];
}

export function runtimeInfo() {
  const identity = runtimeBuildIdentity();
  return {
    packageName: pkg.name,
    version: identity.version,
    distribution: identity.distribution,
    packageRoot,
    entry: process.argv[1] ? path.resolve(process.argv[1]) : null,
    node: { version: process.version, executable: process.execPath, platform: process.platform, arch: process.arch },
    build: identity.build,
    pathCommands: pathCommands(),
    viewerAvailable: fs.existsSync(path.join(packageRoot, 'dist', 'viewer', 'index.html')),
    updateCommand: 'codegraph upgrade',
  };
}
