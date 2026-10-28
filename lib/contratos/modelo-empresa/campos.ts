import { salaoDoSnapshot, type ContratoSnapshot } from "../repositories/models.ts";
import {
  formatarCep, formatarCondicaoPix, formatarCpf, formatarDataContrato, formatarFormaPagamento, formatarHorarioContrato,
  formatarMoeda, textoOuNaoInformado,
} from "../documento/formatters.ts";

/**
 * Campos que o modelo de contrato da empresa pode usar, como {{campo}}. Lista FECHADA: todo valor vem do snapshot
 * congelado da versão (o mesmo que tem hash), nunca de texto livre do modelo nem do PDF lido. Campo desconhecido
 * é recusado na revisão.
 */
export type CampoContrato = {
  chave: string;
  rotulo: string;
  grupo: "Contratante" | "Aniversariante" | "Festa" | "Valores" | "Contrato";
  exemplo: string;
  valor: (s: ContratoSnapshot, extra: { dataContrato: string }) => string;
};

const meses = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export function dataPorExtenso(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} de ${meses[Number(m[2]) - 1]} de ${m[1]}`;
}

function endereco(s: ContratoSnapshot) {
  const e = s.contratante.endereco;
  if (!e) return "Não informado";
  const complemento = e.complemento?.trim() ? `, ${e.complemento.trim()}` : "";
  return `${e.logradouro}, ${e.numero}${complemento} - ${e.bairro}, ${e.cidade}/${e.uf} - CEP ${formatarCep(e.cep)}`;
}

function duracao(s: ContratoSnapshot) {
  const minutos = s.evento.pacote.duracaoMinutos;
  if (!minutos) return "Não informada";
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h} horas`;
}

function condicao(s: ContratoSnapshot) {
  const c = s.comercial.condicaoPagamento;
  if (c?.forma === "PIX_PARCELADO") return formatarCondicaoPix(c.aprovada ?? c.pretendida ?? null);
  return formatarFormaPagamento(s.comercial.formaPagamentoPretendida);
}

export const CAMPOS_CONTRATO: readonly CampoContrato[] = [
  { chave: "contratante.nome", rotulo: "Nome do contratante", grupo: "Contratante", exemplo: "Maria da Silva", valor: (s) => s.contratante.nomeCompleto },
  { chave: "contratante.cpf", rotulo: "CPF do contratante", grupo: "Contratante", exemplo: "123.456.789-09", valor: (s) => formatarCpf(s.contratante.cpf) },
  { chave: "contratante.rg", rotulo: "RG do contratante", grupo: "Contratante", exemplo: "1.234.567", valor: (s) => textoOuNaoInformado(s.contratante.rg) },
  { chave: "contratante.telefone", rotulo: "Telefone do contratante", grupo: "Contratante", exemplo: "(61) 99999-0000", valor: (s) => textoOuNaoInformado(s.contratante.whatsapp ?? s.contratante.telefone) },
  { chave: "contratante.email", rotulo: "E-mail do contratante", grupo: "Contratante", exemplo: "maria@exemplo.com", valor: (s) => textoOuNaoInformado(s.contratante.email) },
  { chave: "contratante.endereco", rotulo: "Endereço do contratante", grupo: "Contratante", exemplo: "SQN 100, 10 - Asa Norte, Brasília/DF - CEP 70000-000", valor: endereco },
  { chave: "aniversariante.nome", rotulo: "Nome do aniversariante", grupo: "Aniversariante", exemplo: "Ana", valor: (s) => s.aniversariante.nome },
  { chave: "aniversariante.idade", rotulo: "Idade no dia da festa", grupo: "Aniversariante", exemplo: "6 anos", valor: (s) => s.aniversariante.idadeNoEvento == null ? "Não informada" : `${s.aniversariante.idadeNoEvento} ${s.aniversariante.idadeNoEvento === 1 ? "ano" : "anos"}` },
  { chave: "aniversariante.tema", rotulo: "Tema da festa", grupo: "Aniversariante", exemplo: "Fundo do mar", valor: (s) => textoOuNaoInformado(s.aniversariante.temaFesta) },
  { chave: "festa.pacote", rotulo: "Pacote contratado", grupo: "Festa", exemplo: "Festa Completa", valor: (s) => s.evento.pacote.nome },
  { chave: "festa.data", rotulo: "Data da festa", grupo: "Festa", exemplo: "24/10/2026", valor: (s) => formatarDataContrato(s.evento.data) },
  { chave: "festa.data_extenso", rotulo: "Data da festa por extenso", grupo: "Festa", exemplo: "24 de outubro de 2026", valor: (s) => dataPorExtenso(s.evento.data) },
  { chave: "festa.inicio", rotulo: "Horário de início", grupo: "Festa", exemplo: "17:00", valor: (s) => formatarHorarioContrato(s.evento.horarioInicio) },
  { chave: "festa.fim", rotulo: "Horário de término", grupo: "Festa", exemplo: "21:00", valor: (s) => formatarHorarioContrato(s.evento.horarioFim) },
  { chave: "festa.duracao", rotulo: "Duração do pacote", grupo: "Festa", exemplo: "4 horas", valor: duracao },
  { chave: "festa.convidados", rotulo: "Convidados contratados", grupo: "Festa", exemplo: "60", valor: (s) => String(s.evento.convidadosFaturados) },
  { chave: "festa.adicionais", rotulo: "Adicionais contratados", grupo: "Festa", exemplo: "Mesa de café (1); Bombom (20)", valor: (s) => s.contratacao.adicionais.length ? s.contratacao.adicionais.map((a) => `${a.nome} (${a.quantidade})`).join("; ") : "Nenhum" },
  // S-E (plano S-E/S-D rev. 4.1, R-E5): opcional (fora dos obrigatórios); vazio sem salão fixado (V1/V2, V3 nulo).
  { chave: "festa.salao", rotulo: "Salão da festa", grupo: "Festa", exemplo: "Jardim", valor: (s) => salaoDoSnapshot(s)?.nome ?? "" },
  { chave: "valor.total", rotulo: "Valor total do contrato", grupo: "Valores", exemplo: "R$ 9.990,00", valor: (s) => formatarMoeda(s.comercial.valorFinalContrato) },
  { chave: "valor.pacote", rotulo: "Valor do pacote", grupo: "Valores", exemplo: "R$ 9.190,00", valor: (s) => formatarMoeda(s.comercial.valorPacoteAplicado) },
  { chave: "valor.adicionais", rotulo: "Valor dos adicionais", grupo: "Valores", exemplo: "R$ 800,00", valor: (s) => formatarMoeda(s.comercial.valorAdicionais) },
  { chave: "pagamento.forma", rotulo: "Forma de pagamento", grupo: "Valores", exemplo: "PIX à vista", valor: (s) => formatarFormaPagamento(s.comercial.formaPagamentoPretendida) },
  { chave: "pagamento.condicao", rotulo: "Condição de pagamento", grupo: "Valores", exemplo: "Entrada: R$ 3.000,00; Valor da parcela: R$ 1.000,00; Quantidade: 7", valor: condicao },
  { chave: "contrato.data", rotulo: "Data do contrato por extenso", grupo: "Contrato", exemplo: "7 de outubro de 2026", valor: (_s, extra) => dataPorExtenso(extra.dataContrato) },
];

const PORCHAVE = new Map(CAMPOS_CONTRATO.map((c) => [c.chave, c]));

/**
 * Dados da festa e do valor que as CLÁUSULAS precisam usar (D1, plano modelo de contrato v3, 28/10/2026). Nome, CPF e
 * os demais dados das partes saem do bloco fixo de identificação (renderizar.ts), por isso não entram aqui.
 */
export const CAMPOS_OBRIGATORIOS = ["festa.data", "festa.inicio", "festa.fim", "festa.pacote", "festa.convidados", "valor.total", "pagamento.condicao"] as const;
export const REGRA_OBRIGATORIOS = "D1-20261028";

/** O que o bloco fixo de identificação já imprime em todo contrato (só para exibir; idade, tema e RG são opcionais, D2/D3). */
export const CAMPOS_IDENTIFICACAO = [
  "contratante.nome", "contratante.cpf", "contratante.rg", "contratante.telefone", "contratante.email", "contratante.endereco",
  "aniversariante.nome", "aniversariante.idade", "aniversariante.tema",
] as const;

export function rotuloDoCampo(chave: string) {
  return PORCHAVE.get(chave)?.rotulo ?? chave;
}

const MARCA = /\{\{\s*([a-z_]+(?:\.[a-z_]+)*)\s*\}\}/g;

/** Campos {{...}} usados num texto. */
export function camposUsados(texto: string): string[] {
  return [...texto.matchAll(MARCA)].map((m) => m[1]);
}

export function campoConhecido(chave: string) {
  return PORCHAVE.has(chave);
}

/** Troca cada {{campo}} pelo valor do snapshot. Campo desconhecido lança (a revisão já recusou antes). */
export function preencher(texto: string, s: ContratoSnapshot, extra: { dataContrato: string }) {
  return texto.replace(MARCA, (_m, chave: string) => {
    const campo = PORCHAVE.get(chave);
    if (!campo) throw new Error(`Campo desconhecido no modelo: ${chave}`);
    return campo.valor(s, extra);
  });
}
