import { AuthGithubCopilot } from '../auth/github-copilot'
import { CopilotAPI } from '../api/copilot'
import type { ToolCall } from '../api/copilot'
import { Auth } from '../auth/index'
import chalk from 'chalk'
import { readFileSync } from 'fs'
import { tools } from '../tools'

export async function login() {
  console.log(chalk.blue('Logging into GitHub Copilot...'))

  try {
    // Start device code flow
    const deviceInfo = await AuthGithubCopilot.authorize()
    console.log(chalk.yellow(`\nGo to: ${deviceInfo.verification}`))
    console.log(chalk.yellow(`Enter code: ${deviceInfo.user}`))
    console.log(chalk.gray('\nWaiting for authorization...'))

    // Poll for completion
    let status: string = 'pending'
    const maxAttempts = 120 // 10 minutes with 5 second intervals
    let attempts = 0

    while (status === 'pending' && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, deviceInfo.interval * 1000))
      status = await AuthGithubCopilot.poll(deviceInfo.device)
      attempts++

      if (status === 'pending') {
        console.log(chalk.gray('Still waiting for authorization...'))
      }
    }

    if (status === 'complete') {
      console.log(chalk.green('Successfully logged into GitHub Copilot!'))
    } else {
      console.log(chalk.red('Authorization failed or timed out'))
      process.exit(1)
    }
  } catch (error) {
    console.error(chalk.red('Login failed:'), error)
    process.exit(1)
  }
}

export async function logout() {
  // Logout and remove stored auth
  await Auth.remove('github-copilot')
  console.log(chalk.green('Logged out and removed stored authentication.'))
  console.log(
    chalk.yellow(
      "Note: To fully revoke the token, visit https://github.com/settings/applications and revoke 'GitHub Copilot Chat'.",
    ),
  )
}

export async function token() {
  // Get current Copilot token
  const token = await AuthGithubCopilot.access()
  if (token) {
    console.log(chalk.cyan('Current Copilot token:'), token)
  } else {
    console.log(chalk.red("No valid token found. Please run 'bun run index.ts login' first."))
  }
}

export async function chat(message: string) {
  try {
    console.log(chalk.blue('008:'), '')

    const messages: Array<{
      role: 'user' | 'assistant' | 'system' | 'function'
      content: string
      tool_call_id?: string
      name?: string
    }> = [{ role: 'user', content: message }]

    const response = await CopilotAPI.chat({
      model: 'grok-code-fast-1', // or any Copilot model
      messages,
      temperature: 0.7,
      max_tokens: 1000,
      tools,
    })

    const toolCalls = response.choices[0]?.message?.tool_calls
    if (toolCalls) {
      for (const toolCall of toolCalls) {
        const { name, arguments: args } = toolCall.function
        if (name === 'read_file') {
          const { path } = JSON.parse(args)
          try {
            const content = readFileSync(path, 'utf-8')
            messages.push({
              role: 'function',
              content,
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
            })
          } catch (e) {
            messages.push({
              role: 'function',
              content: `Error reading file: ${e}`,
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
            })
          }
        }
      }
      // Call again with tool results
      const finalResponse = await CopilotAPI.chat({
        model: 'grok-code-fast-1',
        messages,
        temperature: 0.7,
        max_tokens: 1000,
        tools,
      })

      const finalContent = finalResponse.choices[0]?.message?.content
      if (finalContent) {
        console.log(finalContent)
      } else {
        console.log(chalk.red('No final response from 008'))
      }
    } else {
      const content = response.choices[0]?.message?.content
      if (content) {
        console.log(content)
      } else {
        console.log(chalk.red('No response from 008'))
      }
    }
  } catch (error) {
    console.error(chalk.red('Chat failed:'), error)
    process.exit(1)
  }
}

export async function stream(message: string) {
  try {
    console.log(chalk.blue('008:'), '')

    for await (const chunk of CopilotAPI.chatStream({
      model: 'grok-code-fast-1',
      messages: [{ role: 'user', content: message }],
      temperature: 0.7,
      max_tokens: 1000,
      tools,
    })) {
      process.stdout.write(chunk.content || '')
    }
    console.log('\n')
  } catch (error) {
    console.error(chalk.red('Stream failed:'), error)
    process.exit(1)
  }
}

export function usage() {
  console.log(chalk.blue('008 - Interactive AI Assistant'))
  console.log('')
  console.log(chalk.yellow('Usage:'))
  console.log(chalk.cyan('  bun run index.ts login       - Login to GitHub Copilot'))
  console.log(chalk.cyan('  bun run index.ts logout      - Logout and remove stored auth'))
  console.log(chalk.cyan('  bun run index.ts token       - Get current Copilot token'))
  console.log(chalk.cyan('  bun run index.ts chat <msg>  - Chat with 008 (non-streaming)'))
  console.log(chalk.cyan('  bun run index.ts stream <msg>- Chat with 008 (streaming)'))
  console.log(chalk.cyan('  bun run index.ts repl        - Start interactive REPL with 008'))
}
