// Regras permanentes do Kidmais Manager (docs/08 e docs/05):
// não tocar produção sem autorização, migration remota nunca automática,
// segredos fora do alcance do agente.

export const isSecretFile = (path: string): boolean =>
  /(^|\/)\.env(\.|$)/.test(path) && !/(^|\/)\.env\.example$/.test(path)

const BLOCKED: readonly { pattern: RegExp; reason: string }[] = [
  {
    // Carregar ou ler o arquivo; citá-lo num texto (commit, docs) é liberado.
    pattern: /(--env-file[= ]|\bsource\s+|(^|[;&|]\s*)\.\s+|\b(cat|less|more|head|tail|cp|grep|dotenv|env-cmd)\b[^|;&]*\s)\S*\.env\.(production|prod)\b/,
    reason: 'usa credenciais de produção',
  },
  {
    // Só a execução; ler, buscar ou versionar o script continua liberado.
    pattern: /\b(node|npx|tsx|bun)\b[^|;&]*migration-\d+\.apply/,
    reason: 'aplica migration; migration remota nunca é automática',
  },
  {
    pattern: /\bprisma\s+(migrate\s+(deploy|reset)|db\s+push)\b/,
    reason: 'altera o schema do banco',
  },
  {
    pattern: /\b(node|npx|tsx|bun)\b[^|;&]*admin-provision\b/,
    reason: 'provisiona administradores',
  },
  {
    // SQL executado num cliente de banco; buscar o texto nos arquivos é liberado.
    pattern: /\b(psql|pgcli)\b[^|;&]*\b(DROP\s+(TABLE|SCHEMA|DATABASE)|TRUNCATE)\b/i,
    reason: 'apaga dados ou estrutura do banco',
  },
  {
    pattern: /\bgit\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b).*\bmain\b|\bgit\s+push\b.*\bmain\b.*(\s--force\b|\s-f\b)/,
    reason: 'force-push na main',
  },
  {
    pattern: /\bgit\s+push\s+\S+\s+(HEAD:)?main\b/,
    reason: 'push direto na main; use branch e PR',
  },
]

export const blockedReason = (command: string): string | undefined =>
  BLOCKED.find(rule => rule.pattern.test(command))?.reason
