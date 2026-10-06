export type Lembrados = string[]

declare module 'claude-code' {
  interface PluginState {
    'kidmais-docs': { lembrados: Lembrados }
  }
}
