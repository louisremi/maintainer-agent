/** Labels the server uses on every watched repository. */
export const Labels = {
  /** A maintainer asks for a change to be proposed for this issue. */
  fix: 'agent-fix',
  /** Never act automatically on this issue or change request. */
  optOut: 'no-agent',
  /** A maintainer asks for a fresh review of this change request. */
  rereview: 'agent-rereview',
  /** A job is working on this issue. */
  inProgress: 'agent-in-progress',
  /** The agent gave up or its output was held back: a human should look. */
  needsHuman: 'needs-human',
} as const;

export interface LabelDefinition {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export const LABEL_DEFINITIONS: readonly LabelDefinition[] = [
  { name: Labels.fix, color: 'D93F0B', description: 'maintainer-agent: propose a change for this issue' },
  { name: Labels.optOut, color: 'C5DEF5', description: 'maintainer-agent never acts on this automatically' },
  { name: Labels.rereview, color: '5319E7', description: 'maintainer-agent: review this change again' },
  { name: Labels.inProgress, color: 'FBCA04', description: 'maintainer-agent is working on it' },
  { name: Labels.needsHuman, color: 'B60205', description: 'maintainer-agent gave up or held its output: please look' },
];

/** Hidden markers identifying what the server posted (never produced by agents). */
export const Markers = {
  answer: '<!-- maintainer-agent:answer v2 -->',
  fix: '<!-- maintainer-agent:fix v2 -->',
  review: '<!-- maintainer-agent:review v2 -->',
} as const;
