import type { ContratoSnapshotV1, ContratoSnapshotV2, ContratoSnapshotV3, PacoteAplicadoContrato } from "../repositories/models.ts";
import { SNAPSHOT_EXEMPLO } from "../modelo-empresa/exemplo.ts";

/**
 * S-E (plano S-E/S-D rev. 4.1): snapshots fictícios para os testes de documento com salão. V1/V2 e V3 sem salão
 * fixam o "antes"; V3 com salão (e com fotografia do pacote) exercita a V5, o resumo, o modelo da empresa e o convite.
 */
export const SNAP_V1: ContratoSnapshotV1 = {
  ...structuredClone(SNAPSHOT_EXEMPLO),
  evento: { ...structuredClone(SNAPSHOT_EXEMPLO.evento), pacote: { ...SNAPSHOT_EXEMPLO.evento.pacote, codigo: "COMPLETA", nome: "Festa Completa" } },
};

const pacoteAplicado = (nome: string): PacoteAplicadoContrato => ({
  snapshotId: "snap-salao-1", pacoteId: SNAP_V1.evento.pacote.id, codigo: "COMPLETA", nome, descricao: null, duracaoMinutos: 240,
  tabelaPreco: { id: "tabela-1", codigo: "TABELA_2026", nome: "Tabela 2026" },
  composicao: [{ tipo: "INCLUSO", codigo: "PENNE", nome: "Penne", modoItens: null, escolhasMin: null, escolhasMax: null }],
});

export const SNAP_V2: ContratoSnapshotV2 = {
  ...structuredClone(SNAP_V1), schemaVersao: 2,
  evento: { ...structuredClone(SNAP_V1.evento), pacote: { ...SNAP_V1.evento.pacote, nome: "Completa congelada V2" } },
  pacoteAplicado: pacoteAplicado("Completa congelada V2"),
};

const v3 = (salao: ContratoSnapshotV3["evento"]["salao"]): ContratoSnapshotV3 => ({
  ...structuredClone(SNAP_V1), schemaVersao: 3,
  evento: { ...structuredClone(SNAP_V1.evento), configuracaoAgendaId: "00000000-0000-4000-8000-0000000000aa", salao },
});

export const SNAP_V3_SEM_SALAO = v3(null);
export const SNAP_V3_COM_SALAO = v3({ id: "00000000-0000-4000-8000-0000000000bb", nome: "Jardim" });
export const SNAP_V3_PACOTE_CONGELADO: ContratoSnapshotV3 = {
  ...v3({ id: "00000000-0000-4000-8000-0000000000bb", nome: "Jardim" }),
  pacoteAplicado: pacoteAplicado("Completa congelada V3"),
};
SNAP_V3_PACOTE_CONGELADO.evento.pacote.nome = "Completa congelada V3";
