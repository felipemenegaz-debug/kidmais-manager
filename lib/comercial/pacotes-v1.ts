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
