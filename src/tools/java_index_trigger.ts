import fs from 'node:fs';
import path from 'node:path';
import { indexProject } from './java_indexer.js';

function findJavaProjectRoot(filePath: string): string | null {
  let dir = path.dirname(path.resolve(filePath));
  const root = path.parse(dir).root;

  while (true) {
    const entries = fs.readdirSync(dir);
    const hasBuildFile = entries.some(e =>
      e === 'pom.xml' || e === 'build.gradle' || e === 'build.gradle.kts' || e === 'settings.gradle' || e === 'gradlew'
    );
    if (hasBuildFile) return dir;

    const hasJava = entries.some(e => e.endsWith('.java'));
    const hasSrc = entries.some(e => e === 'src' && fs.statSync(path.join(dir, e)).isDirectory());

    if (hasJava || hasSrc) return dir;

    if (dir === root) break;
    dir = path.dirname(dir);
  }

  return null;
}

export function triggerJavaReindex(filePath: string): string | null {
  if (!filePath.endsWith('.java')) return null;

  try {
    const projectRoot = findJavaProjectRoot(filePath);
    if (!projectRoot) return null;

    const stats = indexProject(projectRoot);
    return `\n📚 Auto-indexed Java project: ${stats.indexed} files indexed, ${stats.skipped} skipped.`;
  } catch {
    return null;
  }
}
