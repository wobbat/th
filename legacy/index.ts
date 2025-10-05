#!/usr/bin/env bun
import { login, logout, token, chat, stream, usage } from './src/cli/commands'
import { repl } from './src/cli/repl'

async function main() {
  const args = process.argv.slice(2)

  if (args[0] === 'login') {
    await login()
  } else if (args[0] === 'logout') {
    await logout()
  } else if (args[0] === 'token') {
    await token()
  } else if (args[0] === 'chat') {
    const message = args.slice(1).join(' ')
    if (!message) {
      console.log('Usage: bun run index.ts chat <message>')
      process.exit(1)
    }
    await chat(message)
  } else if (args[0] === 'stream') {
    const message = args.slice(1).join(' ')
    if (!message) {
      console.log('Usage: bun run index.ts stream <message>')
      process.exit(1)
    }
    await stream(message)
  } else if (args[0] === 'repl') {
    await repl()
  } else {
    usage()
  }
}

main()
