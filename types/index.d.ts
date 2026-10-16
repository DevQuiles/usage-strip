export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  limits: Limit[]
  contextPercent?: number
  contextTokens?: number
  contextWindow?: number
  costUsd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-strip': {
      usage: Usage | null
      now: number
      collapsed: boolean
      /** Day of the month the subscription renews (1-31); 0 hides the cycle. */
      renewalDay: number
      settingsOpen: boolean
    }
  }
}
