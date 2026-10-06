export type Check = { script: string; status: 'pending' | 'running' | 'ok' | 'fail'; tail: string }

declare module 'claude-code' {
  interface PluginState {
    'kidmais-gate': { touched: string[]; checks: Check[] }
  }
}
