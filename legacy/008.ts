#!/usr/bin/env bun

import {
  CliRenderer,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
  BoxRenderable,
  createCliRenderer,
  fg,
  t,
} from '@opentui/core'
import type { StyledText } from '@opentui/core'
import { readFileSync } from 'fs'
import { basename } from 'path'
import { CopilotAPI, type CopilotMessage, type ToolCall } from './src/api/copilot'
import { tools } from './src/tools'

const MODEL_ID = 'grok-code-fast-1'
const SUMMARIZER_MODEL_ID = 'gpt-4.1'
const SUMMARY_INPUT_LIMIT = 4000

const THEME = {
  accent: 'brightBlue',
  userLabel: 'cyan',
  assistantLabel: 'brightGreen',
  functionLabel: 'brightMagenta',
  systemLabel: 'brightBlack',
  textPrimary: 'brightWhite',
  textSecondary: 'brightBlack',
  status: {
    ready: 'brightBlue',
    thinking: 'green',
    error: 'brightRed',
  },
}

type ChatRole = CopilotMessage['role']

type MessageRenderable = {
  id: string
  node: TextRenderable
  role: ChatRole
}

type CommandHandler = (args: string[]) => Promise<void> | void

class ChatTui {
  private readonly renderer: CliRenderer
  private readonly history: ScrollBoxRenderable
  private readonly inputField: InputRenderable
  private readonly statusLine: TextRenderable
  private readonly titleNode: TextRenderable
  private readonly subtitleNode: TextRenderable
  private readonly messages: MessageRenderable[] = []
  private chatHistory: CopilotMessage[] = []
  private isStreaming = false
  private messageCounter = 0
  private readonly messageTextColor = THEME.textPrimary
  private hasGeneratedTitle = false

  constructor(renderer: CliRenderer) {
    this.renderer = renderer

    const root = new BoxRenderable(this.renderer, {
      id: 'root',
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      gap: 0,
    })

    this.renderer.root.add(root)

    const header = new BoxRenderable(this.renderer, {
      id: 'header',
      flexDirection: 'column',
      gap: 1,
      shouldFill: false,
    })

    const headerSpacer = new BoxRenderable(this.renderer, {
      id: 'header-spacer',
      height: 1,
    })

    const title = new TextRenderable(this.renderer, {
      id: 'title',
      content: '008 · Copilot chat',
      fg: THEME.textPrimary,
      wrap: false,
    })

    const subtitle = new TextRenderable(this.renderer, {
      id: 'subtitle',
      content: `Model: ${MODEL_ID} · Summaries: ${SUMMARIZER_MODEL_ID} — /help for commands`,
      fg: THEME.textSecondary,
      wrap: false,
    })

    header.add(headerSpacer)
    header.add(title)
    header.add(subtitle)
    root.add(header)

    this.titleNode = title
    this.subtitleNode = subtitle

    const body = new BoxRenderable(this.renderer, {
      id: 'body',
      flexDirection: 'column',
      flexGrow: 1,
      gap: 1,
      shouldFill: true,
    })

    const historyShell = new BoxRenderable(this.renderer, {
      id: 'history-shell',
      flexDirection: 'column',
      flexGrow: 1,
      shouldFill: true,
    })

    const historyPaddingTop = new BoxRenderable(this.renderer, {
      id: 'history-padding-top',
      height: 1,
    })

    const historyRow = new BoxRenderable(this.renderer, {
      id: 'history-row',
      flexDirection: 'row',
      shouldFill: true,
      flexGrow: 1,
    })

    const historyPaddingLeft = new BoxRenderable(this.renderer, {
      id: 'history-padding-left',
      width: 1,
    })

    this.history = new ScrollBoxRenderable(this.renderer, {
      id: 'history',
      flexDirection: 'column',
      flexGrow: 1,
      shouldFill: true,
      stickyScroll: true,
      stickyStart: 'bottom',
      contentOptions: { gap: 1 },
      scrollY: true,
    })

    const historyPaddingRight = new BoxRenderable(this.renderer, {
      id: 'history-padding-right',
      width: 3,
    })

    const historyPaddingBottom = new BoxRenderable(this.renderer, {
      id: 'history-padding-bottom',
      height: 1,
    })

    historyRow.add(historyPaddingLeft)
    historyRow.add(this.history)
    historyRow.add(historyPaddingRight)

    historyShell.add(historyPaddingTop)
    historyShell.add(historyRow)
    historyShell.add(historyPaddingBottom)

    body.add(historyShell)

    const footer = new BoxRenderable(this.renderer, {
      id: 'footer',
      flexDirection: 'column',
      gap: 0,
    })

    const footerPaddingTop = new BoxRenderable(this.renderer, {
      id: 'footer-padding-top',
      height: 1,
    })

    const inputRow = new BoxRenderable(this.renderer, {
      id: 'input-row',
      flexDirection: 'row',
      shouldFill: true,
      gap: 1,
    })

    const inputPaddingLeft = new BoxRenderable(this.renderer, {
      id: 'input-padding-left',
      width: 3,
    })

    const promptIndicator = new TextRenderable(this.renderer, {
      id: 'prompt-indicator',
      content: '#',
      fg: THEME.accent,
      wrap: false,
    })

    const inputContainer = new BoxRenderable(this.renderer, {
      id: 'input-container',
      flexDirection: 'column',
      flexGrow: 1,
      shouldFill: true,
    })

    const inputPaddingInnerTop = new BoxRenderable(this.renderer, {
      id: 'input-padding-inner-top',
      height: 1,
    })

    const inputFieldRow = new BoxRenderable(this.renderer, {
      id: 'input-field-row',
      flexDirection: 'row',
      shouldFill: true,
    })

    this.inputField = new InputRenderable(this.renderer, {
      id: 'input',
      placeholder: 'Ask, type /command, or exit',
      textColor: THEME.textPrimary,
      focusedTextColor: THEME.textPrimary,
      shouldFill: true,
      height: 3,
      flexGrow: 1,
    } as any)

    const inputPaddingInnerBottom = new BoxRenderable(this.renderer, {
      id: 'input-padding-inner-bottom',
      height: 1,
    })

    inputFieldRow.add(this.inputField)

    inputContainer.add(inputPaddingInnerTop)
    inputContainer.add(inputFieldRow)
    inputContainer.add(inputPaddingInnerBottom)

    const inputPaddingRight = new BoxRenderable(this.renderer, {
      id: 'input-padding-right',
      width: 3,
    })

    inputRow.add(inputPaddingLeft)
    inputRow.add(inputContainer)
    inputRow.add(inputPaddingRight)

    const footerPaddingBottom = new BoxRenderable(this.renderer, {
      id: 'footer-padding-bottom',
      height: 1,
    })

    this.statusLine = new TextRenderable(this.renderer, {
      id: 'status',
      content: 'Ready',
      fg: THEME.status.ready,
      wrap: false,
      width: '100%',
    })

    const statusRow = new BoxRenderable(this.renderer, {
      id: 'status-row',
      flexDirection: 'row',
      shouldFill: true,
    })

    const statusPaddingLeft = new BoxRenderable(this.renderer, {
      id: 'status-padding-left',
      width: 3,
    })

    const statusPaddingRight = new BoxRenderable(this.renderer, {
      id: 'status-padding-right',
      width: 3,
    })

    const statusContainer = new BoxRenderable(this.renderer, {
      id: 'status-container',
      flexDirection: 'row',
      flexGrow: 1,
      shouldFill: true,
    })

    statusContainer.add(this.statusLine)

    statusRow.add(statusPaddingLeft)
    statusRow.add(statusContainer)
    statusRow.add(statusPaddingRight)

    footer.add(footerPaddingTop)
    footer.add(inputRow)
    footer.add(footerPaddingBottom)
    footer.add(statusRow)

    body.add(footer)
    root.add(body)

    this.registerEvents()
    this.renderer.requestRender()

    this.addSystemMessage('Welcome to 008. Minimal terminal, maximal focus.')
    this.inputField.focus()
  }

  private registerEvents(): void {
    this.inputField.on(InputRenderableEvents.ENTER, (value: string) => {
      void this.handleSubmission(value)
    })

    this.renderer.keyInput.on('keypress', (key: any) => {
      if (key.name === 'escape' || (key.name === 'c' && key.ctrl)) {
        this.setStatus('Session ended', THEME.status.error)
        this.renderer.destroy()
        process.exit(0)
      }
    })
  }

  private async handleSubmission(rawValue: string): Promise<void> {
    const value = rawValue.trim()
    this.inputField.value = ''
    this.inputField.focus()

    if (!value) {
      this.setStatus('Nothing to send — type a message.', THEME.textSecondary)
      return
    }

    if (this.isStreaming) {
      this.addSystemMessage('Hold on — response is still streaming.')
      return
    }

    const shouldContinue = this.echoUserInput(value)
    if (!shouldContinue) {
      return
    }

    if (value.startsWith('/')) {
      await this.handleCommand(value)
      return
    }

    await this.sendToAssistant(value)
  }

  private async handleCommand(input: string): Promise<void> {
    const parts = input.slice(1).trim().split(/\s+/)
    const command = (parts.shift() || '').toLowerCase()
    const handler = this.commands[command]
    const args = parts

    if (!handler) {
      this.addSystemMessage(`Unknown command: ${command}. Try /help.`)
      return
    }

    await handler(args)
  }

  private readonly commands: Record<string, CommandHandler> = {
    help: async () => {
      this.addSystemMessage(
        'Commands:\n  /help     Show this help\n  /clear    Reset the conversation\n  /history  Show last turns\n  /about    About this client\n  /exit     Exit (you can also type exit)',
      )
    },
    clear: async () => {
      this.messages.forEach((msg) => this.history.remove(msg.id))
      this.messages.length = 0
      this.chatHistory = []
      this.addSystemMessage('Conversation cleared.')
    },
    history: async () => {
      if (this.chatHistory.length === 0) {
        this.addSystemMessage('History is empty.')
        return
      }

      const preview = this.chatHistory
        .filter((entry) => entry.role !== 'system')
        .slice(-6)
        .map((entry) => `${entry.role}> ${entry.content.slice(0, 80)}`)
        .join('\n')

      this.addSystemMessage(preview || 'No previous turns tracked.')
    },
    about: async () => {
      this.addSystemMessage('008 TUI · built with OpenTUI · streams the GitHub Copilot API + tools.')
    },
    exit: async () => {
      this.addSystemMessage('Shutting down — see you next time.')
      setTimeout(() => {
        this.renderer.destroy()
        process.exit(0)
      }, 150)
    },
  }

  private async sendToAssistant(value: string): Promise<void> {
    this.chatHistory.push({ role: 'user', content: value })
    void this.maybeGenerateTitleSummary(value)
    this.setStatus('Thinking…', THEME.status.thinking)
    this.isStreaming = true

    try {
      await this.streamAssistantResponse()
      this.setStatus('Ready', THEME.status.ready)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.addSystemMessage(`Error: ${message}`)
      this.setStatus('Error — try again?', THEME.status.error)
    } finally {
      this.isStreaming = false
    }
  }

  private async streamAssistantResponse(): Promise<void> {
    let assistantRenderable = this.createMessageNode('assistant', '')

    let safetyCounter = 0
    const maxToolPasses = 4

    while (safetyCounter < maxToolPasses) {
      safetyCounter += 1

      let accumulatedText = ''
      let pendingToolCalls: ToolCall[] = []
      let toolStatusRenderable: MessageRenderable | null = null

      for await (const chunk of CopilotAPI.chatStream({
        model: MODEL_ID,
        messages: this.chatHistory,
        temperature: 0.7,
        max_tokens: 1000,
        tools,
      })) {
        if (chunk.tool_calls && chunk.tool_calls.length > 0) {
          pendingToolCalls = this.mergeToolCalls(pendingToolCalls, chunk.tool_calls)
          if (pendingToolCalls.length > 0) {
            const statusText = this.describeToolCalls(pendingToolCalls)
            if (!toolStatusRenderable) {
              toolStatusRenderable = this.createMessageNode(
                'function',
                statusText,
                { insertBeforeId: assistantRenderable.id },
              )
            } else {
              toolStatusRenderable.node.content = this.formatMessage('function', statusText)
            }
            this.renderer.requestRender()
          }
        }

        if (chunk.content) {
          accumulatedText += chunk.content
          assistantRenderable.node.content = this.formatAssistantText(accumulatedText)
          this.renderer.requestRender()
        }
      }

      if (pendingToolCalls.length === 0) {
        const finalText = accumulatedText.trimEnd()
        if (toolStatusRenderable) {
          this.removeMessageNode(toolStatusRenderable.id)
        }

        if (finalText.length === 0) {
          this.removeMessageNode(assistantRenderable.id)
          this.renderer.requestRender()
          return
        }

        assistantRenderable.node.content = this.formatAssistantText(finalText)
        this.chatHistory.push({ role: 'assistant', content: finalText })
        this.renderer.requestRender()
        return
      }

      // Record tool call in transcript and surface it to the user.
      this.chatHistory.push({
        role: 'assistant',
        content: accumulatedText,
        tool_calls: pendingToolCalls,
      })

      await this.resolveToolCalls(pendingToolCalls, assistantRenderable.id)

      if (toolStatusRenderable) {
        this.removeMessageNode(toolStatusRenderable.id)
        toolStatusRenderable = null
      }

      if (accumulatedText.trim().length === 0) {
        this.removeMessageNode(assistantRenderable.id)
      }

      assistantRenderable = this.createMessageNode('assistant', '')
    }

    this.addSystemMessage('Reached tool-call depth limit — aborting conversation state.')
  }

  private mergeToolCalls(existing: ToolCall[], updates: ToolCall[]): ToolCall[] {
    const merged = [...existing]

    updates.forEach((update, index) => {
      const current = merged[index] ?? {
        id: update.id || `tool-${index}`,
        type: 'function',
        function: { name: '', arguments: '' },
      }

      current.id = update.id || current.id
      current.function.name = update.function?.name || current.function.name

      const incomingArgs = update.function?.arguments || ''
      current.function.arguments = `${current.function.arguments || ''}${incomingArgs}`

      merged[index] = current as ToolCall
    })

    return merged
  }

  private async resolveToolCalls(toolCalls: ToolCall[], anchorMessageId: string): Promise<void> {
    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name
      const args = this.parseToolArguments(toolCall)
      let toolResponse = ''

      if (toolName === 'read_file') {
        toolResponse = this.handleReadFile(toolCall, args)
      } else {
        toolResponse = `Tool ${toolName} is not implemented in the TUI.`
      }

      this.chatHistory.push({
        role: 'function',
        name: toolName,
        content: toolResponse,
        tool_call_id: toolCall.id,
      })

      const summary = await this.describeToolResult(toolName, args, toolResponse)

      this.createMessageNode('function', summary, { insertBeforeId: anchorMessageId })
    }
  }

  private handleReadFile(toolCall: ToolCall, args?: Record<string, unknown>): string {
    try {
      const parameters = args ?? this.parseToolArguments(toolCall)
      const pathArg = parameters.path

      if (!pathArg || typeof pathArg !== 'string') {
        throw new Error('read_file requires a valid path argument')
      }

      const content = readFileSync(pathArg, 'utf-8')
      return content
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Error reading file: ${message}`
    }
  }

  private echoUserInput(value: string): boolean {
    if (value.toLowerCase() === 'exit') {
      void this.commands.exit([])
      return false
    }

    this.createMessageNode('user', value)
    return true
  }

  private addSystemMessage(text: string): void {
    this.createMessageNode('system', text)
  }

  private createMessageNode(
    role: ChatRole,
    content: string,
    options?: { insertBeforeId?: string },
  ): MessageRenderable {
    const id = `msg-${this.messageCounter++}`
    const node = new TextRenderable(this.renderer, {
      id,
      fg: this.messageTextColor,
      content: this.formatMessage(role, content),
      wrap: true,
      width: '100%',
    })

    let insertIndex: number | undefined
    if (options?.insertBeforeId) {
      const targetIndex = this.messages.findIndex((msg) => msg.id === options.insertBeforeId)
      if (targetIndex !== -1) {
        insertIndex = targetIndex
      }
    }

    if (insertIndex !== undefined) {
      this.history.add(node, insertIndex)
      this.messages.splice(insertIndex, 0, { id, node, role })
    } else {
      this.history.add(node)
      this.messages.push({ id, node, role })
    }

    this.history.scrollTo({ x: 0, y: this.history.scrollHeight })
    this.renderer.requestRender()

    return { id, node, role }
  }

  private removeMessageNode(id: string): void {
    const index = this.messages.findIndex((msg) => msg.id === id)
    if (index === -1) {
      return
    }

    this.messages.splice(index, 1)
    this.history.remove(id)
    this.renderer.requestRender()
  }

  private describeToolCalls(toolCalls: ToolCall[]): string {
    const names = Array.from(
      new Set(
        toolCalls
          .map((call) => call.function?.name || '')
          .filter((name): name is string => Boolean(name.trim())),
      ),
    )

    if (names.length === 0) {
      return 'running tool…'
    }

    if (names.length === 1) {
      return `running ${names[0]}…`
    }

    return `running ${names.join(', ')}…`
  }

  private parseToolArguments(toolCall: ToolCall): Record<string, unknown> {
    const raw = toolCall.function.arguments || '{}'

    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>
      }
    } catch (error) {
      // ignore malformed JSON; handled by caller
    }

    return {}
  }

  private async describeToolResult(
    toolName: string,
    args: Record<string, unknown>,
    output: string,
  ): Promise<string> {
    const normalized = output.replace(/\r\n/g, '\n')
    const lines = normalized.split('\n')
    const isError = normalized.trimStart().toLowerCase().startsWith('error')
    const needsSummary = !isError && lines.length > 3

    let summaryText: string | null = null
    if (needsSummary) {
      const promptInput = normalized.slice(0, SUMMARY_INPUT_LIMIT)
      summaryText = await this.summarizeWithCopilot(
        `Tool ${toolName} produced the following output:\n\n${promptInput}`,
        'You summarize tool responses for a developer terminal. Respond with one sentence under 120 characters describing the outcome. No markdown, no quotes.',
        60,
      )
    }

    const snippetLines = summaryText ? 1 : 2
    const snippet = this.summarizePreview(normalized, snippetLines)

    switch (toolName) {
      case 'read_file': {
        const rawPath = typeof args.path === 'string' ? args.path : undefined
        const displayName = rawPath ? basename(rawPath) : '(unknown file)'

        if (isError) {
          const body = snippet ? ` ${snippet}` : ''
          return `read_file error ->${body}`.trimEnd()
        }

        const parts = [`reading contents of file -> ${displayName}`]
        if (summaryText) {
          parts.push(`summary: ${summaryText}`)
        }
        if (snippet) {
          parts.push(snippet)
        }

        return parts.join('\n')
      }
      default: {
        if (isError) {
          return snippet ? `${toolName} error -> ${snippet}` : `${toolName} error`
        }

        if (summaryText) {
          const parts = [`${toolName} -> ${summaryText}`]
          if (snippet) {
            parts.push(snippet)
          }
          return parts.join('\n')
        }

        if (!snippet) {
          return `ran ${toolName}`
        }

    return `${toolName} -> ${snippet}`
      }
    }
  }

  private async maybeGenerateTitleSummary(initialMessage: string): Promise<void> {
    if (this.hasGeneratedTitle) {
      return
    }

    const trimmed = initialMessage.trim()
    if (!trimmed) {
      return
    }

    this.hasGeneratedTitle = true

    const summary = await this.summarizeWithCopilot(
      trimmed,
      'You create short, evocative titles for programming tasks. Respond with 3 to 5 words in Title Case. No punctuation.',
      24,
    )

    if (!summary) {
      this.hasGeneratedTitle = false
      return
    }

    const normalized = summary.replace(/\s+/g, ' ').trim()
    if (!normalized) {
      this.hasGeneratedTitle = false
      return
    }

    this.titleNode.content = `008 · ${normalized}`
    this.renderer.requestRender()
  }

  private async summarizeWithCopilot(
    input: string,
    systemPrompt: string,
    maxTokens: number,
  ): Promise<string | null> {
    try {
      const response = await CopilotAPI.chat({
        model: SUMMARIZER_MODEL_ID,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: input.slice(0, SUMMARY_INPUT_LIMIT) },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
      })

      const choice = response.choices?.find((item) => item.message?.content?.trim())
      const text = choice?.message?.content?.trim()
      return text && text.length > 0 ? text : null
    } catch (error) {
      return null
    }
  }

  private summarizePreview(preview: string, maxLines: number): string {
    if (!preview) {
      return ''
    }

    const normalized = preview.replace(/\r\n/g, '\n')
    const lines = normalized.split('\n')
    if (lines.length <= maxLines) {
      return normalized.trimEnd()
    }

    const limitedLines = lines.slice(0, maxLines)
    if (limitedLines.length === 0) {
      return ''
    }

    const lastIndex = limitedLines.length - 1
    limitedLines[lastIndex] = `${limitedLines[lastIndex]} ...`
    return limitedLines.join('\n').trimEnd()
  }

  private formatMessage(role: ChatRole, text: string): StyledText {
    const sanitized = text.replace(/\r/g, '')

    if (role === 'function') {
      const hasContent = sanitized.length > 0
      const labelChunk = fg(this.colorForRole(role))('|')
      const body = hasContent ? ` ${sanitized}` : ''
      return t`${labelChunk}${body}\n`
    }

    const prefix = this.prefixForRole(role)
    const hasContent = sanitized.length > 0
    const labelChunk = fg(this.colorForRole(role))(prefix)
    const body = hasContent ? ` ${sanitized}` : ''

    return t`${labelChunk}${body}\n`
  }

  private formatAssistantText(text: string): StyledText {
    return this.formatMessage('assistant', text)
  }

  private prefixForRole(role: ChatRole): string {
    switch (role) {
      case 'user':
        return 'you:'
      case 'assistant':
        return '008:'
      case 'function':
        return '|'
      case 'system':
      default:
        return 'sys:'
    }
  }

  private colorForRole(role: ChatRole): string {
    switch (role) {
      case 'user':
        return THEME.userLabel
      case 'assistant':
        return THEME.assistantLabel
      case 'function':
        return THEME.functionLabel
      case 'system':
      default:
        return THEME.systemLabel
    }
  }

  private setStatus(text: string, color: string): void {
    this.statusLine.content = text
    this.statusLine.fg = color
    this.renderer.requestRender()
  }
}

async function main(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
  })

  new ChatTui(renderer)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
