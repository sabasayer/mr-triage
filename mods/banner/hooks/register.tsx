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
const crew = atom({ plugin: 'mr-triage-banner', key: 'crew' } as const, null as string | null)

const STEPS = ['working', 'local_testing', 'reviewing', 'in_review', 'released', 'testing', 'done']
const PAUSED = '#e5a04b'
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'
const BODY = '#d97757'
const INK = '#2b2b2b'
const H = 22
const SCALE = 2
const FACE: Record<string, string> = {
  working: '(•_•)',
  local_testing: '(•_•)⚗',
  reviewing: '(•_•)🔍',
  in_review: '(•_•)…',
  released: '\\(•‿•)/',
  testing: '(•_•)🔍',
  done: '(^‿^)✔',
  paused: '(-_-)zz',
}
const task = atom({ plugin: 'mr-triage-banner', key: 'task' } as const, null as Task | null)

const TASK_STATE: Record<string, { label: string; color: string }> = {
  working: { label: 'Working', color: 'yellow' },
  local_testing: { label: 'Local test', color: 'cyan' },
  reviewing: { label: 'Self-review', color: 'blue' },
  paused: { label: 'Paused', color: 'gray' },
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

function progress(t: Task) {
  const step = t.state === 'paused' ? t.paused_from ?? 'working' : t.state
  const index = Math.max(0, STEPS.indexOf(step))

  return Math.round((index / (STEPS.length - 1)) * 100)
}

function barText(percent: number, width: number) {
  const filled = Math.round((width * percent) / 100)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const xml = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

function sprite(state: string, x: number, y: number) {
  const rect = (px: number, py: number, w: number, h: number, fill: string) =>
    `<rect x="${x + px * SCALE}" y="${y + py * SCALE}" width="${w * SCALE}" height="${h * SCALE}" fill="${fill}"/>`
  const parts = [rect(1, 1, 8, 6, BODY), rect(2, 7, 2, 2, BODY), rect(6, 7, 2, 2, BODY)]
  const eyes = () => parts.push(rect(3, 3, 1, 2, INK), rect(6, 3, 1, 2, INK))
  const happyEyes = () => parts.push(rect(3, 4, 1, 1, INK), rect(6, 4, 1, 1, INK), rect(4, 5, 2, 1, INK))

  if (state === 'paused') parts.push(rect(3, 4, 1, 1, INK), rect(6, 4, 1, 1, INK), rect(10, 0, 2, 1, INK), rect(11, 1, 1, 1, INK), rect(10, 2, 2, 1, INK))
  else if (state === 'done') {
    happyEyes()
    parts.push(rect(10, 4, 1, 1, DONE), rect(11, 3, 1, 1, DONE), rect(9, 3, 1, 1, DONE))
  } else if (state === 'released') {
    happyEyes()
    parts.push(rect(0, 0, 1, 3, BODY), rect(9, 0, 1, 3, BODY))
  } else if (state === 'in_review') parts.push(rect(4, 3, 1, 2, INK), rect(7, 3, 1, 2, INK))
  else {
    eyes()
    if (state === 'local_testing') parts.push(rect(10, 2, 1, 2, ACCENT), rect(9, 4, 3, 3, ACCENT))
    if (state === 'reviewing' || state === 'testing') parts.push(rect(9, 2, 3, 3, ACCENT), rect(9, 5, 1, 1, ACCENT))
  }

  return parts.join('')
}

function barSvg(t: Task, width: number, title: string) {
  const percent = progress(t)
  const paused = t.state === 'paused'
  const color = paused ? PAUSED : percent >= 80 ? DONE : ACCENT
  const spriteW = 12 * SCALE + 6
  const barX = spriteW + Math.min(title.length * 7.4, width * 0.45) + 10
  const barW = Math.max(40, width - barX - 40)
  const fill = Math.round((barW * percent) / 100)
  const maxChars = Math.max(6, Math.floor((barX - spriteW - 10) / 7.4))
  const clipped = title.length > maxChars ? `${title.slice(0, maxChars - 1)}…` : title

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">
<style>.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#3a3a3a}}</style>
${sprite(t.state, 0, 2)}
<text class="t" x="${spriteW}" y="15" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="13">${xml(clipped)}</text>
<rect class="k" x="${barX}" y="6" width="${barW}" height="10" rx="5"/>
<rect x="${barX}" y="6" width="${Math.max(fill, paused || percent === 0 ? 0 : 10)}" height="10" rx="5" fill="${color}"/>
<text class="m" x="${width - 4}" y="15" text-anchor="end" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="12">${percent}%</text>
</svg>`
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

async function crewSummary($: EngineInterface, ticket: string) {
  const home = await $.env.get('HOME')
  const root = (await $.env.get('CREW_BOARD_ROOT')) || `${home}/.crew`
  const folders = (await $.fs.list(root).catch(() => []))
    .filter(f => f.kind === 'dir' && (f.name === ticket || f.name.startsWith(`${ticket}-mr`)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (folders.length === 0) return null

  const dir = `${root}/${folders[0].name}`
  const files = (await $.fs.list(dir).catch(() => [])).filter(f => f.name.endsWith('.json'))
  const agents = await Promise.all(
    files.map(async f => {
      try {
        const data = JSON.parse(await $.fs.read(`${dir}/${f.name}`))

        return { role: String(data.role ?? f.name.replace(/\.json$/, '')), state: String(data.state) }
      } catch {
        return { role: f.name, state: 'unreadable' }
      }
    }),
  )
  if (agents.length === 0) return null

  const done = agents.filter(a => a.state === 'done').length
  const running = agents.filter(a => a.state === 'running').length
  const failed = agents.filter(a => a.state === 'failed').length
  const blocked = agents.find(a => a.state === 'blocked')

  return [
    `crew ${done}/${agents.length}`,
    running > 0 && `▶${running}`,
    failed > 0 && `✖${failed}`,
    blocked && `⏸ ${blocked.role}`,
  ]
    .filter(Boolean)
    .join(' ')
}

async function refreshTask($: EngineInterface, base: string) {
  try {
    const here = await currentBranch($)
    const res = await $.http.fetch(`${base}/api/tasks`)
    const tasks: Task[] = JSON.parse(res.text).tasks ?? []
    const found = here && tasks.find(t => t.repo === here.repo && t.branch === here.branch)
    const ticket = found && linearId(found.title, found.branch)?.toLowerCase()
    const summary = ticket ? await crewSummary($, ticket).catch(() => null) : null
    await update($, task, () => found || null)
    await update($, crew, () => summary)
  } catch {
    await update($, task, () => null)
    await update($, crew, () => null)
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

    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const state = TASK_STATE[current.state] ?? { label: current.state, color: 'gray' }
    const linear = linearId(current.title, current.branch)
    const pipeline = PIPELINE[current.mr_status?.pipeline?.status ?? '']
    const percent = progress(current)
    const crewLine = await read($, crew)
    const name = [state.label, linear, crewLine, shortTitle(current.title)].filter(Boolean).join(' · ')

    if ('Svg' in ui) {
      const { Svg } = ui
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 16))

      return <Svg source={barSvg(current, width, name)} alt={`${name}, ${percent}%`} width={width} height={H} />
    }

    return (
      <Box>
        <Text wrap="truncate-end">
          <Text color={state.color} bold>
            {FACE[current.state] ?? '(•_•)'} {state.label}
          </Text>
          <Text color={current.state === 'paused' ? 'yellow' : 'magenta'}> {barText(percent, 10)}</Text>
          <Text dimColor> {percent}%</Text>
          {linear && <Text color="magenta"> {linear}</Text>}
          {crewLine && <Text color="cyan"> ⚓ {crewLine}</Text>}
          {current.mr_status?.iid && <Text bold> !{current.mr_status.iid}</Text>}
          {pipeline && <Text color={pipeline.color}> {pipeline.icon}</Text>}
          <Text dimColor> {shortTitle(current.title)}</Text>
        </Text>
      </Box>
    )
  })
}
