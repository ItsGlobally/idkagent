import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Tool } from './types.js';
import { WORKSPACE_DIR } from '../config.js';

// ─── Types ──────────────────────────────────────────────────────

interface IndexedFile {
  path: string;
  mtime: number;
  sha1: string;
  classes: IndexedClass[];
  methods: IndexedMethod[];
}

interface IndexedClass {
  name: string;
  package: string;
  line_start: number;
  line_end: number;
  modifiers: string;
  superclass: string;
  interfaces: string;
}

interface IndexedMethod {
  name: string;
  class_name: string;
  line_start: number;
  line_end: number;
  return_type: string;
  parameters: string;
  modifiers: string;
  docstring: string;
}

interface ProjectIndex {
  projectRoot: string;
  files: IndexedFile[];
  updatedAt: number;
}

// ─── Index Storage ──────────────────────────────────────────────

function getIndexDir(): string {
  const dir = path.resolve(WORKSPACE_DIR, '.java-index');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function projectKey(projectDir: string): string {
  return crypto.createHash('md5').update(path.resolve(projectDir)).digest('hex');
}

function loadIndex(projectDir: string): ProjectIndex | null {
  const file = path.join(getIndexDir(), `${projectKey(projectDir)}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { return null; }
}

function saveIndex(projectDir: string, index: ProjectIndex): void {
  const file = path.join(getIndexDir(), `${projectKey(projectDir)}.json`);
  fs.writeFileSync(file, JSON.stringify(index, null, 2), 'utf-8');
}

function deleteIndex(projectDir: string): void {
  const file = path.join(getIndexDir(), `${projectKey(projectDir)}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// ─── Java Source Parser (regex-based) ───────────────────────────

function parseJavaSource(source: string, filePath: string): { classes: IndexedClass[]; methods: IndexedMethod[] } {
  const lines = source.split('\n');
  const classes: IndexedClass[] = [];
  const methods: IndexedMethod[] = [];

  // Extract package
  let pkg = '';
  const pkgMatch = source.match(/^\s*package\s+([\w.]+)\s*;/m);
  if (pkgMatch) pkg = pkgMatch[1];

  // Strip string literals and comments to avoid false positives in parsing
  const stripped = source
    .replace(/\/\/.*$/gm, '')           // line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/"([^"\\]|\\.)*"/g, '""'); // string literals

  const strippedLines = stripped.split('\n');

  // Extract class/interface/enum/record declarations
  const classRegex = /(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+|final\s+|sealed\s+|non-sealed\s+)*(?:class|interface|@?interface|enum|record)\s+(\w+)\s*(?:<[^>]*>)?\s*(?:extends\s+(\w+))?\s*(?:implements\s+([\w,\s&]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = classRegex.exec(stripped)) !== null) {
    const classStartLine = source.slice(0, match.index).split('\n').length;
    const className = match[1];
    const superclass = match[2] || '';
    const interfaces = match[3] ? match[3].replace(/\s+/g, ' ').trim() : '';

    // Find modifiers from the context
    const lineBefore = strippedLines[classStartLine - 1] || '';
    const classLine = strippedLines[classStartLine - 1] || '';
    const combinedLine = classLine;
    const mods: string[] = [];
    for (const mod of ['public', 'private', 'protected', 'static', 'abstract', 'final', 'sealed']) {
      if (combinedLine.includes(mod)) mods.push(mod);
    }
    // Collect annotations
    let annotLine = classStartLine - 2;
    while (annotLine >= 0 && strippedLines[annotLine].trim().startsWith('@')) {
      mods.unshift(strippedLines[annotLine].trim());
      annotLine--;
    }

    // Find end line by counting braces
    const bodyStart = source.indexOf('{', match.index);
    if (bodyStart === -1) continue;
    let depth = 1;
    let endIdx = bodyStart + 1;
    while (depth > 0 && endIdx < source.length) {
      if (source[endIdx] === '{') depth++;
      else if (source[endIdx] === '}') depth--;
      endIdx++;
    }
    const classEndLine = source.slice(0, endIdx).split('\n').length;

    const classInfo: IndexedClass = {
      name: className,
      package: pkg,
      line_start: classStartLine,
      line_end: classEndLine,
      modifiers: mods.join(' '),
      superclass,
      interfaces,
    };
    classes.push(classInfo);

    // Extract methods inside this class body
    const bodyContent = source.slice(bodyStart + 1, endIdx - 1);
    const methodRegex = /(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+|final\s+|synchronized\s+|native\s+|default\s+)*(\w+(?:\[\])*(?:<[^>]*>)?)\s+(\w+)\s*\(([^)]*)\)\s*(?:\s*throws\s+[\w,\s]+)?\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = methodRegex.exec(bodyContent)) !== null) {
      const beforeMethod = bodyContent.slice(0, m.index);
      const methodLineOffset = beforeMethod.split('\n').length - 1;
      const methodLine = classInfo.line_start + methodLineOffset;

      const returnType = m[1];
      const methodName = m[2];
      const params = m[3].trim();

      // Find method end
      const localBodyStart = bodyContent.indexOf('{', m.index);
      if (localBodyStart === -1) continue;
      let d = 1;
      let e = localBodyStart + 1;
      while (d > 0 && e < bodyContent.length) {
        if (bodyContent[e] === '{') d++;
        else if (bodyContent[e] === '}') d--;
        e++;
      }
      const methodEndLine = methodLine + bodyContent.slice(m.index, e).split('\n').length - 1;

      // Collect modifiers
      const methodMods: string[] = [];
      const methodSourceLine = (bodyContent.split('\n')[methodLineOffset] || '') + ' ' + methodLine;
      for (const mod of ['public', 'private', 'protected', 'static', 'abstract', 'final', 'synchronized', 'native']) {
        if (methodSourceLine.includes(mod)) methodMods.push(mod);
      }

      // Find docstring (look above in original source)
      const absLineIdx = methodLine - 1;
      let docstring = '';
      let docCheck = absLineIdx - 1;
      while (docCheck >= 0 && lines[docCheck].trim().startsWith('@')) docCheck--;
      if (docCheck >= 0 && lines[docCheck].trim().startsWith('/**')) {
        const docLines: string[] = [];
        for (let i = docCheck; i < absLineIdx; i++) {
          const l = lines[i].replace(/^\s*\*\s?/, '').replace(/\/\*\*|\*\//g, '').trim();
          if (l && !l.startsWith('@')) docLines.push(l);
        }
        docstring = docLines.join(' ').slice(0, 500);
      }

      methods.push({
        name: methodName,
        class_name: className,
        line_start: methodLine,
        line_end: methodEndLine,
        return_type: returnType,
        parameters: `(${params})`,
        modifiers: methodMods.join(' '),
        docstring,
      });
    }
  }

  return { classes, methods };
}

// ─── Indexer ─────────────────────────────────────────────────────

export function indexProject(projectDir: string, force: boolean = false): { scanned: number; indexed: number; skipped: number; errors: number } {
  const root = path.resolve(projectDir);
  if (!fs.existsSync(root)) throw new Error(`Directory not found: ${root}`);

  const existing = loadIndex(root);
  const stats = { scanned: 0, indexed: 0, skipped: 0, errors: 0 };

  const javaFiles = findJavaFiles(root);
  const files: IndexedFile[] = [];

  for (const filePath of javaFiles) {
    stats.scanned++;
    try {
      const relPath = path.relative(root, filePath);
      const stat = fs.statSync(filePath);
      const mtime = stat.mtimeMs;
      const source = fs.readFileSync(filePath, 'utf-8');
      const sha1 = crypto.createHash('sha1').update(source).digest('hex');

      // Check if unchanged
      const existingFile = existing?.files.find(f => f.path === relPath);
      if (!force && existingFile && existingFile.mtime === mtime && existingFile.sha1 === sha1) {
        files.push(existingFile); // Keep existing data
        stats.skipped++;
        continue;
      }

      const parsed = parseJavaSource(source, filePath);
      files.push({
        path: relPath,
        mtime,
        sha1,
        classes: parsed.classes,
        methods: parsed.methods,
      });
      stats.indexed++;
    } catch (e) {
      stats.errors++;
      console.warn(`  ⚠ Error indexing ${filePath}: ${e}`);
    }
  }

  saveIndex(root, { projectRoot: root, files, updatedAt: Date.now() });
  return stats;
}

function findJavaFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'build' || entry.name === '.git') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJavaFiles(fullPath));
      } else if (entry.name.endsWith('.java')) {
        results.push(fullPath);
      }
    }
  } catch { }
  return results;
}

// ─── Query ──────────────────────────────────────────────────────

function queryMethods(
  index: ProjectIndex,
  query: string,
  className?: string,
): IndexedMethod[] {
  const q = query.toLowerCase();
  const results: IndexedMethod[] = [];
  for (const f of index.files) {
    for (const m of f.methods) {
      if (m.name.toLowerCase().includes(q)) {
        if (className && !m.class_name.toLowerCase().includes(className.toLowerCase())) continue;
        results.push(m);
      }
    }
  }
  return results;
}

function queryClasses(
  index: ProjectIndex,
  query: string,
  packageFilter?: string,
): IndexedClass[] {
  const q = query.toLowerCase();
  const results: IndexedClass[] = [];
  for (const f of index.files) {
    for (const c of f.classes) {
      if (c.name.toLowerCase().includes(q)) {
        if (packageFilter && !c.package.toLowerCase().includes(packageFilter.toLowerCase())) continue;
        results.push(c);
      }
    }
  }
  return results;
}

function getClassDetail(index: ProjectIndex, className: string): { class: IndexedClass; methods: IndexedMethod[]; source: string; file: string } | null {
  for (const f of index.files) {
    for (const c of f.classes) {
      if (c.name === className) {
        const fullPath = path.join(index.projectRoot, f.path);
        let source = '(source file not found)';
        try {
          const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
          source = lines.slice(c.line_start - 1, c.line_end).join('\n');
        } catch { }
        return {
          class: c,
          methods: f.methods.filter(m => m.class_name === className),
          source,
          file: f.path,
        };
      }
    }
  }
  return null;
}

function getMethodDetail(index: ProjectIndex, methodName: string, className?: string): { method: IndexedMethod; source: string; file: string }[] {
  const results: { method: IndexedMethod; source: string; file: string }[] = [];
  for (const f of index.files) {
    for (const m of f.methods) {
      if (m.name === methodName && (!className || m.class_name === className)) {
        const fullPath = path.join(index.projectRoot, f.path);
        let source = '(source file not found)';
        try {
          const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
          source = lines.slice(m.line_start - 1, m.line_end).join('\n');
        } catch { }
        results.push({ method: m, source, file: f.path });
      }
    }
  }
  return results;
}

function projectInfo(index: ProjectIndex): { files: number; classes: number; methods: number; project: string } {
  let classes = 0, methods = 0;
  for (const f of index.files) {
    classes += f.classes.length;
    methods += f.methods.length;
  }
  return { files: index.files.length, classes, methods, project: index.projectRoot };
}

// ─── Tools ──────────────────────────────────────────────────────

async function getProjectIndex(projectDir: string): Promise<ProjectIndex> {
  const idx = loadIndex(projectDir);
  if (!idx) {
    throw new Error(`Project not indexed. Run java_index first for: ${projectDir}`);
  }
  return idx;
}

export const javaIndexTool: Tool = {
  name: 'java_index',
  description: 'Index a Java project directory. Scans all .java files, extracts classes and methods with metadata, and stores the index for fast querying. Use this before using java_find_method, java_find_class, java_show_class, or java_show_method. You can re-index to update the index after files change.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Path to the Java project root directory.' },
      force: { type: 'boolean', description: 'If true, re-index all files even if unchanged.' },
    },
    required: ['projectDir'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const projectDir = args.projectDir as string;
    const force = args.force === true;
    const stats = indexProject(projectDir, force);
    return `Indexed ${projectDir}:\n- Scanned: ${stats.scanned}\n- Indexed: ${stats.indexed}\n- Skipped (unchanged): ${stats.skipped}\n- Errors: ${stats.errors}`;
  },
};

export const javaFindMethodTool: Tool = {
  name: 'java_find_method',
  description: 'Search indexed methods by name. Returns matching method names, their class, file path, line numbers, return type, and parameters.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Path to the indexed Java project.' },
      query: { type: 'string', description: 'Method name to search for (partial match).' },
      className: { type: 'string', description: 'Optional class name filter.' },
    },
    required: ['projectDir', 'query'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const idx = await getProjectIndex(args.projectDir as string);
    const results = queryMethods(idx, args.query as string, args.className as string | undefined);
    if (results.length === 0) return 'No methods found.';
    return results.map((m, i) => {
      const filePath = idx.files.find(f => f.methods.includes(m))?.path || '';
      return `${i + 1}. ${m.class_name}.${m.name}${m.parameters} : ${m.return_type}\n   File: ${filePath} (line ${m.line_start})`;
    }).join('\n\n');
  },
};

export const javaFindClassTool: Tool = {
  name: 'java_find_class',
  description: 'Search indexed classes by name. Returns matching class names, package, file path, modifiers, superclass, and interfaces.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Path to the indexed Java project.' },
      query: { type: 'string', description: 'Class name to search for (partial match).' },
      packageFilter: { type: 'string', description: 'Optional package filter.' },
    },
    required: ['projectDir', 'query'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const idx = await getProjectIndex(args.projectDir as string);
    const results = queryClasses(idx, args.query as string, args.packageFilter as string | undefined);
    if (results.length === 0) return 'No classes found.';
    return results.map((c, i) =>
      `${i + 1}. ${c.name}\n   Package: ${c.package}\n   Modifiers: ${c.modifiers}\n   File: ${idx.files.find(f => f.classes.includes(c))?.path} (line ${c.line_start})` +
      (c.superclass ? `\n   Extends: ${c.superclass}` : '') +
      (c.interfaces ? `\n   Implements: ${c.interfaces}` : '')
    ).join('\n\n');
  },
};

export const javaShowClassTool: Tool = {
  name: 'java_show_class',
  description: 'Show full details of a specific class by exact name: source code, methods, modifiers, superclass, interfaces.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Path to the indexed Java project.' },
      className: { type: 'string', description: 'Exact class name to show.' },
    },
    required: ['projectDir', 'className'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const idx = await getProjectIndex(args.projectDir as string);
    const detail = getClassDetail(idx, args.className as string);
    if (!detail) return `Class "${args.className}" not found.`;
    const c = detail.class;
    let out = `Class: ${c.name}\nPackage: ${c.package}\nFile: ${detail.file}\nModifiers: ${c.modifiers}`;
    if (c.superclass) out += `\nExtends: ${c.superclass}`;
    if (c.interfaces) out += `\nImplements: ${c.interfaces}`;
    out += `\n\n=== Methods (${detail.methods.length}) ===\n`;
    for (const m of detail.methods) {
      out += `\n${m.modifiers ? m.modifiers + ' ' : ''}${m.return_type} ${m.name}${m.parameters}`;
    }
    out += `\n\n=== Source (lines ${c.line_start}-${c.line_end}) ===\n${detail.source}`;
    return out;
  },
};

export const javaShowMethodTool: Tool = {
  name: 'java_show_method',
  description: 'Show full source code of a specific method by exact name, optionally filtered by class.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Path to the indexed Java project.' },
      methodName: { type: 'string', description: 'Exact method name to show.' },
      className: { type: 'string', description: 'Optional class name to disambiguate.' },
    },
    required: ['projectDir', 'methodName'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const idx = await getProjectIndex(args.projectDir as string);
    const results = getMethodDetail(idx, args.methodName as string, args.className as string | undefined);
    if (results.length === 0) return `Method "${args.methodName}" not found.`;
    return results.map((r, i) => {
      const m = r.method;
      let out = `Method: ${m.class_name}.${m.name}\nFile: ${r.file} (lines ${m.line_start}-${m.line_end})`;
      out += `\nSignature: ${m.modifiers ? m.modifiers + ' ' : ''}${m.return_type} ${m.name}${m.parameters}`;
      if (m.docstring) out += `\nDoc: ${m.docstring}`;
      out += `\n\n=== Source ===\n${r.source}`;
      return out;
    }).join('\n\n---\n\n');
  },
};

export const javaIndexInfoTool: Tool = {
  name: 'java_index_info',
  description: 'Show index statistics for a Java project: file count, class count, method count.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Path to the indexed Java project.' },
    },
    required: ['projectDir'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const idx = await getProjectIndex(args.projectDir as string);
    const info = projectInfo(idx);
    return `Project: ${info.project}\nFiles: ${info.files}\nClasses: ${info.classes}\nMethods: ${info.methods}`;
  },
};

export const javaIndexClearTool: Tool = {
  name: 'java_index_clear',
  description: 'Delete the index for a Java project, forcing a full re-index next time.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Path to the indexed Java project.' },
    },
    required: ['projectDir'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    deleteIndex(args.projectDir as string);
    return `Index cleared for ${args.projectDir}.`;
  },
};
