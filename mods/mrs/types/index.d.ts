export type Mr = {
  iid: number
  title: string
  source_branch: string
  author: string
  web_url: string
  draft: boolean
  approved: boolean
  has_conflicts: boolean
  pipeline?: { status: string }
}
export type Group = { project: string; mrs: Mr[] }
export type Mrs = { groups: Group[]; error?: string }
export type Task = {
  repo: string
  branch: string
  title: string
  state: string
  tested?: boolean
  reviewed?: boolean
  mr_status?: { iid: number; pipeline?: { status: string } }
}
export type View = 'mrs' | 'tasks'

declare module 'claude-code' {
  interface PluginState {
    'mr-triage-mrs': { mrs: Mrs; tasks: Task[]; view: View }
  }
}
