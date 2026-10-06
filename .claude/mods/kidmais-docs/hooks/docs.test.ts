import { describe, expect, test } from 'claude-code/testing'

import { lembrete, moduloDe } from './modulos.ts'

describe('kidmais-docs', () => {
  test('mapeia pastas para o documento do módulo', async () => {
    expect(moduloDe('/repo/lib/pagamentos/services/financeiro-core.ts')?.docs).toEqual(['docs/modulos/PAGAMENTOS.md'])
    expect(moduloDe('app/api/admin/contratos/route.ts')?.nome).toBe('Contratos')
    expect(moduloDe('lib/festas/estrutura-016.ts')?.docs).toContain('docs/modulos/BUFFET.md')
    expect(moduloDe('README.md')).toBeUndefined()
  })

  test('o lembrete cita o doc e o changelog', async () => {
    const modulo = moduloDe('lib/contratos/x.ts')
    expect(modulo).toBeDefined()
    if (!modulo) return
    expect(lembrete(modulo)).toContain('docs/modulos/CONTRATOS.md')
    expect(lembrete(modulo)).toContain('06-CHANGELOG-FUNCIONAL')
  })

  test('lembra uma vez por módulo, depois de um Read', async ($, on) => {
    on('tool.call', () => ({ result: { type: 'text', file: { filePath: 'x', content: '', numLines: 0, startLine: 1, totalLines: 0 } } } as never))
    const first = await $.tool.call({ tool: 'Read', file_path: 'lib/pagamentos/a.ts' })
    const second = await $.tool.call({ tool: 'Read', file_path: 'lib/pagamentos/b.ts' })
    expect(JSON.stringify(first)).toContain('PAGAMENTOS.md')
    expect(JSON.stringify(second)).not.toContain('PAGAMENTOS.md')
  })
})
