import type { DbExecutor } from "../db/contracts.ts";
import { versaoConferenciaImportada } from "../contratos/assinatura-papel.ts";
import { rotuloSalao, salaoDoSnapshot, type ContratoSnapshot, type ContratoVersaoRecord } from "../contratos/repositories/models.ts";
import { buscarVersaoPorId } from "../contratos/repositories/contrato.repository.ts";
import { listarRecebiveisDoContrato, type Recebivel } from "../financeiro/servico.ts";
import { primeiroNome } from "./formato.ts";
import { camposBuffet, escolhasEfetivas, nomeComIdade, rotulosBuffet, type EscolhaBuffet } from "../festas/buffet.ts";
import { marcaDoContratoNaTransacao, type MarcaContrato } from "../contratos/marca-contrato.ts";
import { gerarResumoContratacaoPdfDaVersao } from "../contratos/services/documento.service.ts";
import { ContratoServiceError } from "../contratos/services/errors.ts";
import { adquirirDocumentoParaLeitura, materializarDocumento, type DocumentoAdquirido } from "../contratos/services/fluxo-publico.ts";
import { lerDocumento } from "../contratos/storage/postgres.ts";
import type { SessaoArea } from "./acesso.ts";

/**
 * F2 da área da família (sem migration): leitura do que a família vê, sempre a partir da SESSÃO (lerSessao), nunca de
 * ids do pedido. A festa é a da sessão; o contrato e a versão vêm da festa (versão VIGENTE, a assinada); o pacote prende
 * a empresa da sessão. Devolve só o mínimo para as telas: nada de CPF, telefone, e-mail, endereço, observações da equipe
 * nem valores unitários. O segundo responsável vê o mesmo que o contratante (decisão da proposta).
 */
export type EstadoParcela = "PAGA" | "EM_ABERTO" | "VENCIDA" | "FUTURA" | "CANCELADA";

export type ParcelaFamilia = {
  id: string;
  numero: number;
  vencimento: string;
  valorCentavos: number;
  pagoCentavos: number;
  saldoCentavos: number;
  estado: EstadoParcela;
  /** Pix disponível para esta parcela (saldo em aberto). */
  pix: boolean;
};

export type DocumentoFamilia =
  | { tipo: "contrato"; titulo: string }
  | { tipo: "resumo"; titulo: string }
  | { tipo: "comprovante"; id: string; titulo: string };

export type MinhaFesta = {
  festa: {
    data: string;
    horarioInicio: string;
    horarioFim: string;
    diasAteFesta: number;
    salao: string | null;
    aniversariante: string;
    tema: string | null;
    pacote: string;
    convidados: number;
    adicionais: Array<{ nome: string; quantidade: number }>;
    buffet: Array<{ campo: string; texto: string }>;
  };
  documentos: DocumentoFamilia[];
  assinadoEmPapel: boolean;
  pagamentos: {
    totalCentavos: number;
    pagoCentavos: number;
    saldoCentavos: number;
    parcelas: ParcelaFamilia[];
    proxima: ParcelaFamilia | null;
  };
};

/** Festa, contrato e versão vigente da sessão, presos à empresa da sessão. Null = a sessão não alcança mais a festa. */
export async function contratoDaSessao(tx: DbExecutor, sessao: SessaoArea): Promise<{ contratoId: string; versao: ContratoVersaoRecord } | null> {
  const linha = (await tx.query<{ contrato_id: string; versao_id: string | null }>(
    `SELECT c.id::text AS contrato_id, fl.versao_vigente_id::text AS versao_id
       FROM festas f
       JOIN contratos c ON c.id = f.contrato_id
       JOIN fechamentos fe ON fe.id = c.fechamento_id
       JOIN pacotes pac ON pac.id = fe.pacote_id AND pac.empresa_id = $2::uuid
       LEFT JOIN contrato_fluxos fl ON fl.contrato_id = c.id
      WHERE f.id = $1::uuid AND f.invalidada_em IS NULL AND c.status <> 'CANCELADO'`,
    [sessao.festaId, sessao.empresaId],
  )).rows[0];
  if (!linha?.versao_id) return null;
  const versao = await buscarVersaoPorId(linha.versao_id, tx);
  if (!versao || versao.contratoId !== linha.contrato_id || versao.status !== "ASSINADA") return null;
  return { contratoId: linha.contrato_id, versao };
}

export function estadoDaParcela(r: Pick<Recebivel, "status" | "saldoCentavos" | "vencimento">, hoje: string): EstadoParcela {
  if (r.status === "Cancelado" || r.status === "Reembolsado") return "CANCELADA";
  if (r.status === "Pago" || r.saldoCentavos <= 0) return "PAGA";
  if (r.status === "Vencido" || r.vencimento < hoje) return "VENCIDA";
  // "Em aberto": vence nos próximos 30 dias; depois disso, "futura".
  const limite = new Date(`${hoje}T12:00:00Z`);
  limite.setUTCDate(limite.getUTCDate() + 30);
  return r.vencimento <= limite.toISOString().slice(0, 10) ? "EM_ABERTO" : "FUTURA";
}

export function diasEntre(hoje: string, data: string) {
  return Math.round((Date.parse(`${data.slice(0, 10)}T12:00:00Z`) - Date.parse(`${hoje}T12:00:00Z`)) / 86400000);
}

export function resumoDosPagamentos(recebiveis: Recebivel[], hoje: string): MinhaFesta["pagamentos"] {
  const parcelas = recebiveis.map((r): ParcelaFamilia => {
    const estado = estadoDaParcela(r, hoje);
    return {
      id: r.id, numero: r.parcela, vencimento: r.vencimento, valorCentavos: r.valorCentavos,
      pagoCentavos: r.recebidoCentavos, saldoCentavos: Math.max(0, r.saldoCentavos), estado,
      pix: estado !== "PAGA" && estado !== "CANCELADA" && r.saldoCentavos > 0,
    };
  });
  const validas = parcelas.filter((p) => p.estado !== "CANCELADA");
  const totalCentavos = validas.reduce((s, p) => s + p.valorCentavos, 0);
  const pagoCentavos = validas.reduce((s, p) => s + p.pagoCentavos, 0);
  const saldoCentavos = validas.reduce((s, p) => s + p.saldoCentavos, 0);
  const proxima = validas.find((p) => p.saldoCentavos > 0) ?? null;
  return { totalCentavos, pagoCentavos, saldoCentavos, parcelas, proxima };
}

async function buffetCombinado(tx: DbExecutor, festaId: string, empresaId: string, snapshot: ContratoSnapshot) {
  const ids = (snapshot.contratacao?.adicionais ?? []).filter((a) => a.quantidade > 0).map((a) => a.adicionalId);
  const codigos = ids.length
    ? (await tx.query<{ codigo: string }>("SELECT codigo FROM adicionais WHERE id = ANY($1::uuid[]) AND (empresa_id = $2::uuid OR empresa_id IS NULL)", [ids, empresaId])).rows.map((r) => r.codigo)
    : [];
  const operacional = (await tx.query<Partial<Record<EscolhaBuffet, string | null>>>(
    "SELECT salgados, doces, bolo, bebidas, lembrancinha, empratado, bombom FROM festa_buffet WHERE festa_id = $1::uuid", [festaId])).rows[0] ?? null;
  const valores = escolhasEfetivas(snapshot.contratacao?.buffet ?? {}, operacional);
  return camposBuffet(snapshot.evento.pacote.codigo, codigos)
    .map((campo) => ({ campo: rotulosBuffet[campo], texto: (valores[campo] ?? "").trim() }))
    .filter((item) => item.texto !== "");
}

/** Comprovantes de assinatura da versão vigente (só eletrônica; papel não tem). */
export async function comprovantesDaVersao(tx: DbExecutor, versaoId: string) {
  return (await tx.query<{ id: string; parte: string }>(
    `SELECT comprovante_documento_id::text AS id, parte FROM contrato_assinaturas
      WHERE contrato_versao_id = $1::uuid AND comprovante_documento_id IS NOT NULL ORDER BY assinado_em, parte`,
    [versaoId],
  )).rows;
}

/** Tudo o que as quatro abas mostram, numa leitura só. Null = sessão sem festa alcançável (a página trata como saída). */
export async function lerMinhaFesta(tx: DbExecutor, sessao: SessaoArea, hoje: string): Promise<MinhaFesta | null> {
  const alvo = await contratoDaSessao(tx, sessao);
  if (!alvo) return null;
  const { versao, contratoId } = alvo;
  const s = versao.snapshot;
  const papel = versaoConferenciaImportada(versao);
  const salao = salaoDoSnapshot(s);
  const documentos: DocumentoFamilia[] = [];
  if (!papel) documentos.push({ tipo: "contrato", titulo: "Contrato assinado" });
  documentos.push({ tipo: "resumo", titulo: "Resumo da contratação" });
  if (!papel) {
    for (const c of await comprovantesDaVersao(tx, versao.id)) {
      documentos.push({ tipo: "comprovante", id: c.id, titulo: c.parte === "CLIENTE" ? "Comprovante da sua assinatura" : "Comprovante da assinatura do buffet" });
    }
  }
  const recebiveis = await listarRecebiveisDoContrato(tx, sessao.empresaId, contratoId, hoje);
  return {
    festa: {
      data: s.evento.data.slice(0, 10),
      horarioInicio: (s.evento.horarioInicio ?? "").slice(0, 5),
      horarioFim: (s.evento.horarioFim ?? "").slice(0, 5),
      diasAteFesta: diasEntre(hoje, s.evento.data),
      salao: salao ? rotuloSalao(salao.nome, true) : null,
      aniversariante: nomeComIdade({ aniversariante: { nome: primeiroNome(s.aniversariante?.nome), idadeNoEvento: s.aniversariante?.idadeNoEvento, dataNascimento: s.aniversariante?.dataNascimento }, evento: { data: s.evento.data } }),
      tema: s.aniversariante?.temaFesta?.trim() || null,
      pacote: s.evento.pacote.nome,
      convidados: s.evento.convidados,
      adicionais: (s.contratacao?.adicionais ?? []).filter((a) => a.quantidade > 0).map((a) => ({ nome: a.nome, quantidade: a.quantidade })),
      buffet: await buffetCombinado(tx, sessao.festaId, sessao.empresaId, s),
    },
    documentos,
    assinadoEmPapel: papel,
    pagamentos: resumoDosPagamentos(recebiveis, hoje),
  };
}

/**
 * Documento pela sessão (sem o token HMAC de 30 min do link público). `adquirir` faz todas as consultas na transação
 * do pedido; `materializar` roda depois do commit, só em memória (mesmo padrão D1 das rotas do painel).
 */
export type PedidoDocumento = { tipo: "contrato" } | { tipo: "resumo" } | { tipo: "comprovante"; id: string };

export type DocumentoAdquiridoFamilia =
  | { ok: true; tipo: "contrato"; documento: DocumentoAdquirido }
  | { ok: true; tipo: "resumo"; versao: ContratoVersaoRecord; marca: MarcaContrato }
  | { ok: true; tipo: "comprovante"; id: string; pdf: Buffer }
  | { ok: false; motivo: "NAO_ENCONTRADO" | "INDISPONIVEL" };

export async function adquirirDocumentoFamilia(tx: DbExecutor, sessao: SessaoArea, pedido: PedidoDocumento): Promise<DocumentoAdquiridoFamilia> {
  const alvo = await contratoDaSessao(tx, sessao);
  if (!alvo) return { ok: false, motivo: "NAO_ENCONTRADO" };
  const { versao, contratoId } = alvo;
  if (pedido.tipo === "resumo") return { ok: true, tipo: "resumo", versao, marca: await marcaDoContratoNaTransacao(tx, contratoId) };
  // Contrato em papel: sem PDF oficial nem comprovante digital (a prova é o original importado).
  if (versaoConferenciaImportada(versao)) return { ok: false, motivo: "NAO_ENCONTRADO" };
  if (pedido.tipo === "contrato") {
    try {
      return { ok: true, tipo: "contrato", documento: await adquirirDocumentoParaLeitura(versao, tx) };
    } catch (erro) {
      if (erro instanceof ContratoServiceError) return { ok: false, motivo: "INDISPONIVEL" };
      throw erro;
    }
  }
  // Comprovante: só um que pertença à versão vigente DESTE contrato.
  if (!(await comprovantesDaVersao(tx, versao.id)).some((c) => c.id === pedido.id)) return { ok: false, motivo: "NAO_ENCONTRADO" };
  try {
    const d = await lerDocumento(pedido.id, tx);
    if (d.contrato_versao_id !== versao.id) return { ok: false, motivo: "NAO_ENCONTRADO" };
    return { ok: true, tipo: "comprovante", id: d.id, pdf: d.conteudo_pdf };
  } catch (erro) {
    if (erro instanceof ContratoServiceError) return { ok: false, motivo: "INDISPONIVEL" };
    throw erro;
  }
}

/** Só memória: PDF e nome do arquivo. */
export function materializarDocumentoFamilia(a: Extract<DocumentoAdquiridoFamilia, { ok: true }>): { pdf: Buffer; arquivo: string } {
  if (a.tipo === "contrato") return { pdf: materializarDocumento(a.documento).pdf, arquivo: "contrato.pdf" };
  if (a.tipo === "resumo") return { pdf: gerarResumoContratacaoPdfDaVersao(a.versao, a.marca).pdf, arquivo: "resumo-da-contratacao.pdf" };
  return { pdf: a.pdf, arquivo: "comprovante.pdf" };
}
