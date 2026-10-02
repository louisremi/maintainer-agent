import { DiffSide } from './agent-results';

/**
 * Which lines of which files a unified diff touches, so that review comments
 * can be placed only where the forge accepts them (on lines inside hunks).
 */
export class DiffHunks {
  private constructor(
    private readonly lines: ReadonlyMap<string, { right: ReadonlySet<number>; left: ReadonlySet<number> }>,
    readonly totalChangedLines: number,
  ) {}

  static parse(unifiedDiff: string): DiffHunks {
    const files = new Map<string, { right: Set<number>; left: Set<number> }>();
    let current: { right: Set<number>; left: Set<number> } | null = null;
    let oldLine = 0;
    let newLine = 0;
    let changed = 0;
    let inHunk = false;
    for (const raw of unifiedDiff.split('\n')) {
      if (raw.startsWith('diff --git ')) {
        current = null;
        inHunk = false;
        continue;
      }
      if (!inHunk && raw.startsWith('+++ ')) {
        const path = raw.slice(4).trim();
        if (path !== '/dev/null') {
          const p = path.replace(/^b\//, '');
          current = files.get(p) ?? { right: new Set(), left: new Set() };
          files.set(p, current);
        }
        // "+++ /dev/null" (deletion): keep the file named on the "---" line.
        continue;
      }
      if (!inHunk && raw.startsWith('--- ')) {
        // For deletions the "+++" side is /dev/null; remember the old path.
        const path = raw.slice(4).trim().replace(/^a\//, '');
        if (path !== '/dev/null') {
          const entry = files.get(path) ?? { right: new Set(), left: new Set() };
          files.set(path, entry);
          current = entry;
        }
        continue;
      }
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (h) {
        oldLine = Number(h[1]);
        newLine = Number(h[2]);
        inHunk = true;
        continue;
      }
      if (!inHunk || !current) continue;
      if (raw.startsWith('+')) {
        current.right.add(newLine++);
        changed++;
      } else if (raw.startsWith('-')) {
        current.left.add(oldLine++);
        changed++;
      } else if (raw.startsWith(' ') || raw === '') {
        current.right.add(newLine++);
        current.left.add(oldLine++);
      } else if (raw.startsWith('\\')) {
        // "\ No newline at end of file"
      } else {
        inHunk = false;
      }
    }
    return new DiffHunks(files, changed);
  }

  get files(): string[] {
    return [...this.lines.keys()].sort();
  }

  contains(path: string, line: number, side: DiffSide): boolean {
    const f = this.lines.get(path);
    if (!f) return false;
    return (side === 'RIGHT' ? f.right : f.left).has(line);
  }
}
