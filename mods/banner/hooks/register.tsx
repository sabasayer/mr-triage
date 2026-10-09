import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Task } from '../types'

const REFRESH_MS = 15_000

const PIPELINE: Record<string, { icon: string; color: string }> = {
  success: { icon: '●', color: 'green' },
  failed: { icon: '●', color: 'red' },
  running: { icon: '◐', color: 'yellow' },
  pending: { icon: '◐', color: 'yellow' },
}
const task = atom({ plugin: 'mr-triage-banner', key: 'task' } as const, null as Task | null)

const TASK_STATE: Record<string, { label: string; color: string }> = {
  working: { label: 'Working', color: 'yellow' },
  in_review: { label: 'In review', color: 'blue' },
  released: { label: 'Released', color: 'magenta' },
  testing: { label: 'Testing', color: 'cyan' },
  done: { label: 'Done', color: 'green' },
}

function shortTitle(title: string) {
  return title
    .replace(/^\w+(\([^)]*\))?!?: /, '')
    .replace(/^(update|bump) (dependency )?/, '')
    .replace(/ #[A-Z]+-\d+$/, '')
}

function linearId(title: string, branch: string) {
  const fromTitle = title.match(/\b([A-Z]{2,}-\d+)\b/)?.[1]
  if (fromTitle) return fromTitle

  return branch.match(/^([a-z]{2,}-\d+)-/i)?.[1]?.toUpperCase()
}

async function currentBranch($: EngineInterface) {
  const [remote, branch] = await Promise.all([
    $.process.run(['git', 'remote', 'get-url', 'origin']),
    $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD']),
  ])
  if (remote.exitCode !== 0 || branch.exitCode !== 0) return null

  const repo = remote.stdout
    .trim()
    .replace(/\.git$/, '')
    .replace(/^(https?:\/\/[^/]+\/|git@[^:]+:)/, '')

  return { repo, branch: branch.stdout.trim() }
}

async function refreshTask($: EngineInterface, base: string) {
  try {
    const here = await currentBranch($)
    const res = await $.http.fetch(`${base}/api/tasks`)
    const tasks: Task[] = JSON.parse(res.text).tasks ?? []
    const found = here && tasks.find(t => t.repo === here.repo && t.branch === here.branch)
    await update($, task, () => found || null)
  } catch {
    await update($, task, () => null)
  }
}

export const register: Register = (on, options) => {
  const base = `http://localhost:${options?.port ?? 4931}`

  on('session.start', async ($, e, next) => {
    await refreshTask($, base)
    $.clock.every(REFRESH_MS, () => refreshTask($, base))

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, task)
    if (e.props.hasSurvey || !current) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const state = TASK_STATE[current.state] ?? { label: current.state, color: 'gray' }
    const linear = linearId(current.title, current.branch)
    const pipeline = PIPELINE[current.mr_status?.pipeline?.status ?? '']

    return (
      <Box>
        <Text wrap="truncate-end">
          <Text color={state.color} bold>
            ● {state.label}
          </Text>
          {linear && <Text color="magenta"> {linear}</Text>}
          {current.mr_status?.iid && <Text bold> !{current.mr_status.iid}</Text>}
          {pipeline && <Text color={pipeline.color}> {pipeline.icon}</Text>}
          {current.tested && <Text color="green"> tested ✔</Text>}
          {current.reviewed && <Text color="green"> reviewed ✔</Text>}
          <Text dimColor> {shortTitle(current.title)}</Text>
        </Text>
      </Box>
    )
  })
}
