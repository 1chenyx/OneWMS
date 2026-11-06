import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CORE_SRC = join(ROOT, 'packages', 'core', 'src');
const WMS_SRC = join(ROOT, 'packages', 'wms', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function importsOf(file: string): string[] {
  const source = withoutComments(readFileSync(file, 'utf8'));
  const pattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function isPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

function dependencyViolations(
  dir: string,
  isForbidden: (specifier: string) => boolean,
): string[] {
  return sourceFiles(dir).flatMap((file) =>
    importsOf(file)
      .filter(isForbidden)
      .map((specifier) => `${relative(ROOT, file)} -> ${specifier}`),
  );
}

describe('源码依赖边界', () => {
  it('core 不依赖任何上层包', () => {
    const upperPackages = ['@one/wms', '@one/ai', '@one/server', '@one/app'];
    expect(
      dependencyViolations(CORE_SRC, (specifier) =>
        upperPackages.some((name) => isPackage(specifier, name)),
      ),
    ).toEqual([]);
  });

  it('WMS 不依赖 Hono、server、AI 或 app', () => {
    const upperPackages = ['hono', '@one/server', '@one/ai', '@one/app'];
    expect(
      dependencyViolations(WMS_SRC, (specifier) =>
        upperPackages.some((name) => isPackage(specifier, name)),
      ),
    ).toEqual([]);
  });

  it('共享查询不依赖 Hono、ToolContext 或工具层', () => {
    const dir = join(WMS_SRC, 'queries');
    const importViolations = dependencyViolations(
      dir,
      (specifier) => isPackage(specifier, 'hono') || /(?:^|\/)tools(?:\/|$)/.test(specifier),
    );
    const contextViolations = sourceFiles(dir)
      .filter((file) => /\bToolContext\b/.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => `${relative(ROOT, file)} -> ToolContext`);
    expect([...importViolations, ...contextViolations]).toEqual([]);
  });

  it('state 不反向依赖 tools 或 queries', () => {
    expect(
      dependencyViolations(join(WMS_SRC, 'state'), (specifier) =>
        /(?:^|\/)(?:tools|queries)(?:\/|$)/.test(specifier),
      ),
    ).toEqual([]);
  });
});
