import { describe, expect, test } from 'claude-code/testing'

import { blockedReason, isSecretFile } from './rules.ts'

describe('kidmais-guard', () => {
  test('protege arquivos .env, menos o exemplo', async () => {
    expect(isSecretFile('/repo/.env.local')).toBe(true)
    expect(isSecretFile('.env')).toBe(true)
    expect(isSecretFile('.env.example')).toBe(false)
    expect(isSecretFile('lib/env.ts')).toBe(false)
  })

  test('bloqueia comandos perigosos', async () => {
    expect(blockedReason('node --env-file=.env.production scripts/x.cjs')).toBeDefined()
    expect(blockedReason('node scripts/migration-016.apply.cjs')).toBeDefined()
    expect(blockedReason('git push --force origin main')).toBeDefined()
    expect(blockedReason('git push origin main')).toBeDefined()
    expect(blockedReason('psql -c "DROP TABLE festas"')).toBeDefined()
  })

  test('libera o dia a dia', async () => {
    expect(blockedReason('npm run lint')).toBeUndefined()
    expect(blockedReason('npx tsc --noEmit')).toBeUndefined()
    expect(blockedReason('git push -u origin claude/minha-branch')).toBeUndefined()
    expect(blockedReason('node scripts/migration-016.integration.cjs')).toBeUndefined()
  })

  test('nega Bash perigoso pela cadeia de hooks', async ($, on) => {
    let reached = false
    on('tool.call', () => {
      reached = true
      return { deny: 'engine' }
    })
    const ran = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    expect(JSON.stringify(ran)).toContain('kidmais-guard')
    expect(reached).toBe(false)
  })
})
