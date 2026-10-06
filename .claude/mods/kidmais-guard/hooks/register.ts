import type { Register } from 'claude-code'

import { blockedReason, isSecretFile } from './rules.ts'

const ASK = 'Peça autorização explícita ao usuário e deixe que ele execute.'

export const register: Register = on => {
  const guardFile = (path: string, plugin: string) =>
    isSecretFile(path)
      ? { deny: `${plugin}: ${path} guarda segredos e não pode ser alterado pelo agente. ${ASK}` }
      : undefined

  on('tool.call', { tool: 'Edit' }, ($, e, next) =>
    guardFile(e.file_path, $.plugin.name) ?? next(e),
  ).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: a verificação falhou.` },
  )

  on('tool.call', { tool: 'Write' }, ($, e, next) =>
    guardFile(e.file_path, $.plugin.name) ?? next(e),
  ).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: a verificação falhou.` },
  )

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const reason = blockedReason(e.command)
    if (reason === undefined) {
      return next(e)
    }
    $.ui.toast(`kidmais-guard bloqueou: ${reason}`)

    return { deny: `${$.plugin.name}: comando bloqueado (${reason}). ${ASK}` }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: a verificação falhou.` },
  )
}
