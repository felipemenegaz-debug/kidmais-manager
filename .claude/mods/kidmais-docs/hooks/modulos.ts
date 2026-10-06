// Pasta de código → documento oficial do módulo (docs/README.md).
export type Modulo = { nome: string; docs: readonly string[] }

const MODULOS: readonly { pattern: RegExp; modulo: Modulo }[] = [
  { pattern: /(^|\/)(lib\/(clientes|identidade)|app\/clientes|app\/api\/(admin\/clientes|identidade))\//, modulo: { nome: 'Clientes / CRM', docs: ['docs/modulos/CLIENTES-CRM.md'] } },
  { pattern: /(^|\/)(lib\/(disponibilidade|agenda)|app\/disponibilidade|app\/api\/(admin\/)?disponibilidade)\//, modulo: { nome: 'Disponibilidade', docs: ['docs/modulos/DISPONIBILIDADE.md'] } },
  { pattern: /(^|\/)(lib\/(fechamentos|comercial)|app\/fechamento|app\/api\/(admin\/)?fechamentos)\//, modulo: { nome: 'Fechamento', docs: ['docs/modulos/FECHAMENTO.md', 'docs/modulos/CONFIGURACOES.md'] } },
  { pattern: /(^|\/)(lib\/contratos|app\/contrato|app\/api\/(admin\/)?contratos)\//, modulo: { nome: 'Contratos', docs: ['docs/modulos/CONTRATOS.md'] } },
  { pattern: /(^|\/)(lib\/pagamentos|app\/api\/admin\/pagamentos)\//, modulo: { nome: 'Pagamentos', docs: ['docs/modulos/PAGAMENTOS.md'] } },
  { pattern: /(^|\/)(lib\/festas|app\/festas|app\/api\/admin\/festas)\//, modulo: { nome: 'Festas', docs: ['docs/modulos/FESTAS.md', 'docs/modulos/BUFFET.md'] } },
  { pattern: /(^|\/)(lib\/autenticacao|app\/api\/admin\/autenticacao|lib\/http)\//, modulo: { nome: 'Segurança', docs: ['docs/04-SEGURANCA-E-AUDITORIA.md', 'docs/arquitetura/PERMISSOES.md'] } },
  { pattern: /(^|\/)(database|kidmais-crm-migrations)\//, modulo: { nome: 'Banco', docs: ['docs/02-ARQUITETURA-SAAS.md'] } },
]

export const moduloDe = (path: string): Modulo | undefined =>
  MODULOS.find(one => one.pattern.test(path))?.modulo

export const lembrete = (modulo: Modulo): string =>
  `kidmais-docs: este arquivo é do módulo ${modulo.nome}. Antes de alterar regra, leia ${modulo.docs.join(' e ')} ` +
  '(fonte oficial; documentos RELATORIO_/README_ da raiz são histórico). Se a regra mudar, atualize esses docs e docs/06-CHANGELOG-FUNCIONAL.md.'
