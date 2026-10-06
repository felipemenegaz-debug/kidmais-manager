import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { lembrete, moduloDe } from './modulos.ts'

const lembrados = atom({ plugin: 'kidmais-docs', key: 'lembrados' } as const, [])

// Um lembrete por módulo por sessão, para não poluir o contexto.
async function lembreteNovo($: EngineInterface, path: string): Promise<string | undefined> {
  const modulo = moduloDe(path)
  if (!modulo || (await read($, lembrados)).includes(modulo.nome)) return undefined
  await update($, lembrados, list => [...list, modulo.nome])

  return lembrete(modulo)
}

export const register: Register = on => {
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const texto = await lembreteNovo($, e.file_path).catch(() => undefined)

    return texto ? { ...ran, context: [...(ran.context ?? []), texto] } : ran
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const texto = await lembreteNovo($, e.file_path).catch(() => undefined)

    return texto ? { ...ran, context: [...(ran.context ?? []), texto] } : ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const texto = await lembreteNovo($, e.file_path).catch(() => undefined)

    return texto ? { ...ran, context: [...(ran.context ?? []), texto] } : ran
  })
}
