import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PHASES, completeWorkflowPhase, isWorkflowComplete, nextPhase, startWorkflow, reopenWorkflowPhase } from './state.ts'
import type { PhaseId, WorkflowState } from './state.ts'

// 当前阶段尚未完成：不能先把失败的阶段标记成功，再回退。
function atPhase(phase: PhaseId): WorkflowState {
  let state = startWorkflow('Compute a perturbative energy correction')
  for (const previous of PHASES.slice(0, PHASES.indexOf(phase))) {
    state = completeWorkflowPhase(state, previous)
  }
  return state
}

test('start identifies the problem and requires understanding first', () => {
  const state = startWorkflow('  Compute an energy correction  ')
  assert.equal(state.problem, 'Compute an energy correction')
  assert.deepEqual(state.completed, [])
  assert.equal(nextPhase(state), 'understand')
  assert.equal(isWorkflowComplete(state), false)
  assert.throws(() => startWorkflow('   '), /non-empty/)
})

test('each phase must finish before the next, and only looking back completes the workflow', () => {
  let state = atPhase('understand')
  for (const [index, phase] of PHASES.entries()) {
    assert.equal(nextPhase(state), phase)
    assert.equal(isWorkflowComplete(state), false)
    for (const later of PHASES.slice(index + 1)) {
      assert.throws(() => completeWorkflowPhase(state, later), /cannot complete/)
    }
    state = completeWorkflowPhase(state, phase)
    assert.throws(() => completeWorkflowPhase(state, phase), /already complete/)
  }
  assert.equal(nextPhase(state), undefined)
  assert.equal(isWorkflowComplete(state), true)
})

test('invalid phase IDs are rejected without changing progress', () => {
  const state = atPhase('understand')
  assert.throws(() => completeWorkflowPhase(state, 'invalid' as PhaseId), /unknown phase/)
  assert.throws(() => reopenWorkflowPhase(state, 'invalid' as PhaseId), /unknown phase/)
  assert.deepEqual(state.completed, [])
})

const feedbackEdges: Array<{ from: PhaseId; to: PhaseId }> = [
  { from: 'execute', to: 'plan' },
  { from: 'look_back', to: 'execute' },
  { from: 'look_back', to: 'plan' },
]

for (const { from, to } of feedbackEdges) {
  test(`active ${from} can return to ${to} and then finish the revised workflow`, () => {
    const before = atPhase(from)
    const snapshot = structuredClone(before)
    let state = reopenWorkflowPhase(before, to)
    const retained = PHASES.slice(0, PHASES.indexOf(to))
    assert.equal(state.problem, before.problem)
    assert.equal(nextPhase(state), to)
    assert.deepEqual(state.completed, retained)
    assert.equal(isWorkflowComplete(state), false)
    assert.deepEqual(before, snapshot, 'a transition must not alter the previous snapshot')
    for (const later of PHASES.slice(PHASES.indexOf(to) + 1)) {
      assert.throws(() => completeWorkflowPhase(state, later), /cannot complete/)
    }
    for (const phase of PHASES.slice(PHASES.indexOf(to))) {
      assert.equal(isWorkflowComplete(state), false)
      state = completeWorkflowPhase(state, phase)
    }
    assert.equal(isWorkflowComplete(state), true)
    assert.equal(nextPhase(state), undefined)
  })
}

for (const from of PHASES) {
  for (const to of PHASES) {
    if (feedbackEdges.some(edge => edge.from === from && edge.to === to)) continue
    test(`rejects the unlisted transition ${from} -> ${to}`, () => {
      const state = atPhase(from)
      const snapshot = structuredClone(state)
      assert.throws(() => reopenWorkflowPhase(state, to), /not allowed/)
      assert.deepEqual(state, snapshot)
    })
  }
}

test('a second check can require another revision without starting a new problem', () => {
  let state = atPhase('look_back')
  state = reopenWorkflowPhase(state, 'execute')
  state = completeWorkflowPhase(state, 'execute')
  assert.equal(nextPhase(state), 'look_back')
  state = reopenWorkflowPhase(state, 'plan')
  assert.equal(nextPhase(state), 'plan')
  assert.deepEqual(state.completed, ['understand'])
  for (const phase of ['plan', 'execute', 'look_back'] as const) {
    state = completeWorkflowPhase(state, phase)
  }
  assert.equal(isWorkflowComplete(state), true)
})

test('a completed workflow has no active phase from which to reopen', () => {
  const state = completeWorkflowPhase(atPhase('look_back'), 'look_back')
  for (const phase of PHASES) {
    assert.throws(() => reopenWorkflowPhase(state, phase), /not allowed/)
  }
  assert.equal(isWorkflowComplete(state), true)
})
