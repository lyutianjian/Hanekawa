import { exec } from 'node:child_process'
import { platform } from 'node:os'

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const os = platform()
    let cmd: string

    if (os === 'win32') {
      cmd = `echo ${JSON.stringify(text)} | clip`
    } else if (os === 'darwin') {
      cmd = `echo ${JSON.stringify(text)} | pbcopy`
    } else {
      cmd = `echo ${JSON.stringify(text)} | xclip -selection clipboard`
    }

    await new Promise<void>((resolve, reject) => {
      exec(cmd, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    return true
  } catch {
    return false
  }
}
