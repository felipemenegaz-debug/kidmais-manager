import { describe, expect, test } from 'claude-code/testing'

import { areasOf, argvOf, scriptsFor } from './areas.ts'

describe('kidmais-gate', () => {
  test('sempre roda o gate do CI', async () => {
    expect(scriptsFor([])).toEqual(['lint', 'typecheck', 'check:v1:static'])
  })

  test('acrescenta os testes da área alterada, sem repetir', async () => {
    const scripts = scriptsFor([
      'lib/pagamentos/services/financeiro-core.ts',
      'lib/pagamentos/services/idempotencia.ts',
      'lib/contratos/documento/documento-core.ts',
    ])
    expect(scripts).toEqual(['lint', 'typecheck', 'check:v1:static', 'test:pagamentos', 'test:contrato'])
  })

  test('avisa sobre migrations', async () => {
    const [area] = areasOf(['database/migrations/017_x.sql'])
    expect(area?.name).toBe('banco')
    expect(area?.warn).toBeDefined()
  })

  test('typecheck usa tsc', async () => {
    expect(argvOf('typecheck')).toEqual(['npx', 'tsc', '--noEmit'])
    expect(argvOf('lint')).toEqual(['npm', 'run', '--silent', 'lint'])
  })
})
