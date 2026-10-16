import { test, expect, mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// 15 Oct 2026, 12:00 UTC: midday, so the local date is the 15th in any time zone from UTC-11 to UTC+11.
const NOW = Date.UTC(2026, 9, 15, 12, 0)

const RATE_LIMITS = [
  { kind: 'seven_day', percentUsed: 13, resetsAt: new Date(NOW + (6 * 24 + 5) * 3_600_000).toISOString() },
  { kind: 'five_hour', percentUsed: 23, resetsAt: new Date(NOW + 52 * 60_000).toISOString() },
]

type Engine = Parameters<TestBody>[0]

async function seed($: Engine, on: On) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    changed: [],
    context: { window: 200_000, tokens: 22_000, percent: 11 },
    rateLimits: RATE_LIMITS,
    cost: { usd: 8.99 },
  })
}

const svgOf = async (ui: { find: (q: { type: 'Svg' }) => Promise<unknown> }) => JSON.stringify(await ui.find({ type: 'Svg' }))

test('with no usage yet the band leaves the app its own drawing', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine</Text>
  })
  const ui = await $.ui.mount({ plugin: 'usage-strip', surface: 'desktop', ...BAND })
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await ui.unmount()
})

test('desktop: context and limits as columns; no cycle until a renewal day is set', async ($, on) => {
  await seed($, on)
  const ui = await $.ui.mount({ plugin: 'usage-strip', surface: 'desktop', ...BAND })

  const full = await svgOf(ui)
  expect(full).toMatch(/Context: 11% \(22k of 200k\)/)
  expect(full).toMatch(/Session · 5h: 23%, resets in 52m/)
  expect(full).toMatch(/Weekly · 7d: 13%, resets in 6d 5h/)
  expect(full).toMatch(/\$8\.99/)
  expect(full).not.toMatch(/Cycle/)
  await ui.unmount()
})

test('desktop: Settings picks the renewal day and the cycle appears', async ($, on) => {
  await seed($, on)
  const ui = await $.ui.mount({ plugin: 'usage-strip', surface: 'desktop', ...BAND })

  await ui.press({ key: 'settings' })
  await ui.select({ key: 'renewal', value: '13' })
  expect(await ui.find({ key: 'renewal' })).toBeUndefined()
  expect(await svgOf(ui)).toMatch(/Cycle: 29 days left, renews Nov 13/)

  await ui.press({ key: 'settings' })
  await ui.select({ key: 'renewal', value: '0' })
  expect(await svgOf(ui)).not.toMatch(/Cycle/)
  await ui.unmount()
})

test('a renewal day of 31 lands on the last day of short months', async ($, on) => {
  await seed($, on)
  const ui = await $.ui.mount({ plugin: 'usage-strip', surface: 'desktop', ...BAND })
  await ui.press({ key: 'settings' })
  await ui.select({ key: 'renewal', value: '31' })
  // From 30 Sep (September has 30 days) to 31 Oct.
  expect(await svgOf(ui)).toMatch(/Cycle: 16 days left, renews Oct 31/)
  await ui.unmount()
})

test('desktop: Hide folds the columns into one line and Show brings them back', async ($, on) => {
  await seed($, on)
  const ui = await $.ui.mount({ plugin: 'usage-strip', surface: 'desktop', ...BAND })
  await ui.press({ key: 'settings' })
  await ui.select({ key: 'renewal', value: '13' })

  expect(await svgOf(ui)).toMatch(/height=\\"50\\"/)
  expect(JSON.stringify(await ui.find({ key: 'toggle' }))).toMatch(/Hide/)
  await ui.press({ key: 'toggle' })
  const folded = await svgOf(ui)
  expect(folded).toMatch(/height=\\"20\\"/)
  expect(folded).toMatch(/29d</)
  expect(JSON.stringify(await ui.find({ key: 'toggle' }))).toMatch(/Show/)
  await ui.press({ key: 'toggle' })
  expect(await svgOf(ui)).toMatch(/height=\\"50\\"/)
  await ui.unmount()
})

test('terminal: controls stay visible and fold the row too', async ($, on) => {
  await seed($, on)
  const ui = await $.ui.mount({ plugin: 'usage-strip', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /↻ 52m/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /22k\/200k/ })).toBeDefined()
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ type: 'Text', text: /Context 11% {3}Session 23% {3}Week 13%/ })).toBeDefined()
  await ui.unmount()
})
