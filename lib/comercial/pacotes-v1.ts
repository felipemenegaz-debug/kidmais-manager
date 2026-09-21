export const PACOTES_CONTRATAVEIS_V1 = [
  { id: "pocket", codigo: "POCKET" },
  { id: "mini", codigo: "MINI_FESTA" },
  { id: "compacta", codigo: "COMPACTA" },
  { id: "essencial", codigo: "ESSENCIAL" },
  { id: "completa", codigo: "COMPLETA" },
  { id: "premium", codigo: "PREMIUM" },
  { id: "pizza_party_scienza", codigo: "PIZZA_PARTY" },
] as const;

const ids = new Set<string>(PACOTES_CONTRATAVEIS_V1.map((pacote) => pacote.id));
const codigos = new Set<string>(PACOTES_CONTRATAVEIS_V1.map((pacote) => pacote.codigo));

export function pacoteIdContratavelV1(id: string) {
  return ids.has(id.trim().toLowerCase());
}

export function pacoteCodigoContratavelV1(codigo: string) {
  return codigos.has(codigo.trim().toUpperCase());
}
