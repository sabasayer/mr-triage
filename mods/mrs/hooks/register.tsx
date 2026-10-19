import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Group, Mrs, Task, View } from '../types'

const PANE = 'mrs'
const REFRESH_MS = 15_000
const mrs = atom({ plugin: 'mr-triage-mrs', key: 'mrs' } as const, { groups: [] } as Mrs)

const tasks = atom({ plugin: 'mr-triage-mrs', key: 'tasks' } as const, [] as Task[])
const view = atom({ plugin: 'mr-triage-mrs', key: 'view' } as const, 'mrs' as View)

const compact = atom({ plugin: 'mr-triage-mrs', key: 'compact' } as const, false)

const STEPS = ['working', 'in_review', 'released', 'testing', 'done']
const FACE: Record<string, string> = {
  working: '(•_•)',
  in_review: '(•_•)…',
  released: '\\(•‿•)/',
  testing: '(•_•)🔍',
  done: '(^‿^)✔',
  paused: '(-_-)zz',
}

function progress(task: Task) {
  const step = task.state === 'paused' ? task.paused_from ?? 'working' : task.state
  const index = Math.max(0, STEPS.indexOf(step))

  return Math.round((index / (STEPS.length - 1)) * 100)
}

function barText(percent: number, width: number) {
  const filled = Math.round((width * percent) / 100)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const TASK_STATE: Record<string, { label: string; color: string }> = {
  working: { label: 'Working', color: 'yellow' },
  paused: { label: 'Paused', color: 'gray' },
  in_review: { label: 'In review', color: 'blue' },
  released: { label: 'Released', color: 'magenta' },
  testing: { label: 'Testing', color: 'cyan' },
  done: { label: 'Done', color: 'green' },
}

const PIPELINE: Record<string, { icon: string; color: string }> = {
  success: { icon: '●', color: 'green' },
  failed: { icon: '●', color: 'red' },
  running: { icon: '◐', color: 'yellow' },
  pending: { icon: '◐', color: 'yellow' },
}
const NO_PIPELINE = { icon: '○', color: 'gray' }

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

function projectName(project: string) {
  return project.split('/').pop()
}

async function refresh($: EngineInterface, base: string) {
  try {
    const [res, hiddenRes, tasksRes] = await Promise.all([
      $.http.fetch(`${base}/api/mrs`),
      $.http.fetch(`${base}/api/hidden-authors`),
      $.http.fetch(`${base}/api/tasks`),
    ])
    const data = JSON.parse(res.text)
    const hidden = new Set<string>(hiddenRes.ok ? JSON.parse(hiddenRes.text) : [])
    const groups = (data.groups ?? [])
      .map((group: Group) => ({ ...group, mrs: group.mrs.filter(mr => !hidden.has(mr.author)) }))
      .filter((group: Group) => group.mrs.length > 0)
    const openTasks = (tasksRes.ok ? JSON.parse(tasksRes.text).tasks ?? [] : []).filter((t: Task) => t.state !== 'done')
    await update($, mrs, () => ({ groups }))
    await update($, tasks, () => openTasks)
  } catch {
    await update($, mrs, () => ({ groups: [], error: `mr-triage server not reachable at ${base}` }))
  }
}

export const register: Register = (on, options) => {
  let isPolling = false
  const base = `http://localhost:${options?.port ?? 4931}`

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mrs', description: 'Show open MRs and pipeline status' })
    await $.command.register({ name: 'mr-tasks', description: 'Show tracked tasks (run /mrs to switch back)' })

    return next(e)
  })

  for (const [command, name] of [['mrs', 'mrs'], ['mr-tasks', 'tasks']] as const) {
    on('command.run', { command }, async $ => {
      await update($, view, () => name)
      await refresh($, base)
      if (!isPolling) {
        isPolling = true
        $.clock.every(REFRESH_MS, () => refresh($, base))
      }
      await $.ui.open({ id: PANE, title: name === 'mrs' ? 'MRs' : 'Tasks' })

      return { text: `${command} pane opened.` }
    })
  }


  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { groups, error } = await read($, mrs)
    const current = await read($, view)
    const isCompact = await read($, compact)
    const list = await read($, tasks)
    const mrCount = groups.reduce((sum, group) => sum + group.mrs.length, 0)
    const failedCount = groups.reduce((sum, group) => sum + group.mrs.filter(mr => mr.pipeline?.status === 'failed').length, 0)

    const header = (
      <Box flexDirection="row" gap={1}>
        <Button key="mrs" label={`${current === 'mrs' ? '●' : '○'} MRs ${mrCount}`} plain onPress={() => update($, view, () => 'mrs')} />
        <Button key="tasks" label={`${current === 'tasks' ? '●' : '○'} Tasks ${list.length}`} plain onPress={() => update($, view, () => 'tasks')} />
        <Button key="compact" label={isCompact ? 'Expand' : 'Collapse'} plain onPress={() => update($, compact, prev => !prev)} />
      </Box>
    )

    if (error) return <Text color="red">{error}</Text>

    if (isCompact) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>
            {mrCount} MRs{failedCount > 0 ? ` · ${failedCount} failed` : ''} · {list.length} tasks
          </Text>
        </Box>
      )
    }

    if (current === 'tasks') {
      return (
        <Box flexDirection="column">
          {header}
          {list.length === 0 && <Text dimColor>No open tasks.</Text>}
          {list.map(task => {
            const state = TASK_STATE[task.state] ?? { label: task.state, color: 'gray' }
            const linear = linearId(task.title, task.branch)
            const pipeline = PIPELINE[task.mr_status?.pipeline?.status ?? '']

            return (
              <Text wrap="truncate-end">
                <Text color={pipeline?.color ?? NO_PIPELINE.color}>{pipeline?.icon ?? NO_PIPELINE.icon}</Text>
                {linear && <Text color="magenta"> {linear}</Text>}
                {task.mr_status?.iid && <Text bold> !{task.mr_status.iid}</Text>}
                <Text color={state.color}> {FACE[task.state] ?? '(•_•)'}</Text>
                <Text color={task.state === 'paused' ? 'yellow' : 'magenta'}> {barText(progress(task), 7)}</Text>
                <Text dimColor> {String(progress(task)).padStart(3)}%</Text>
                <Text color={state.color}> {state.label}</Text>
                {task.tested && <Text color="green"> ⚗✓</Text>}
                {task.reviewed && <Text color="green"> 🔍✓</Text>}
                {task.crew && (
                  <Text color={task.crew.failed > 0 ? 'red' : task.crew.blocked ? 'yellow' : 'cyan'}>
                    {' '}⚓{task.crew.done}/{task.crew.total}
                    {task.crew.blocked ? ` ⏸${task.crew.blocked}` : ''}
                  </Text>
                )}
                <Text dimColor> {projectName(task.repo)} {shortTitle(task.title)}</Text>
              </Text>
            )
          })}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {groups.length === 0 && <Text dimColor>No MRs.</Text>}
        {groups.map(group => {
          const failed = group.mrs.filter(mr => mr.pipeline?.status === 'failed').length

          return (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold>
                {projectName(group.project)} <Text dimColor>{group.mrs.length}</Text>
                {failed > 0 && <Text color="red"> ●{failed}</Text>}
              </Text>
              {group.mrs.map(mr => {
                const pipeline = PIPELINE[mr.pipeline?.status ?? ''] ?? NO_PIPELINE

                return (
                  <Text wrap="truncate-end" dimColor={mr.draft}>
                    <Text color={pipeline.color}>{pipeline.icon}</Text>
                    {mr.has_conflicts ? <Text color="yellow"> ⚠</Text> : ' '}
                    {mr.approved ? <Text color="green">✔</Text> : ' '} <Text bold>!{mr.iid}</Text>
                    {linearId(mr.title, mr.source_branch) && <Text color="magenta"> {linearId(mr.title, mr.source_branch)}</Text>} <Text dimColor>{shortTitle(mr.title)}</Text>
                  </Text>
                )
              })}
            </Box>
          )
        })}
      </Box>
    )
  })
}
