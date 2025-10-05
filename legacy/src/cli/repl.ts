import { CopilotAPI } from '../api/copilot'
import type { ToolCall } from '../api/copilot'
import chalk from 'chalk'
import { createInterface } from 'readline'
import { readFileSync } from 'fs'
import { tools } from '../tools'

export async function repl() {
  // Interactive REPL with 008
  console.log(
    chalk.blue(
      "008: Hello! I'm 008, your interactive AI assistant. Type '/help' for commands or 'exit' to quit.",
    ),
  )
  console.log('')

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const chatHistory: Array<{
    role: 'user' | 'assistant' | 'function'
    content: string
    tool_call_id?: string
    name?: string
  }> = []

  function handleCommand(input: string): boolean {
    if (input.startsWith('/')) {
      const cmd = input.slice(1).toLowerCase()
      if (cmd === 'help') {
        console.log(chalk.yellow('Available commands:'))
        console.log(chalk.cyan('  /help   - Show this help'))
        console.log(chalk.cyan('  /clear  - Clear the screen'))
        console.log(chalk.cyan('  /history- Show chat history'))
        console.log(chalk.cyan('  /exit   - Exit the REPL'))
        console.log(chalk.cyan('  exit    - Also exits the REPL'))
        return true
      } else if (cmd === 'clear') {
        console.clear()
        console.log(chalk.blue('008: Screen cleared.'))
        return true
      } else if (cmd === 'history') {
        console.log(chalk.yellow('Chat history:'))
        chatHistory.forEach((msg, i) => {
          const role = msg.role === 'user' ? chalk.green('You') : chalk.blue('008')
          console.log(`${i + 1}. ${role}: ${msg.content}`)
        })
        if (chatHistory.length === 0) {
          console.log(chalk.gray('  (No messages yet)'))
        }
        return true
      } else if (cmd === 'exit') {
        console.log(chalk.blue('008: Goodbye!'))
        rl.close()
        return true
      } else {
        console.log(chalk.red(`Unknown command: ${input}. Type /help for available commands.`))
        return true
      }
    }
    return false
  }

  function askQuestion() {
    rl.question(chalk.green('You: '), async (input: string) => {
      if (input.toLowerCase() === 'exit') {
        console.log(chalk.blue('008: Goodbye!'))
        rl.close()
        return
      }

      if (handleCommand(input)) {
        askQuestion()
        return
      }

      if (!input.trim()) {
        askQuestion()
        return
      }

      chatHistory.push({ role: 'user', content: input })

      try {
        console.log(chalk.blue('008:'), '')

        let fullResponse = ''
        const toolCalls: ToolCall[] = []
        for await (const chunk of CopilotAPI.chatStream({
          model: 'grok-code-fast-1',
          messages: chatHistory,
          temperature: 0.7,
          max_tokens: 1000,
          tools,
        })) {
          if (chunk.tool_calls) {
            toolCalls.push(...chunk.tool_calls)
          }
          process.stdout.write(chunk.content || '')
          fullResponse += chunk.content || ''
        }
        console.log('\n')

        if (toolCalls.length > 0) {
          for (const toolCall of toolCalls) {
            const { name, arguments: args } = toolCall.function
            if (name === 'read_file') {
              const { path } = JSON.parse(args)
              try {
                const content = readFileSync(path, 'utf-8')
                chatHistory.push({
                  role: 'function',
                  content,
                  tool_call_id: toolCall.id,
                  name: toolCall.function.name,
                })
              } catch (e) {
                chatHistory.push({
                  role: 'function',
                  content: `Error reading file: ${e}`,
                  tool_call_id: toolCall.id,
                  name: toolCall.function.name,
                })
              }
            }
          }

          // Stream the final response
          let finalResponse = ''
          for await (const chunk of CopilotAPI.chatStream({
            model: 'grok-code-fast-1',
            messages: chatHistory,
            temperature: 0.7,
            max_tokens: 1000,
            tools,
          })) {
            process.stdout.write(chunk.content || '')
            finalResponse += chunk.content || ''
          }
          console.log('\n')
          fullResponse += finalResponse
        }

        chatHistory.push({ role: 'assistant', content: fullResponse })
      } catch (error) {
        console.error(chalk.red('Chat failed:'), error)
      }

      askQuestion()
    })
  }

  askQuestion()
}
