import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from './index.ts'
import { PHASES, PHASE_GUIDANCE, PHASE_TITLES } from './state.ts'
import type { PhaseId } from './state.ts'

interface TestAgent {
  id: string
  session: { header: { origin: string } }
  steer: (message: unknown) => void
}
interface Status {
  active: boolean
  completed: PhaseId[]
  remaining: PhaseId[]
}
interface RegisteredTool {
  parameters: { properties: { action: { enum: string[] } } }
  execute: (args: Record<string, unknown>, context: { agent: TestAgent }) => Promise<Status>
}

// 使用真实 apply 和 defineTool；仅用小型容器接收注册项，无需启动模型或服务。
function fixture() {
  let tool: RegisteredTool | undefined
  let contextText: ((context: { agent: TestAgent }) => string) | undefined
  const events = new Map<string, (event: { agent: TestAgent }) => void>()
  const steering: unknown[] = []
  const agent: TestAgent = {
    id: 'researcher', session: { header: { origin: 'user' } },
    steer: message => { steering.push(message) },
  }
  const ctx = {
    systemPrompt: {
      getSectionOrder: () => 0,
      getContextOrder: () => 0,
      section: () => {},
      context: (entry: { text: typeof contextText }) => { contextText = entry.text },
    },
    tools: { register: (entry: RegisteredTool) => { tool = entry } },
    on: (name: string, handler: (event: { agent: TestAgent }) => void) => { events.set(name, handler) },
  }
  apply(ctx as unknown as Parameters<typeof apply>[0])
  assert.ok(tool)
  assert.ok(contextText)
  return {
    tool,
    steering,
    call: (args: Record<string, unknown>) => tool!.execute(args, { agent }),
    context: () => contextText!({ agent }),
    stop: () => {
      const handler = events.get('agent/turn-stopping')
      assert.ok(handler)
      handler({ agent })
    },
  }
}

async function advanceTo(f: ReturnType<typeof fixture>, phase: PhaseId) {
  await f.call({ action: 'start', problem: 'Compute an energy correction' })
  for (const previous of PHASES.slice(0, PHASES.indexOf(phase))) {
    await f.call({ action: 'phase_complete', phase: previous })
  }
}

test('tool progression supplies the guidance of the current phase and permits finishing only at the end', async () => {
  const f = fixture()
  assert.equal(f.context(), '')
  await advanceTo(f, 'understand')
  for (const [index, phase] of PHASES.entries()) {
    const status = await f.call({ action: 'status' })
    assert.equal(status.active, true)
    assert.deepEqual(status.remaining, PHASES.slice(index))
    const context = f.context()
    assert.ok(context.includes(PHASE_GUIDANCE[phase]))
    for (const other of PHASES.filter(item => item !== phase)) {
      assert.ok(!context.includes(PHASE_GUIDANCE[other]))
    }
    f.steering.length = 0
    f.stop()
    assert.equal(f.steering.length, 1)
    await f.call({ action: 'phase_complete', phase })
  }
  const done = await f.call({ action: 'status' })
  assert.equal(done.active, false)
  assert.deepEqual(done.remaining, [])
  f.steering.length = 0
  f.stop()
  assert.equal(f.steering.length, 0)
})

test('a rejected completion leaves the tool state and guidance unchanged', async () => {
  const f = fixture()
  await advanceTo(f, 'plan')
  const before = await f.call({ action: 'status' })
  const context = f.context()
  await assert.rejects(f.call({ action: 'phase_complete', phase: 'execute' }), /cannot complete/)
  assert.deepEqual(await f.call({ action: 'status' }), before)
  assert.equal(f.context(), context)
})

for (const [from, to] of [['execute', 'plan'], ['look_back', 'execute'], ['look_back', 'plan']] as const) {
  test(`tool supports ${from} -> ${to} and updates guidance and the completion guard`, async () => {
    const f = fixture()
    await advanceTo(f, from)
    assert.ok(f.tool.parameters.properties.action.enum.includes('reopen'), 'workflow tool does not expose a reopen action')
    const state = await f.call({ action: 'reopen', phase: to })
    assert.equal(state.active, true)
    assert.deepEqual(state.completed, PHASES.slice(0, PHASES.indexOf(to)))
    assert.deepEqual(state.remaining, PHASES.slice(PHASES.indexOf(to)))
    const status = await f.call({ action: 'status' })
    assert.equal(status.active, true)
    assert.deepEqual(status.completed, state.completed)
    assert.deepEqual(status.remaining, state.remaining)
    assert.ok(f.context().includes(PHASE_GUIDANCE[to]))
    assert.ok(!f.context().includes(PHASE_GUIDANCE[from]))
    f.stop()
    assert.equal(f.steering.length, 1)
    assert.ok(JSON.stringify(f.steering[0]).includes(PHASE_TITLES[to]))
    for (const phase of PHASES.slice(PHASES.indexOf(to))) {
      await f.call({ action: 'phase_complete', phase })
    }
    assert.equal((await f.call({ action: 'status' })).active, false)
    f.steering.length = 0
    f.stop()
    assert.equal(f.steering.length, 0)
  })
}

test('rejected reopen calls leave current progress and guidance unchanged', async () => {
  const f = fixture()
  await advanceTo(f, 'execute')
  const before = await f.call({ action: 'status' })
  const context = f.context()
  for (const phase of [undefined, 'invalid', 'understand', 'execute', 'look_back']) {
    await assert.rejects(f.call({ action: 'reopen', ...(phase === undefined ? {} : { phase }) }))
    assert.deepEqual(await f.call({ action: 'status' }), before)
    assert.equal(f.context(), context)
  }
})

test('reopen requires an active workflow and cannot reactivate a completed one', async () => {
  const f = fixture()
  await assert.rejects(f.call({ action: 'reopen', phase: 'plan' }), /no active research workflow/)
  await advanceTo(f, 'look_back')
  await f.call({ action: 'phase_complete', phase: 'look_back' })
  await assert.rejects(f.call({ action: 'reopen', phase: 'plan' }), /already complete/)
  assert.equal((await f.call({ action: 'status' })).active, false)
})

test('a repeated failed check can reopen another phase through the tool', async () => {
  const f = fixture()
  await advanceTo(f, 'look_back')
  await f.call({ action: 'reopen', phase: 'execute' })
  await f.call({ action: 'phase_complete', phase: 'execute' })
  await f.call({ action: 'reopen', phase: 'plan' })
  await assert.rejects(f.call({ action: 'phase_complete', phase: 'execute' }), /cannot complete/)
  for (const phase of ['plan', 'execute', 'look_back']) {
    await f.call({ action: 'phase_complete', phase })
  }
  assert.equal((await f.call({ action: 'status' })).active, false)
})
