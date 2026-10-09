export type Task = {
  repo: string
  branch: string
  title: string
  state: string
  tested?: boolean
  reviewed?: boolean
  mr_status?: { iid: number; pipeline?: { status: string } }
}

declare module 'claude-code' {
  interface PluginState {
    'mr-triage-banner': { task: Task | null }
  }
}
