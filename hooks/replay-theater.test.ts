import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ok = (value: unknown) => ({ value }) as never

function world(on: On) {
  mock.env(on, { OS: 'Windows_NT' })
  on('session.cwd', async () => ok('C:\\repo'))
  on('fs.stat', async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  on('fs.exists', async () => ok(false))
  on('ui.invalidate', async () => ok(undefined))
  on('tool.call', async () => ({ result: { type: 'create' } }) as never)
  on('turn.start', async () => ({ turnId: 't' }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
}

for (const surface of ['desktop', 'terminal'] as const) {
test(`${surface}: a long diff shows "▾ N more lines" in a narrow pane, and pressing it expands the diff`, async ($, on) => {
  world(on)
  const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
  await $.turn.start({ turnId: 't1' } as never)
  await $.tool.call({ tool: 'Write', file_path: 'C:\\repo\\notes.md', content, tool_use_id: 'w1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1, isAborted: false, reason: 'answer', text: 'done' } as never)

  const pane = { plugin: 'replay-theater-ps', surface, component: 'Pane', requestId: 'replay-theater', props: { bodyColumns: 40, title: 'Replay Theater', isFocused: true, placement: 'dock' } as never } as const
  let ui = await $.ui.mount(pane)
  const lines = async () => (await ui.findAll({ type: 'Text' })).map(t => String(t.text)).filter(t => t.startsWith('+ line'))
  expect((await lines()).length).toBe(12)
  const labels = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
  expect(labels).toContain('▾ 18 more lines')
  expect(labels).toEqual(expect.arrayContaining(['◀', '▶', '✕']))
  await ui.press({ key: 'more' })
  await ui.unmount()

  ui = await $.ui.mount(pane)
  expect((await lines()).length).toBe(30)
  expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toContain('▴ show less')
  await ui.unmount()
})
}
