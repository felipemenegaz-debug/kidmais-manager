import { ARQUIVO } from "./apoio.test.ts";
import { extrairPorRegras } from "./extracao.ts";
import { aplicarRevisao, montarRevisao } from "./rascunho.ts";
import type { ExtracaoContrato } from "./modelo.ts";
import type { ImportacaoLida } from "./repositorio-importacao.ts";

/** Apoio da Entrega A (contratos de outras empresas, PF, PJ e sem endereço), compartilhado com a camada de IA. Sem testes próprios. */
export const CNPJ_CONTRATADA = "12.345.678/0001-95";
export const PF = [
  `CONTRATADA: Buffet Alegria Ltda, CNPJ ${CNPJ_CONTRATADA}, com sede na Rua das Flores, 10.\nCONTRATANTE: Paula Ramos, CPF 529.982.247-25, RG 1.234.567 SSP/DF, residente e domiciliada na Rua das Acácias, 120, apto 302, Asa Sul, Brasília/DF, CEP 70000-000, telefone (61) 98765-4321, e-mail paula@example.com.\nData do evento: 10/12/2026\nHorário: 14:00 às 18:00\nAniversariante: Lucas\n60 convidados\nPacote: Festa Completa\nValor total: R$ 5.000,00`,
];
export const PJ = [
  `CONTRATADA: Buffet Alegria Ltda, CNPJ ${CNPJ_CONTRATADA}.\nCONTRATANTE: Escola Pequeno Saber Ltda, inscrita no CNPJ 11.222.333/0001-81, com sede na Av. Central, 500, Centro, Goiânia/GO, CEP 74000-000, neste ato representada por Carla Dias, CPF 529.982.247-25, telefone (62) 99876-5432.\nData do evento: 10/12/2026\nHorário: 14:00 às 18:00\nAniversariante: Lucas\n60 convidados\nPacote: Festa Completa\nValor total: R$ 5.000,00`,
];
export const SEM_ENDERECO = [
  `CONTRATANTE: Paula Ramos, CPF 529.982.247-25, telefone (61) 98765-4321.\nData do evento: 10/12/2026\nHorário: 14:00 às 18:00\nAniversariante: Lucas\n60 convidados\nPacote: Festa Completa\nValor total: R$ 5.000,00`,
];
export const NOVO = { estado: "NOVO_CLIENTE" as const, clienteId: null, candidatos: [], motivo: "Nenhum cliente com estes dados." };

/** Confirma tudo o que pede revisão (como o operador faria), sem tocar nos recusados. */
export function confirmarTudo(extracao: ExtracaoContrato) {
  let atual = extracao; let revisados: string[] = [];
  for (const c of extracao.secoes.flatMap((s) => s.campos).filter((x) => x.estado === "PRECISA_REVISAO")) {
    const r = aplicarRevisao(atual, revisados, { campoId: c.id, ...(c.conflito ? { confirmarDivergencia: true as const } : {}) });
    if (!("erro" in r)) { atual = r.extracao; revisados = r.revisados; }
  }
  return { extracao: atual, revisados };
}

export function importacaoPj(): ImportacaoLida {
  const revisao = confirmarTudo(montarRevisao(extrairPorRegras(PJ), PJ, ARQUIVO)).extracao;
  return { id: "11111111-1111-4111-8111-111111111111", documentoId: "d", extracaoId: "e", status: "EM_REVISAO", versao: 4, clienteId: null, resultado: null, criadoPor: "u",
    dados: { extracao: revisao, revisados: revisao.secoes.flatMap((s) => s.campos).filter((c) => c.confirmacao).map((c) => c.id), decisaoCliente: null } } as unknown as ImportacaoLida;
}

