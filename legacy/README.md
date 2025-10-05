# 008

🤖 **008** is an interactive AI assistant powered by GitHub Copilot.

## Features

- Interactive REPL mode for continuous conversation
- Streaming and non-streaming chat modes
- GitHub Copilot authentication
- Uses GPT-5-mini by default for efficient responses

## Installation

To install dependencies:

```bash
bun install
```

## Usage

First, login to GitHub Copilot:

```bash
bun run index.ts login
```

Then start chatting:

```bash
# Interactive mode (recommended)
bun run index.ts repl

# Single message chat
bun run index.ts chat "Hello, 008!"

# Streaming chat
bun run index.ts stream "Tell me a story"
```

## Commands

- `bun run index.ts login` - Login to GitHub Copilot
- `bun run index.ts logout` - Logout and remove stored auth
- `bun run index.ts token` - Get current Copilot token
- `bun run index.ts chat <msg>` - Chat with 008 (non-streaming)
- `bun run index.ts stream <msg>` - Chat with 008 (streaming)
- `bun run index.ts repl` - Start interactive REPL with 008

This project was created using `bun init` in bun v1.2.22. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
