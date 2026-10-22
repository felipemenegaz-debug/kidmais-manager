export const PACOTES_CONTRATAVEIS_V1 = [
  { id: "pocket", codigo: "POCKET" },
  { id: "mini", codigo: "MINI_FESTA" },
  { id: "compacta", codigo: "COMPACTA" },
  { id: "essencial", codigo: "ESSENCIAL" },
  { id: "completa", codigo: "COMPLETA" },
  { id: "premium", codigo: "PREMIUM" },
  { id: "pizza_party_scienza", codigo: "PIZZA_PARTY" },
] as const;

// Regra comercial vigente para novas consultas/edições; não regrava snapshots históricos.
export const LIMITES_PIZZA_PARTY = Object.freeze({ minimo: 20, maximo: 100 });
export function limitesPizzaParty(persistido?: { minimo: number | null; maximo: number | null } | null) {
  if (persistido?.minimo != null && persistido.maximo != null) return { minimo: persistido.minimo, maximo: persistido.maximo };
  return LIMITES_PIZZA_PARTY;
}

export function erroConvidadosPizzaParty(pacote: string, quantidade: number, persistido?: { minimo: number | null; maximo: number | null } | null) {
  if (!['PIZZA_PARTY', 'pizza_party_scienza'].includes(pacote)) return null;
  const limites = limitesPizzaParty(persistido);
  return !Number.isInteger(quantidade) || quantidade < limites.minimo || quantidade > limites.maximo
    ? `Pizza Party atende de ${limites.minimo} a ${limites.maximo} convidados. Informe uma quantidade inteira nesse intervalo.`
    : null;
}

const ids = new Set<string>(PACOTES_CONTRATAVEIS_V1.map((pacote) => pacote.id));
const codigos = new Set<string>(PACOTES_CONTRATAVEIS_V1.map((pacote) => pacote.codigo));

export function pacoteIdContratavelV1(id: string) {
  return ids.has(id.trim().toLowerCase());
}

export function pacoteCodigoContratavelV1(codigo: string) {
  return codigos.has(codigo.trim().toUpperCase());
}

/** Formato do código técnico do pacote (o mesmo da API de Pacotes): POCKET, P_9F…; nunca coincide com um id V1 (minúsculo). */
export const CODIGO_PACOTE_LIVRE = /^[A-Z][A-Z0-9_]{1,49}$/;

/**
 * Id do pacote vindo da tela → código no banco.
 * - Endereço atual da Kidmais (`porCodigo` falso, dona da agenda pública): só os sete ids V1, como antes.
 * - Endereço da empresa (/b/<código>) e agenda das demais empresas: id V1 (compatibilidade) ou o próprio código do
 *   pacote da empresa (P_…, POCKET importado). Formato só; a existência na empresa é provada pela busca por código.
 */
export function codigoDoPacoteDaTela(id: string, porCodigo: boolean): string | null {
  const v1 = PACOTES_CONTRATAVEIS_V1.find((pacote) => pacote.id === id);
  if (v1) return v1.codigo;
  return porCodigo && CODIGO_PACOTE_LIVRE.test(id) ? id : null;
}
