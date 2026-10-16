import { atom, read, update } from 'claude-code'
import type { Register, SessionUsage } from 'claude-code'

import type { Limit, Usage } from '../types'

const usage = atom({ plugin: 'usage-strip', key: 'usage' } as const, null)
const now = atom({ plugin: 'usage-strip', key: 'now' } as const, 0)
// Session values mirrored in $.store so they survive across sessions.
const collapsed = atom({ plugin: 'usage-strip', key: 'collapsed' } as const, false)
const renewalDay = atom({ plugin: 'usage-strip', key: 'renewalDay' } as const, 0)
const settingsOpen = atom({ plugin: 'usage-strip', key: 'settingsOpen' } as const, false)
const COLLAPSED_KEY = 'collapsed'
const RENEWAL_KEY = 'renewalDay'

// Each threshold toasts once when crossed, and again only after dropping below it.
const ALERTS: { kind: string; at: number; text: string }[] = [
  { kind: 'five_hour', at: 80, text: '5-hour limit at 80%' },
  { kind: 'five_hour', at: 95, text: '5-hour limit at 95%: almost out' },
  { kind: 'seven_day', at: 90, text: 'Weekly limit at 90%' },
  { kind: 'context', at: 85, text: 'Context at 85%: compaction is near' },
]

const toUsage = (u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): Usage => ({
  limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  contextPercent: u.context.percent,
  contextTokens: u.context.tokens,
  contextWindow: u.context.window,
  costUsd: u.cost?.usd,
})

const untilReset = (resetsAt: string | undefined, nowMs: number) => {
  if (!resetsAt || !nowMs) return ''
  const mins = Math.max(0, Math.round((Date.parse(resetsAt) - nowMs) / 60000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m`
}

const fired = new Set<string>()

function crossed(u: Usage): string[] {
  const readings = [
    ...u.limits.map(l => ({ kind: l.kind, pct: l.percentUsed })),
    { kind: 'context', pct: u.contextPercent ?? 0 },
  ]
  const out: string[] = []
  for (const a of ALERTS) {
    const pct = readings.find(r => r.kind === a.kind)?.pct ?? 0
    const id = `${a.kind}:${a.at}`
    if (pct >= a.at && !fired.has(id)) {
      fired.add(id)
      out.push(a.text)
    } else if (pct < a.at) {
      fired.delete(id)
    }
  }
  return out
}

// ── Row model: what gets drawn, independent of the surface ──
// Context comes first even though the app shows it in its side panel: that panel
// is often closed, and context is the number that moves on every message.

type Row = { id: string; label: string; short: string; pct: number; reset: string; note: string }

const ACCENT = '#4c8dff'
const WARN = '#f2a93b'
const HOT = '#ef5350'
const tone = (pct: number) => (pct >= 85 ? HOT : pct >= 70 ? WARN : ACCENT)

const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

function rowsFor(u: Usage, nowMs: number): Row[] {
  const order = ['five_hour', 'seven_day']
  const limits: Limit[] = [...u.limits].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  const rows: Row[] = limits.map(l => {
    const reset = untilReset(l.resetsAt, nowMs)
    return {
      id: l.kind,
      label: l.kind === 'five_hour' ? 'Session · 5h' : l.kind === 'seven_day' ? 'Weekly · 7d' : l.kind,
      short: l.kind === 'five_hour' ? 'Session' : l.kind === 'seven_day' ? 'Week' : l.kind,
      pct: l.percentUsed,
      reset,
      note: reset ? `↻ ${reset}` : '',
    }
  })
  if (u.contextPercent !== undefined) {
    const tokens =
      u.contextTokens !== undefined && u.contextWindow ? `${fmtTokens(u.contextTokens)}/${fmtTokens(u.contextWindow)}` : ''
    rows.unshift({ id: 'context', label: 'Context', short: 'Context', pct: u.contextPercent, reset: '', note: tokens })
  }
  return rows
}

// ── Billing cycle ──
// The app reports no renewal date, so the person sets the day of the month once.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type Cycle = { total: number; elapsed: number; remaining: number; next: string }

// Today in the machine's own time zone.
function todayParts(ms: number): { y: number; m: number; d: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(
      new Date(ms),
    )
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
    const y = get('year')
    const m = get('month')
    const d = get('day')
    if (y && m && d) return { y, m: m - 1, d }
  } catch {
    // no Intl: fall back to Date's local fields
  }
  const dt = new Date(ms)
  return { y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate() }
}

const dayNumber = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m, d) / 86_400_000)
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

function cycleFor(nowMs: number, day: number): Cycle | null {
  if (!nowMs || day < 1 || day > 31) return null
  const { y, m, d } = todayParts(nowMs)
  // A 31st renewal falls on the last day of shorter months.
  const anchor = (mm: number) => {
    const date = new Date(Date.UTC(y, mm, 1))
    const yy = date.getUTCFullYear()
    const mo = date.getUTCMonth()
    return { n: dayNumber(yy, mo, Math.min(day, daysIn(yy, mo))), mo }
  }
  const today = dayNumber(y, m, d)
  const thisMonth = anchor(m)
  const [start, end] = today >= thisMonth.n ? [thisMonth, anchor(m + 1)] : [anchor(m - 1), thisMonth]
  const endDay = new Date(end.n * 86_400_000).getUTCDate()
  return {
    total: end.n - start.n,
    elapsed: today - start.n,
    remaining: end.n - today,
    next: `${MONTHS[end.mo]} ${endDay}`,
  }
}

// ── SVG columns for the strip: no boxes (the app already frames the band) ──

const H = 50
const COL = 136
const GAP = 22
const BAR_Y = 43
const SANS = "'Segoe UI Variable Text', 'Segoe UI', -apple-system, system-ui, sans-serif"

// System greys; the light theme flips text and hairlines.
const STYLE =
  `<style>text{font-family:${SANS};font-variant-numeric:tabular-nums}` +
  `.l{fill:#8e8e93;font-size:11.5px}.v{fill:#f2f2f2;font-size:15px;font-weight:600}` +
  `.t{fill:#ffffff;fill-opacity:0.1}.d{stroke:#ffffff;stroke-opacity:0.08}` +
  `@media (prefers-color-scheme: light){.v{fill:#1d1d1f}.t{fill:#000000}.d{stroke:#000000}}</style>`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// One column: small label, big value, a note on the right and the line underneath.
function column(x: number, label: string, value: string, aside: string, line: string): string {
  return (
    `<text x="${x}" y="12" class="l">${esc(label)}</text>` +
    `<text x="${x}" y="33" class="v">${esc(value)}</text>` +
    (aside ? `<text x="${x + COL}" y="33" class="l" text-anchor="end">${esc(aside)}</text>` : '') +
    line
  )
}

function bar(x: number, pct: number): string {
  const p = Math.min(100, Math.max(0, pct))
  const fill = (COL * p) / 100
  return (
    `<rect x="${x}" y="${BAR_Y}" width="${COL}" height="2" rx="1" class="t"/>` +
    (fill > 0 ? `<rect x="${x}" y="${BAR_Y}" width="${fill.toFixed(1)}" height="2" rx="1" fill="${tone(p)}"/>` : '')
  )
}

// One segment per day of the cycle: filled for days gone, empty for days left.
function days(x: number, cycle: Cycle): string {
  const seg = COL / cycle.total
  let out = ''
  for (let i = 0; i < cycle.total; i++) {
    const paint = i < cycle.elapsed ? `fill="${ACCENT}"` : 'class="t"'
    out += `<rect x="${(x + i * seg).toFixed(1)}" y="${BAR_Y}" width="${Math.max(1, seg - 1.5).toFixed(1)}" height="2" rx="1" ${paint}/>`
  }
  return out
}

const divider = (x: number) => `<line x1="${x}" y1="4" x2="${x}" y2="${H - 4}" class="d"/>`

const daysLeft = (n: number) => (n === 1 ? '1 day' : `${n} days`)
const cost = (usd: number | undefined) => (usd !== undefined && usd >= 0.01 ? `$${usd.toFixed(2)}` : '')

function columnsSvg(rows: Row[], cycle: Cycle | null, costUsd: number | undefined) {
  const parts: string[] = []
  let x = 0
  const advance = () => {
    x += COL + GAP
    parts.push(divider(x - GAP / 2))
  }

  for (const row of rows) {
    parts.push(column(x, row.short, `${Math.round(row.pct)}%`, row.note, bar(x, row.pct)))
    advance()
  }

  if (cycle) {
    parts.push(column(x, 'Cycle', daysLeft(cycle.remaining), `↻ ${cycle.next}`, days(x, cycle)))
    advance()
  }

  // On a subscription the cost reads 0: show it only when there is something to show.
  let end = x - GAP
  const txt = cost(costUsd)
  if (txt) {
    parts.push(column(x, 'Cost', txt, '', ''))
    end = x + txt.length * 9
  } else {
    parts.pop() // no divider after the last column
  }

  const W = Math.max(1, Math.ceil(end))
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    STYLE +
    parts.join('') +
    `</svg>`

  return { source, width: W, height: H }
}

// ── Collapsed: one thin SVG line, with air between items and a short bar per limit ──

const LINE_H = 20
const MINI = 32
const ITEM_GAP = 28
// Rough glyph widths, to place text without measuring it.
const CH_LABEL = 7.2
const CH_VALUE = 7.6

function compactSvg(rows: Row[], cycle: Cycle | null, costUsd: number | undefined) {
  const parts: string[] = []
  const mid = LINE_H / 2
  let x = 0
  const item = (label: string, value: string, pct?: number) => {
    parts.push(`<text x="${x}" y="${mid + 4}" class="l">${esc(label)}</text>`)
    x += label.length * CH_LABEL + 6
    parts.push(`<text x="${x}" y="${mid + 4.5}" class="v" style="font-size:13px">${esc(value)}</text>`)
    x += value.length * CH_VALUE
    if (pct !== undefined) {
      const p = Math.min(100, Math.max(0, pct))
      x += 8
      parts.push(`<rect x="${x}" y="${mid - 1}" width="${MINI}" height="2" rx="1" class="t"/>`)
      if (p > 0) parts.push(`<rect x="${x}" y="${mid - 1}" width="${((MINI * p) / 100).toFixed(1)}" height="2" rx="1" fill="${tone(p)}"/>`)
      x += MINI
    }
    x += ITEM_GAP
  }

  for (const row of rows) item(row.short, `${Math.round(row.pct)}%`, row.pct)
  if (cycle) item('Cycle', `${cycle.remaining}d`)
  const txt = cost(costUsd)
  if (txt) item('Cost', txt)

  const W = Math.max(1, Math.ceil(x - ITEM_GAP))
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${LINE_H}" viewBox="0 0 ${W} ${LINE_H}">` +
    STYLE +
    parts.join('') +
    `</svg>`

  return { source, width: W, height: LINE_H }
}

const altFor = (rows: Row[], cycle: Cycle | null) =>
  [
    ...rows.map(
      r =>
        `${r.label}: ${Math.round(r.pct)}%` +
        (r.reset ? `, resets in ${r.reset}` : r.note ? ` (${r.note.replace('/', ' of ')})` : ''),
    ),
    cycle ? `Cycle: ${daysLeft(cycle.remaining)} left, renews ${cycle.next}` : '',
  ]
    .filter(Boolean)
    .join('; ')

// ── Settings: the renewal day ──

const DAY_OPTIONS = [
  { value: '0', label: 'Off' },
  ...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
]

// ── Text bars for the terminal ──

const BAR_WIDTH = 12
const termColor = (pct: number) => (pct >= 85 ? 'red' : pct >= 70 ? 'yellow' : 'blue')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const wasCollapsed = (await $.store.get(COLLAPSED_KEY)) === true
    await update($, collapsed, () => wasCollapsed)
    const day = Number((await $.store.get(RENEWAL_KEY)) ?? 0)
    await update($, renewalDay, () => (Number.isInteger(day) && day >= 0 && day <= 31 ? day : 0))
    const u = toUsage(await $.session.usage())
    await update($, usage, () => u)
    const ms = await $.clock.now()
    await update($, now, () => ms)
    for (const text of crossed(u)) $.ui.toast(text, { timeoutMs: 8000 })
    // Keep the reset countdowns ticking between turns.
    $.clock.every(60_000, () => {
      void $.clock.now().then(t => update($, now, () => t))
    })

    return result
  })

  on('session.measure', async ($, e, next) => {
    const u = toUsage(e)
    await update($, usage, () => u)
    const ms = await $.clock.now()
    await update($, now, () => ms)
    for (const text of crossed(u)) $.ui.toast(text, { timeoutMs: 8000 })

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || !u) return next(e)

    const nowMs = await read($, now)
    const isCollapsed = await read($, collapsed)
    const day = await read($, renewalDay)
    const isSetting = await read($, settingsOpen)
    const rows = rowsFor(u, nowMs)
    const cycle = cycleFor(nowMs, day)
    if (rows.length === 0 && !cycle) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)

    const toggle = () => {
      const fold = !isCollapsed
      void update($, collapsed, () => fold)
      void $.store.set(COLLAPSED_KEY, fold)
    }
    const pickDay = (value: string) => {
      const picked = Number(value)
      void update($, renewalDay, () => picked)
      void $.store.set(RENEWAL_KEY, picked)
      void update($, settingsOpen, () => false)
    }
    const controls = (
      <Box flexDirection="row" gap={2}>
        <Button key="settings" plain onPress={() => void update($, settingsOpen, open => !open)}>
          Settings
        </Button>
        <Button key="toggle" plain onPress={toggle}>
          {isCollapsed ? 'Show' : 'Hide'}
        </Button>
      </Box>
    )
    // The mobile app draws no Select yet: there the day is set from another surface.
    let picker = null
    if (e.surface !== 'mobile') {
      const { Select } = $.ui.resolve(e)
      picker = <Select key="renewal" label="Billing renews on day" options={DAY_OPTIONS} value={String(day)} onSelect={pickDay} />
    }
    const settings = isSetting && (
      <Box key="settings-row" flexDirection="row" gap={2} alignItems="center">
        {picker}
        <Text dimColor>Off hides the cycle.</Text>
        <Button key="done" plain onPress={() => void update($, settingsOpen, () => false)}>
          Done
        </Button>
      </Box>
    )

    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      // As an image with an explicit size: interactive mode opens a white 300×150 frame.
      const art = isCollapsed ? compactSvg(rows, cycle, u.costUsd) : columnsSvg(rows, cycle, u.costUsd)

      // The controls stay hidden until the pointer is over the band; they sit in the corner, moving nothing.
      return (
        <Box flexDirection="column" gap={1}>
          <Box key="band" flexDirection="row" flexGrow={1}>
            <Svg source={art.source} alt={altFor(rows, cycle)} width={art.width} height={art.height} />
            <Box position="absolute" top={0} right={0} display="none" hover={{ display: 'flex' }}>
              {controls}
            </Box>
          </Box>
          {settings}
        </Box>
      )
    }

    // The terminal has no pointer over the band: the controls stay at the end of the row.
    if (isCollapsed) {
      const summary = [...rows.map(r => `${r.short} ${Math.round(r.pct)}%`), cycle ? `Cycle ${cycle.remaining}d` : '']
        .filter(Boolean)
        .join('   ')
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>{summary}</Text>
            {controls}
          </Box>
          {settings}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
            {rows.map(r => {
              const filled = Math.round((Math.min(100, Math.max(0, r.pct)) * BAR_WIDTH) / 100)
              return (
                <Box key={r.id} flexDirection="row" gap={1}>
                  <Text bold>{r.short}</Text>
                  <Text color={termColor(r.pct)}>{'█'.repeat(filled)}</Text>
                  <Text dimColor>{'░'.repeat(BAR_WIDTH - filled)}</Text>
                  <Text>{`${Math.round(r.pct)}%`}</Text>
                  {r.note !== '' && <Text dimColor>{r.note}</Text>}
                </Box>
              )
            })}
            {cycle && (
              <Box key="cycle" flexDirection="row" gap={1}>
                <Text bold>Cycle</Text>
                <Text dimColor>{`${daysLeft(cycle.remaining)} · ↻ ${cycle.next}`}</Text>
              </Box>
            )}
            {cost(u.costUsd) !== '' && <Text dimColor>{cost(u.costUsd)}</Text>}
          </Box>
          {controls}
        </Box>
        {settings}
      </Box>
    )
  })
}
