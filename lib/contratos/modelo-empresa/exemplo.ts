import type { ContratoSnapshotV1 } from "../repositories/models.ts";

/** Snapshot fictício para a PRÉVIA do modelo (nenhum dado real). Nunca é gravado nem assinado. */
export const SNAPSHOT_EXEMPLO: ContratoSnapshotV1 = {
  schemaVersao: 1,
  fechamento: { id: "00000000-0000-4000-8000-000000000001", status: "AGUARDANDO_CONTRATO", origem: "CLIENTE" },
  contratante: {
    clienteId: "00000000-0000-4000-8000-000000000002",
    nomeCompleto: "Maria da Silva (exemplo)",
    cpf: "12345678909",
    rg: "1.234.567",
    telefone: "61999990000",
    whatsapp: "(61) 99999-0000",
    email: "maria@exemplo.com",
    endereco: { cep: "70000000", logradouro: "SQN 100 Bloco A", numero: "10", complemento: null, bairro: "Asa Norte", cidade: "Brasília", uf: "DF" },
  },
  responsavelAdicional: null,
  aniversariante: { id: "00000000-0000-4000-8000-000000000003", nome: "Ana", dataNascimento: "2020-05-10", idadeNoEvento: 6, temaFesta: "Fundo do mar" },
  evento: {
    data: "2026-10-24", horarioInicio: "17:00", horarioFim: "21:00",
    pacote: { id: "00000000-0000-4000-8000-000000000004", codigo: "EXEMPLO", nome: "Festa Completa", duracaoMinutos: 240 },
    convidados: 60, convidadosFaturados: 60,
  },
  contratacao: {
    adicionais: [{ adicionalId: "00000000-0000-4000-8000-000000000005", nome: "Mesa de café", unidadeCobranca: "PACOTE", quantidade: 1, valorUnitario: 790, valorTotal: 790, observacoes: null }],
    alteracoesPacote: null, observacoesCliente: null, observacoesEquipe: null,
    buffet: { status: "PENDENTE", salgados: null, bebidas: null, doces: null, bolo: null, outros: null },
  },
  comercial: {
    tabelaPreco: { id: "00000000-0000-4000-8000-000000000006", codigo: "EXEMPLO", nome: "Tabela de exemplo" },
    categoriaHorario: "NOBRE", categoriaPrecoAplicada: "NOBRE",
    valorPacoteBase: 9990, descontoPercentual: 0, valorDescontoPacote: 0, valorPacoteAplicado: 9990, valorAdicionais: 790,
    valorTabela: 10780, valorNegociado: null, valorAprovado: null, valorFinalContrato: 10780, formaPagamentoPretendida: "PIX_AVISTA",
  },
};
