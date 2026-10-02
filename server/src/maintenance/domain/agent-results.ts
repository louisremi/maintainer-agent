import { DomainError } from '../../shared-kernel';

export type IssueKind = 'question' | 'bug' | 'feature' | 'other';
export const ISSUE_KINDS: readonly IssueKind[] = ['question', 'bug', 'feature', 'other'];

/** The agent's classification of an issue and its answer (untrusted until sanitised). */
export class Verdict {
  private constructor(
    readonly kind: IssueKind,
    readonly answer: string,
    /** For bugs and features: what a change would involve. */
    readonly changeSummary: string,
  ) {}

  static of(kind: IssueKind, answer: string, changeSummary = ''): Verdict {
    if (!ISSUE_KINDS.includes(kind)) throw new DomainError(`unknown issue kind: ${kind}`);
    if (!answer.trim()) throw new DomainError('a verdict needs an answer');
    return new Verdict(kind, answer, changeSummary);
  }

  get callsForChange(): boolean {
    return this.kind === 'bug' || this.kind === 'feature';
  }

  withAnswer(answer: string): Verdict {
    return Verdict.of(this.kind, answer, this.changeSummary);
  }
}

/** A change the agent proposes: a patch file plus the change request text. */
export class ProposedChange {
  private constructor(
    /** Opaque reference to the patch produced by the agent run. */
    readonly patchRef: string,
    readonly title: string,
    readonly body: string,
  ) {}

  static of(patchRef: string, title: string, body: string): ProposedChange {
    const t = title.replace(/\s+/g, ' ').trim();
    if (!t) throw new DomainError('a proposed change needs a title');
    return new ProposedChange(patchRef, t.slice(0, 120), body);
  }

  withText(title: string, body: string): ProposedChange {
    return ProposedChange.of(this.patchRef, title, body);
  }
}

export type DiffSide = 'RIGHT' | 'LEFT';

export interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly side: DiffSide;
  readonly body: string;
}

/** The agent's review of a change request. */
export class Review {
  private constructor(readonly summary: string, readonly comments: readonly InlineComment[]) {}

  static of(summary: string, comments: readonly InlineComment[]): Review {
    if (!summary.trim()) throw new DomainError('a review needs a summary');
    for (const c of comments) {
      if (!Number.isInteger(c.line) || c.line < 1) throw new DomainError(`invalid comment line: ${c.line}`);
      if (!c.path || c.path.startsWith('/')) throw new DomainError(`invalid comment path: ${c.path}`);
    }
    return new Review(summary, comments);
  }
}
