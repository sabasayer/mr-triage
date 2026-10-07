import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Group, Mrs } from '../types'

const PANE = 'mrs'
const REFRESH_MS = 15_000
const mrs = atom({ plugin: 'mr-triage-mrs', key: 'mrs' } as const, { groups: [] } as Mrs)

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
    const [res, hiddenRes] = await Promise.all([
      $.http.fetch(`${base}/api/mrs`),
      $.http.fetch(`${base}/api/hidden-authors`),
    ])
    const data = JSON.parse(res.text)
    const hidden = new Set<string>(hiddenRes.ok ? JSON.parse(hiddenRes.text) : [])
    const groups = (data.groups ?? [])
      .map((group: Group) => ({ ...group, mrs: group.mrs.filter(mr => !hidden.has(mr.author)) }))
      .filter((group: Group) => group.mrs.length > 0)
    await update($, mrs, () => ({ groups }))
  } catch {
    await update($, mrs, () => ({ groups: [], error: `mr-triage server not reachable at ${base}` }))
  }
}

export const register: Register = (on, options) => {
  let isPolling = false
  const base = `http://localhost:${options?.port ?? 4931}`

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mrs', description: 'Show open MRs and pipeline status' })

    return next(e)
  })

  on('command.run', { command: 'mrs' }, async $ => {
    await refresh($, base)
    if (!isPolling) {
      isPolling = true
      $.clock.every(REFRESH_MS, () => refresh($, base))
    }
    await $.ui.open({ id: PANE, title: 'MRs' })

    return { text: 'MR pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const { groups, error } = await read($, mrs)

    if (error) return <Text color="red">{error}</Text>

    return (
      <Box flexDirection="column">
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
