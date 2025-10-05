import type { Tool } from './api/copilot'

export const tools: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The absolute path to the file to read',
          },
        },
        required: ['path'],
      },
    },
  },
]
