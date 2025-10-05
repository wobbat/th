import { AuthGithubCopilot } from '../auth/github-copilot'

export interface CopilotMessage {
  role: 'user' | 'assistant' | 'system' | 'function'
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface Tool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: any
  }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface CopilotCompletionRequest {
  model: string
  messages: CopilotMessage[]
  temperature?: number
  max_tokens?: number
  stream?: boolean
  tools?: Tool[]
}

export interface CopilotCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message?: {
      role: string
      content: string
      tool_calls?: ToolCall[]
    }
    delta?: {
      role?: string
      content?: string
      tool_calls?: ToolCall[]
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export class CopilotAPI {
  private static readonly BASE_URL = 'https://api.githubcopilot.com'

  static async chat(request: CopilotCompletionRequest): Promise<CopilotCompletionResponse> {
    const token = await AuthGithubCopilot.access()
    if (!token) {
      throw new Error('No valid Copilot token. Please run login first.')
    }

    const response = await fetch(`${this.BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Editor-Version': 'vscode/1.99.3',
        'Editor-Plugin-Version': 'copilot-chat/0.26.7',
      },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Copilot API error: ${response.status} ${error}`)
    }

    return response.json() as Promise<CopilotCompletionResponse>
  }

  static async *chatStream(
    request: CopilotCompletionRequest,
  ): AsyncGenerator<{ content?: string; tool_calls?: ToolCall[] }, void, unknown> {
    const token = await AuthGithubCopilot.access()
    if (!token) {
      throw new Error('No valid Copilot token. Please run login first.')
    }

    const response = await fetch(`${this.BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Editor-Version': 'vscode/1.99.3',
        'Editor-Plugin-Version': 'copilot-chat/0.26.7',
      },
      body: JSON.stringify({ ...request, stream: true }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Copilot API error: ${response.status} ${error}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('No response body')
    }

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') {
              return
            }

            try {
              const parsed = JSON.parse(data)
              const delta = parsed.choices?.[0]?.delta
              if (delta && (delta.content || delta.tool_calls)) {
                yield { content: delta.content, tool_calls: delta.tool_calls }
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}
