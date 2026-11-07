/**
 * Pure workflow state and transitions for the Researchly plugin.
 *
 * Keeping this logic free of Cordis makes the phase gates easy to test and
 * easy to reason about: each function receives a snapshot and returns the next
 * snapshot instead of mutating shared state.
 *
 * @module dsh-researchly/state
 */

export const PHASES = ['understand', 'plan', 'execute', 'look_back'] as const

export type PhaseId = typeof PHASES[number]

export interface WorkflowState {
  readonly problem: string
  readonly completed: readonly PhaseId[]
}

export const PHASE_TITLES: Readonly<Record<PhaseId, string>> = {
  understand: 'Understanding the problem',
  plan: 'Devising a plan',
  execute: 'Carrying out, checking, and revising',
  look_back: 'Looking back',
}

/** Detailed phase-specific instructions, shown when that phase becomes active. */
export const PHASE_GUIDANCE: Readonly<Record<PhaseId, string>> = {
  understand: `## Phase: Understanding the problem

- Identify the principal parts: the unknown, the data, and the condition.
- Clarify every word, definition, and convention. Search for unfamiliar terms.
- Resolve physical and mathematical conventions explicitly, for example metric
  signature, index order, coefficient conventions, and branch choices.
- Decide whether the condition is sufficient, insufficient, redundant, or
  contradictory. If it is insufficient, say exactly what is missing.
- Use search and reference tools when definitions or conventions are uncertain.`,

  plan: `## Phase: Devising a plan

- Find a connection between the data and the unknown.
- Ask whether you have seen the same or a related problem before.
- Look at the unknown and think of familiar problems with the same kind of
  unknown.
- Use relevant theorems, properties, solved examples, and methods.
- Introduce auxiliary elements, approximations, or analogous problems when the
  direct connection is not visible.
- Check that the plan uses all the data and the whole condition.
- When returning here after an obstruction or a failed check, revise the plan
  before completing this phase and returning to execution. First try to repair
  the direct approach or choose a materially different direct approach.
- If direct approaches repeatedly reach the same obstruction, use an auxiliary
  problem: simplify, specialise, generalise, relax part of the condition,
  change representation, or extract a transferable result.
- Delegate independent exploration of candidate methods to focused subagents
  when useful.`,

  execute: `## Phase: Carrying out, checking, and revising

1. Carry out the plan and check why each step is valid. A formal proof is not
   necessary for every step; provide further justification when validity is unclear.
2. If an obstruction prevents completing the calculation, identify it and call
   research_workflow with action "reopen" and phase "plan". Do not mark execute
   complete when the calculation cannot be completed.
3. Revise the plan in Step 2, then complete plan before resuming execution.
- Use computation tools for symbolic or numerical work, and delegate independent
  calculations to focused subagents when helpful.`,

  look_back: `## Phase: Looking back

- Check the result with special and limiting cases.
- Test dimensional consistency and expected signs or limits.
- Check the argument step by step.
- Try to derive the result differently, or see it at a glance.
- If checking reveals execution errors, omissions, gaps in the argument, or
  insufficient precision within the existing plan, return to Step 3 to correct
  or complete the affected steps. Examples: the plan requires second order, but
  only first order was calculated; a boundary condition was omitted.
- If checking reveals invalid key assumptions, inapplicable methods, or missing
  essential contributions in the existing plan, return to Step 2 to revise the
  plan. Examples: non-degenerate perturbation theory was planned, but the energy
  levels are degenerate; a neglected interaction is of the same order as retained
  terms.
- To return to Step 3 or Step 2, call research_workflow with action "reopen" and
  phase "execute" or "plan", respectively. Explain the cause in your response.
  Do not complete look_back after a failed check; repeat the affected phases and
  check the corrected result before completing look_back.
- Use a subagent for an independent verification when a different perspective
  would be valuable.`,
}

function assertPhase(phase: PhaseId): void {
  if (!(PHASES as readonly string[]).includes(phase)) {
    throw new Error(`unknown phase "${phase}"`)
  }
}

/** Start a new problem from a non-empty problem statement. */
export function startWorkflow(problem: string): WorkflowState {
  const trimmed = problem.trim()
  if (trimmed.length === 0) {
    throw new Error('problem must be a non-empty description of the research problem')
  }
  return {
    problem: trimmed,
    completed: [],
  }
}

/** Whether every phase has been completed. */
export function isWorkflowComplete(state: WorkflowState): boolean {
  return state.completed.length === PHASES.length
}

/** The first incomplete phase, or undefined when the workflow is complete. */
export function nextPhase(state: WorkflowState): PhaseId | undefined {
  return PHASES.find(phase => !state.completed.includes(phase))
}

/**
 * Mark one phase complete.
 *
 * Phases must be completed in the order defined by {@link PHASES}. Duplicate
 * and out-of-order completions are programmer/model errors, so they throw.
 */
export function completeWorkflowPhase(
  state: WorkflowState,
  phase: PhaseId,
): WorkflowState {
  assertPhase(phase)
  if (state.completed.includes(phase)) {
    throw new Error(`phase "${phase}" is already complete`)
  }
  const phaseIndex = PHASES.indexOf(phase)
  const previous = PHASES.slice(0, phaseIndex)
  const missing = previous.find(candidate => !state.completed.includes(candidate))
  if (missing !== undefined) {
    throw new Error(`phase "${phase}" cannot complete before "${missing}"`)
  }
  return {
    ...state,
    completed: [...state.completed, phase],
  }
}

/** Reopen an earlier phase from the current, unfinished phase. */
export function reopenWorkflowPhase(state: WorkflowState, phase: PhaseId): WorkflowState {
  assertPhase(phase)
  const current = nextPhase(state)
  const allowed = (current === 'execute' && phase === 'plan')
    || (current === 'look_back' && (phase === 'execute' || phase === 'plan'))
  if (!allowed) {
    throw new Error(`transition from "${current ?? 'complete'}" to "${phase}" is not allowed`)
  }
  // 只保留目标之前的完成标记，确保修订后重新执行并检查。
  return { ...state, completed: PHASES.slice(0, PHASES.indexOf(phase)) }
}

/** Render a compact current-state block for the runtime context snapshot. */
export function renderWorkflowStatus(state: WorkflowState): string {
  const complete = isWorkflowComplete(state)
  const completed = state.completed.length === 0
    ? '(none)'
    : state.completed.map(phase => PHASE_TITLES[phase]).join(' -> ')
  const current = nextPhase(state)
  return [
    complete ? 'Research workflow complete:' : 'Active research workflow:',
    `Problem: ${state.problem}`,
    `Completed phases: ${completed}`,
    complete ? 'Status: complete' : `Next required phase: ${PHASE_TITLES[current!]}`,
  ].join('\n')
}
