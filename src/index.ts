/**
 * Researchly workflow driver.
 *
 * The root agent must pass through four ordered phases before a research
 * problem is considered solved. This plugin contributes both the model-facing
 * instructions and a checkpoint tool that records progress.
 *
 * @module dsh-researchly
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  PHASES,
  PHASE_GUIDANCE,
  PHASE_TITLES,
  completeWorkflowPhase,
  isWorkflowComplete,
  nextPhase,
  renderWorkflowStatus,
  reopenWorkflowPhase,
  startWorkflow,
  type PhaseId,
  type WorkflowState,
} from './state.ts'

export const name = 'researchly'
export const inject = ['tools', 'systemPrompt']

const TOOL_NAME = 'research_workflow'

const WORKFLOW_SUMMARY = `# Research workflow

You are solving a mathematical or physical research problem. Work through the following four phases in order. Present a final solution after the workflow status reports that all four phases are complete:

1. Understanding the problem
2. Devising a plan
3. Carrying out, checking, and revising
4. Looking back

The runtime context provides the detailed instructions for whichever phase is currently active.

- Use the available tools appropriate to each phase: search or read references, run symbolic or numerical computations, inspect files, and query the web.

## Workflow tool protocol

- Call \`${TOOL_NAME}\` with action \`start\` before working on a research problem.
- Call action \`phase_complete\` with the current \`phase\` only after it is genuinely finished, in the order: understand, plan, execute, look_back.
- If execution is obstructed, call action \`reopen\` with phase \`plan\` before revising the plan.
- If a check fails, call action \`reopen\` with phase \`execute\` for problems within the existing plan, or \`plan\` for problems with the plan itself. Explain the cause in your response. Do not mark the failed phase complete.
- After reopening a phase, complete it and the following phases again, including looking back. Use \`reopen\` rather than restarting the problem.
- Call action \`status\` whenever you need to see the current workflow state.
- Use action \`abandon\` only when the user explicitly stops the problem.`

type WorkflowResult = {
  message: string
  active: boolean
  problem?: string
  completed: PhaseId[]
  remaining: PhaseId[]
}

function isRootAgent(agent: Agent): boolean {
  return agent.session.header.origin !== 'subagent'
}

function completedPhases(state: WorkflowState): PhaseId[] {
  return [...state.completed]
}

function remainingPhases(state: WorkflowState): PhaseId[] {
  return PHASES.filter(phase => !state.completed.includes(phase))
}

function resultFor(
  message: string,
  state: WorkflowState | undefined,
  active = state !== undefined && !isWorkflowComplete(state),
): WorkflowResult {
  return {
    message,
    active,
    ...state === undefined ? {} : { problem: state.problem },
    completed: state === undefined ? [] : completedPhases(state),
    remaining: state === undefined ? [...PHASES] : remainingPhases(state),
  }
}

function requireActive(workflows: Map<Agent['id'], WorkflowState>, agent: Agent): WorkflowState {
  const state = workflows.get(agent.id)
  if (state === undefined) {
    throw new Error(`no active research workflow; call ${TOOL_NAME} with action "start" first`)
  }
  if (isWorkflowComplete(state)) {
    throw new Error(`this research workflow is already complete; call ${TOOL_NAME} with action "start" to begin a new problem`)
  }
  return state
}

function requirePhase(value: unknown): PhaseId {
  if (typeof value !== 'string' || !(PHASES as readonly string[]).includes(value)) {
    throw new Error(`phase must be one of: ${PHASES.join(', ')}`)
  }
  return value as PhaseId
}

export function apply(ctx: Context): void {
  const workflows = new Map<Agent['id'], WorkflowState>()

  ctx.systemPrompt.section({
    name: 'research:workflow',
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY') + 10,
    // TODO: 提示词放置的位置影响大吗？目前的位置还挺靠前的，需要放后面吗？
    text: `Use \`research_workflow\` only when at least one of the following is true:
    1. User explicitly asks to use it. In that case, call \`research_workflow\` with action "start". 2. The task is obviously beyond ordinary textbook exercise level: solving it requires a non-standard method, several connected steps, resolving ambiguous definitions/conventions, or checking the result through non-trivial limits. 3. The task has a real research background: it asks you to verify, apply, or extend a result from a paper/research context, or it's part of an ongoing research project.
    Do NOT use this tool for ordinary exercise-level work such as a direct integral, easy simplification/substitution, standard equation, or a textbook proof whose method is already clear.`,
  })

  ctx.systemPrompt.context({
    name: 'research:workflow-status',
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + 10,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined || !isRootAgent(agent)) return ''
      const state = workflows.get(agent.id)
      if (state === undefined) return ''
      const status = renderWorkflowStatus(state)
      const phase = nextPhase(state)
      const guidance = phase === undefined
        ? status
        : `${status}\n\n${PHASE_GUIDANCE[phase]}`
      return `${WORKFLOW_SUMMARY}\n\n${guidance}`
    },
  })

  ctx.on('agent/disposed', ({ agent }) => {
    workflows.delete(agent.id)
  })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!isRootAgent(agent)) return
    const state = workflows.get(agent.id)
    if (state === undefined || isWorkflowComplete(state)) return
    const phase = nextPhase(state)
    if (phase === undefined) return
    agent.steer({
      content: [{
        type: 'text',
        text: `The research workflow is still active. Work on "${PHASE_TITLES[phase]}" and call ${TOOL_NAME} with action "phase_complete" only when it is finished. If execution is obstructed, reopen "plan"; if a check fails, reopen "execute" or "plan" according to the cause. Do not mark a failed phase complete. Use action "abandon" only if the user has explicitly stopped this problem.`,
      }],
      source: { kind: 'plugin', plugin: name },
    })
  })

  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: `Guide a four-phase research workflow. Call start, then complete phases in order: understand, plan, execute, look_back. Use reopen to return from execute to plan, or from look_back to execute or plan. Use status to inspect progress, and abandon only when the user explicitly stops the problem.`,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['start', 'status', 'phase_complete', 'reopen', 'abandon'],
        description: 'The workflow action to perform.',
      },
      problem: {
        type: 'string',
        description: 'Required for action "start": the research problem to solve.',
      },
      phase: {
        type: 'string',
        enum: [...PHASES],
        description: 'Required for "phase_complete": the current phase. Required for "reopen": the earlier phase to return to (plan or execute).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
          active: { type: 'boolean', required: true },
          problem: { type: 'string' },
          completed: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          remaining: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error(`${TOOL_NAME} requires a calling agent`)
      }
      if (!isRootAgent(agent)) {
        throw new Error(`${TOOL_NAME} is only available to the root researcher; subagents should work on focused delegated subtasks`)
      }

      const action = args.action
      if (action === 'start') {
        if (typeof args.problem !== 'string') {
          throw new Error('action "start" requires a non-empty problem')
        }
        const previous = workflows.get(agent.id)
        if (previous !== undefined && !isWorkflowComplete(previous)) {
          throw new Error('a research workflow is already active; call status first, or abandon it explicitly')
        }
        const state = startWorkflow(args.problem)
        workflows.set(agent.id, state)
        return resultFor('Research workflow started. Complete the phases in order: understand, plan, execute, look_back.', state, true)
      }

      if (action === 'status') {
        const state = workflows.get(agent.id)
        if (state === undefined) {
          return resultFor('No active research workflow.', undefined, false)
        }
        const complete = isWorkflowComplete(state)
        return resultFor(
          complete
            ? 'Research workflow is complete.'
            : `Active research workflow. Next required phase: ${nextPhase(state)}.`,
          state,
          !complete,
        )
      }

      if (action === 'abandon') {
        const existed = workflows.delete(agent.id)
        return resultFor(
          existed ? 'Research workflow abandoned.' : 'No active research workflow to abandon.',
          undefined,
          false,
        )
      }

      const state = requireActive(workflows, agent)
      if (action === 'reopen') {
        const phase = requirePhase(args.phase)
        const next = reopenWorkflowPhase(state, phase)
        workflows.set(agent.id, next)
        return resultFor(`Returned to phase "${phase}". Complete this phase and all following phases again.`, next, true)
      }

      if (action === 'phase_complete') {
        const phase = requirePhase(args.phase)
        const next = completeWorkflowPhase(state, phase)
        workflows.set(agent.id, next)
        if (isWorkflowComplete(next)) {
          return resultFor('All four research phases are complete. You may now present the final answer after looking back over the result.', next, false)
        }
        return resultFor(`Phase "${phase}" complete. Next required phase: ${nextPhase(next)}.`, next, true)
      }

      throw new Error(`unsupported workflow action: ${String(action)}`)
    },
  }))
}
