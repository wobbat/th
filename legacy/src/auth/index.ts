import path from 'path'
import fs from 'fs/promises'
import os from 'os'

export namespace Auth {
  export type Oauth = {
    type: 'oauth'
    refresh: string
    access: string
    expires: number
  }

  export type Api = {
    type: 'api'
    key: string
  }

  export type WellKnown = {
    type: 'wellknown'
    key: string
    token: string
  }

  export type Info = Oauth | Api | WellKnown

  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  const filepath = path.join(configDir, '008', 'auth.json')

  export async function get(providerID: string) {
    const file = Bun.file(filepath)
    return file
      .json()
      .catch(() => ({}))
      .then((x) => x[providerID] as Info | undefined)
  }

  export async function all(): Promise<Record<string, Info>> {
    const file = Bun.file(filepath)
    return file.json().catch(() => ({}))
  }

  export async function set(key: string, info: Info) {
    const file = Bun.file(filepath)
    const data = await all()
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    await Bun.write(file, JSON.stringify({ ...data, [key]: info }, null, 2))
    await fs.chmod(file.name!, 0o600)
  }

  export async function remove(key: string) {
    const file = Bun.file(filepath)
    const data = await all()
    delete data[key]
    await Bun.write(file, JSON.stringify(data, null, 2))
    await fs.chmod(file.name!, 0o600)
  }
}
