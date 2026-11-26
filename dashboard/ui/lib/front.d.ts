// Types for the UI module a test imports. See grants.d.ts for why.
export interface FrontAgent {
  id: string;
  runsOn?: { provider: string; model?: string };
  front?: { model?: unknown; provider?: string; tools?: string[] };
}
/** "Front: <model> (on <provider>)" for an agent whose soul has a front, else undefined. */
export const frontLine: (agent: FrontAgent | undefined) => string | undefined;
