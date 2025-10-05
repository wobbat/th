#!/usr/bin/env bun

import { spawn } from 'child_process'
import readline from 'readline'
import chalk from 'chalk'
import { CopilotAPI, type CopilotMessage } from './src/api/copilot'

const PRIMARY_MODEL = 'gpt-4o'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const rawQuery = args.join(' ').trim()

  if (!rawQuery) {
    console.error(chalk.red('Usage: bun run command-assist.ts <task description>'))
    process.exit(1)
  }

  const context = gatherContext()
  const messages = buildPrompt(rawQuery, context)

  const spinner = new Spinner([':', '⁖', '⁘', '⁛', '⁙', '⁛', '⁘', '⁖'])
  spinner.start()
  const proposal = await requestCommand(messages)
  spinner.stop()

  if (!proposal) {
    console.error(chalk.red('No command proposal returned. Please try rephrasing the request.'))
    process.exit(1)
  }

  renderProposal(proposal)

  const approved = await requestApproval()
  if (!approved) {
    console.log(chalk.yellow('Command execution cancelled.'))
    return
  }

  await executeCommand(proposal.command)
}

function gatherContext(): string {
  return `current working directory: ${process.cwd()}`
}

function buildPrompt(task: string, context: string): CopilotMessage[] {
  const systemMessage: CopilotMessage = {
    role: 'system',
    content:
      'You are a terminal command planner. Given a user request and project context, respond with JSON containing fields: "command", "explanation", and optionally "summary". ' +
      'Return "summary" only when the command involves multiple steps, non-trivial options, or could surprise the user; otherwise omit it. ' +
      'The "command" must be a single shell command safe to run in the provided directory. Do not include comments, surrounding quotes, or multi-line scripts. ' +
      'You must always propose a best-effort command even if information is missing—do not ask follow-up questions. ' +
      'If critical context is unavailable, make a reasonable assumption and mention it in "explanation". ' +
      'You cannot execute additional tools yourself; suggest only the command a user should run. ' +
      'If a safe command truly cannot be produced, return JSON with an empty "command" and a short explanation.',
  }

  const userMessage: CopilotMessage = {
    role: 'user',
    content: `Task: ${task}\n\nContext:\n${context}`,
  }

  return [systemMessage, userMessage]
}

interface CommandProposal {
  command: string
  explanation?: string
  summary?: string
}

async function requestCommand(messages: CopilotMessage[]): Promise<CommandProposal | null> {
  let buffer = ''

  try {
    for await (const chunk of CopilotAPI.chatStream({
      model: PRIMARY_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 180,
    })) {
      if (!chunk.content) {
        continue
      }

      buffer += chunk.content
      const parsed = parseProposal(buffer)
      if (parsed) {
        return parsed
      }
    }

    if (buffer) {
      const parsed = parseProposal(buffer)
      if (parsed) {
        return parsed
      }
    }

    console.error(chalk.red('Assistant response incomplete.'))
    return null
  } catch (error) {
    console.error(
      chalk.red(
        `Failed to query Copilot: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    return null
  }
}

function parseProposal(content: string): CommandProposal | null {
  const json = extractJson(content)
  if (!json) {
    return null
  }

  const command = typeof json.command === 'string' ? json.command.trim() : ''
  const explanation = typeof json.explanation === 'string' ? json.explanation.trim() : undefined
  const summary = typeof json.summary === 'string' ? json.summary.trim() : undefined

  if (!command) {
    console.error(chalk.red(explanation || 'Assistant did not provide a runnable command.'))
    return null
  }

  return { command, explanation, summary }
}

class Spinner {
  private readonly frames: string[]
  private timer: NodeJS.Timeout | null = null
  private index = 0
  private readonly label = chalk.dim('Planning command…')

  constructor(frames: string[]) {
    this.frames = frames
  }

  start(): void {
    if (this.timer) {
      return
    }

    this.index = 0
    this.renderFrame()
    this.timer = setInterval(() => {
      this.renderFrame()
      this.index = (this.index + 1) % this.frames.length
    }, 140)
  }

  stop(): void {
    if (!this.timer) {
      return
    }

    clearInterval(this.timer)
    this.timer = null
    process.stdout.write('\r')
    readline.clearLine(process.stdout, 0)
    process.stdout.write('\n')
  }

  private renderFrame(): void {
    const frame = chalk.cyan(this.frames[this.index])
    process.stdout.write(`\r${frame} ${this.label}`)
  }
}

function extractJson(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    return null
  }

  try {
    return JSON.parse(content.slice(start, end + 1))
  } catch (error) {
    return null
  }
}

async function requestApproval(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.cyan('? Execute this command? [y/N] '), (value) => {
      rl.close()
      resolve(value.trim())
    })
  })

  return answer.toLowerCase().startsWith('y')
}

async function executeCommand(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      stdio: 'inherit',
      cwd: process.cwd(),
    })

    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Command exited with code ${code ?? 'unknown'}`))
      }
    })

    child.on('error', (error) => {
      reject(error)
    })
  }).catch((error) => {
    console.error(
      chalk.red(
        `Command execution failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  })
}

function renderProposal({ command, explanation, summary }: CommandProposal): void {
  console.log(chalk.bold.cyan('\nCommand Assistant'))
  console.log(chalk.gray('────────────────────'))

  console.log(`${chalk.dim('command')}  ${chalk.green(command)}`)

  if (summary) {
    console.log(`${chalk.dim('summary')}  ${summary}`)
  }

  if (explanation) {
    console.log(`${chalk.dim('reason')}   ${explanation}`)
  }

  console.log()
}

void main()
