// Mapeia o caminho alterado para a área do produto e os testes da área.
export type Area = { name: string; scripts: readonly string[]; warn?: string }

const AREAS: readonly { pattern: RegExp; area: Area }[] = [
  { pattern: /(^|\/)lib\/pagamentos\//, area: { name: 'pagamentos', scripts: ['test:pagamentos'] } },
  { pattern: /(^|\/)lib\/contratos\//, area: { name: 'contratos', scripts: ['test:contrato'] } },
  { pattern: /(^|\/)lib\/comercial\//, area: { name: 'comercial', scripts: ['test:comercial:pagamento'] } },
  { pattern: /(^|\/)lib\/disponibilidade\//, area: { name: 'disponibilidade', scripts: ['test:disponibilidade'] } },
  {
    pattern: /(^|\/)(database|prisma|kidmais-crm-migrations)\/|\.sql$/,
    area: { name: 'banco', scripts: [], warn: 'migration: revisar backfill, rollback e clone antes de produção' },
  },
  {
    pattern: /(^|\/)lib\/(autenticacao|identidade)\//,
    area: { name: 'segurança', scripts: [], warn: 'auth/identidade: revisar isolamento por empresa e IDOR' },
  },
]

// O mesmo gate do CI (.github/workflows/ci.yml).
export const BASE_SCRIPTS = ['lint', 'typecheck', 'check:v1:static'] as const

export const areaOf = (path: string): Area | undefined =>
  AREAS.find(one => one.pattern.test(path))?.area

export const areasOf = (paths: readonly string[]): Area[] => {
  const byName = new Map<string, Area>()
  for (const path of paths) {
    const area = areaOf(path)
    if (area) byName.set(area.name, area)
  }

  return [...byName.values()]
}

export const scriptsFor = (paths: readonly string[]): string[] => [
  ...BASE_SCRIPTS,
  ...new Set(areasOf(paths).flatMap(area => area.scripts)),
]

export const argvOf = (script: string): string[] =>
  script === 'typecheck' ? ['npx', 'tsc', '--noEmit'] : ['npm', 'run', '--silent', script]
