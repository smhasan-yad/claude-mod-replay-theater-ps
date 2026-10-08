export type DiffLine = { op: string; t: string }
export type Step = { tool: string; file: string; diff: DiffLine[]; note: string }

declare module 'claude-code' {
  interface PluginState {
    'replay-theater-ps': { steps: Step[] }
  }
}
