import { z } from "zod";
import type { DbExecutor } from "../../db/contracts.ts";
import { relacoesContratoDoTenant, ultimosContratosDoTenant, type RelacoesContrato } from "../../contratos/services/leitura-tenant.ts";
import { reaisDe } from "../../financeiro/calculos.ts";
import { listarRecebiveis } from "../../financeiro/servico.ts";
import type { EntidadeRef, RespostaLeitura } from "../contratos.ts";
import type { ContextoFerramenta, Ferramenta, PosicaoContratoDominio } from "../ferramentas.ts";
import { InteligenciaError } from "../politica.ts";
import { montarDestino } from "../rotas-navegacao.ts";
import { PAPEIS_ADMIN, ausencia, calculo, comEntidade, dataCurta, fato, montarResposta, plural } from "./comum.ts";

/**
 * Leituras de pagamentos e contratos (AI V1.1, PR 5.5), somente leitura:
 * - `saldo_contrato`: posição OFICIAL do contrato (`lerPosicaoFinanceira` + `situacaoCobranca`, pela porta).
 * - `proxima_parcela`: do contrato (cronograma em aberto da mesma posição) ou, sem contrato, da empresa
 *   (`listarRecebiveis`, a mesma fonte de Contas a receber).
 * - `ultimo_contrato`: critério do painel de Contratos (`criado_em DESC`, sem cancelados por padrão).
 *
 * Todo número vem do Core (centavos); a IA só formata. Posse na empresa comprovada antes de qualquer valor; outra
 * empresa ⇒ inexistente (404). Nenhuma escrita. O trace só recebe a contagem da leitura, nunca valores.
 */
const FONTE_POSICAO = "pagamentos.posicao_oficial";
const FONTE_RECEBIVEIS = "financeiro.recebiveis";
const FONTE_CONTRATOS = "contratos.painel";

const centavos = (valor: string) => Number(BigInt(valor));
const naoEncontrado = () => new InteligenciaError("NAO_ENCONTRADO", "Contrato não encontrado.", 404);

function rotuloContrato(r: Pick<RelacoesContrato, "cliente" | "dataEvento" | "versaoVigente">): string {
  return `Contrato${r.versaoVigente ? ` V${r.versaoVigente}` : ""}${r.cliente ? ` — ${r.cliente}` : ""}${r.dataEvento ? ` — ${dataCurta(r.dataEvento)}` : ""}`.slice(0, 120);
}

function entidadeContrato(r: RelacoesContrato): EntidadeRef {
  return {
    tipo: "CONTRATO", id: r.contratoId, rotulo: rotuloContrato(r), tela: "contrato",
    relacoes: { ...(r.clienteId ? { cliente: r.clienteId } : {}), ...(r.festaId ? { festa: r.festaId } : {}) },
  };
}

/** Posse no tenant (relações) + posição oficial. */
async function posicaoDoContrato(tx: DbExecutor, empresaId: string, id: string, contexto: ContextoFerramenta) {
  const relacoes = await relacoesContratoDoTenant(tx, empresaId, id);
  if (!relacoes) throw naoEncontrado();
  const porta = contexto.portas.financeiro;
  const posicao = porta ? await porta.posicaoContrato(tx, empresaId, id) : "SEM_OBRIGACAO";
  if (posicao === null) throw naoEncontrado();
  return { relacoes, posicao };
}

function semPlano(capacidade: string, relacoes: RelacoesContrato, contexto: ContextoFerramenta): RespostaLeitura {
  return montarResposta(capacidade, contexto, {
    estado: "sem_dados",
    resumo: `${rotuloContrato(relacoes)}: ainda não há plano financeiro registrado.`,
    fatos: [ausencia("Contrato sem obrigação financeira criada.", FONTE_POSICAO)],
    fontes: [FONTE_POSICAO],
    entidades: [entidadeContrato(relacoes)],
  });
}

function situacao(p: PosicaoContratoDominio): string {
  if (p.encerrada) return p.acertoAdministrativoPendente ? "Contrato encerrado, com acerto administrativo pendente." : "Contrato encerrado: nada a cobrar.";
  return centavos(p.saldoACobrarCentavos) > 0 ? "Em aberto." : "Quitado.";
}

export const saldoContrato: Ferramenta<RespostaLeitura> = {
  nome: "pagamentos.saldo_contrato",
  capacidade: "saldo_contrato",
  classe: "READ",
  grupo: "READ",
  entrada: comEntidade,
  papeis: PAPEIS_ADMIN,
  entidade: "contrato",
  descricao: "Quanto já foi pago e quanto falta pagar de um contrato (posição financeira oficial).",
  preparar(bruto) {
    const { id } = comEntidade.parse(bruto);
    return async (tx, tenant, contexto) => {
      const { relacoes, posicao } = await posicaoDoContrato(tx, tenant.empresaComprovada, id, contexto);
      if (posicao === "SEM_OBRIGACAO") return semPlano("saldo_contrato", relacoes, contexto);
      const aberto = centavos(posicao.saldoACobrarCentavos);
      const parcelas = posicao.parcelasAbertas.length;
      return montarResposta("saldo_contrato", contexto, {
        estado: aberto > 0 ? "atencao" : "em_dia",
        resumo: aberto > 0
          ? `Falta pagar ${reaisDe(aberto)} de ${reaisDe(centavos(posicao.obrigacaoCentavos))} (${rotuloContrato(relacoes)}).`
          : `${rotuloContrato(relacoes)}: ${situacao(posicao).toLowerCase().replace(/\.$/, "")}.`,
        fatos: [
          fato(`Valor contratado: ${reaisDe(centavos(posicao.obrigacaoCentavos))}.`, FONTE_POSICAO),
          fato(`Valor pago (líquido): ${reaisDe(centavos(posicao.recebidoLiquidoCentavos))}.`, FONTE_POSICAO),
          calculo(`Em aberto: ${reaisDe(aberto)}, em ${parcelas} ${plural(parcelas, "parcela", "parcelas")}.`, FONTE_POSICAO),
          fato(`Situação: ${situacao(posicao)}`, FONTE_POSICAO),
        ],
        itens: [{ id: "contrato", prioridade: aberto > 0 ? "media" : "baixa", titulo: rotuloContrato(relacoes), detalhe: situacao(posicao), destino: montarDestino("contrato", relacoes.contratoId) }],
        fontes: [FONTE_POSICAO],
        entidades: [entidadeContrato(relacoes)],
      });
    };
  },
};

const entradaParcela = z.object({ id: z.string().uuid().optional() }).strict();

export const proximaParcela: Ferramenta<RespostaLeitura> = {
  nome: "pagamentos.proxima_parcela",
  capacidade: "proxima_parcela",
  classe: "READ",
  grupo: "READ",
  entrada: entradaParcela,
  papeis: PAPEIS_ADMIN,
  descricao: "Próxima parcela a vencer (de um contrato ou da empresa), com vencimento, valor e situação.",
  preparar(bruto) {
    const { id } = entradaParcela.parse(bruto);
    return async (tx, tenant, contexto) => {
      if (id) {
        const { relacoes, posicao } = await posicaoDoContrato(tx, tenant.empresaComprovada, id, contexto);
        if (posicao === "SEM_OBRIGACAO") return semPlano("proxima_parcela", relacoes, contexto);
        const vencidas = posicao.parcelasAbertas.filter((p) => p.vencimento < contexto.hoje);
        const proxima = posicao.parcelasAbertas.find((p) => p.vencimento >= contexto.hoje) ?? null;
        return respostaParcela(contexto, proxima ? { numero: proxima.numero, vencimento: proxima.vencimento, valorCentavos: centavos(proxima.valorCentavos) } : null, vencidas.length, FONTE_POSICAO, [entidadeContrato(relacoes)], rotuloContrato(relacoes));
      }
      // Sem contrato: a empresa inteira, pela mesma fonte de Contas a receber (parcelas de contrato em aberto).
      const abertas = (await listarRecebiveis(tx, tenant.empresaComprovada, contexto.hoje))
        .filter((r) => r.origem !== "ENTRADA_MANUAL" && r.saldoCentavos > 0 && r.status !== "Cancelado" && r.status !== "Pago" && r.status !== "Reembolsado")
        .sort((a, b) => a.vencimento.localeCompare(b.vencimento) || a.parcela - b.parcela);
      const vencidas = abertas.filter((r) => r.vencimento < contexto.hoje).length;
      const proxima = abertas.find((r) => r.vencimento >= contexto.hoje) ?? null;
      const entidades: EntidadeRef[] = proxima?.festaId && /^[0-9a-f-]{36}$/i.test(proxima.festaId) ? [{ tipo: "FESTA", id: proxima.festaId, rotulo: `Festa de ${proxima.cliente}`.slice(0, 120), tela: "festa" }] : [];
      return respostaParcela(contexto, proxima ? { numero: proxima.parcela, vencimento: proxima.vencimento, valorCentavos: proxima.saldoCentavos, cliente: proxima.cliente } : null, vencidas, FONTE_RECEBIVEIS, entidades, null);
    };
  },
};

function respostaParcela(
  contexto: ContextoFerramenta,
  proxima: { numero: number; vencimento: string; valorCentavos: number; cliente?: string } | null,
  vencidas: number,
  fonte: string,
  entidades: EntidadeRef[],
  doContrato: string | null,
): RespostaLeitura {
  const alerta = vencidas ? [fato(`${vencidas} ${plural(vencidas, "parcela vencida", "parcelas vencidas")} em aberto.`, fonte)] : [];
  if (!proxima) {
    return montarResposta("proxima_parcela", contexto, {
      estado: vencidas ? "atencao" : "sem_dados",
      resumo: `Não há parcela a vencer${doContrato ? ` em ${doContrato}` : ""}.${vencidas ? ` Há ${vencidas} ${plural(vencidas, "vencida", "vencidas")} em aberto.` : ""}`,
      fatos: [ausencia("Nenhuma parcela em aberto com vencimento a partir de hoje.", fonte), ...alerta],
      fontes: [fonte],
      entidades,
    });
  }
  const quem = proxima.cliente ? ` (${proxima.cliente})` : doContrato ? ` (${doContrato})` : "";
  return montarResposta("proxima_parcela", contexto, {
    estado: vencidas ? "atencao" : "informativo",
    resumo: `A próxima parcela a vencer é a ${proxima.numero}ª, em ${dataCurta(proxima.vencimento)}, de ${reaisDe(proxima.valorCentavos)}${quem}.`,
    fatos: [fato(`Parcela ${proxima.numero}: vence em ${dataCurta(proxima.vencimento)}, em aberto ${reaisDe(proxima.valorCentavos)}.`, fonte), ...alerta],
    fontes: [fonte],
    entidades,
  });
}

const entradaUltimo = z.object({ incluirCancelados: z.boolean().optional() }).strict();

export const ultimoContrato: Ferramenta<RespostaLeitura> = {
  nome: "contratos.ultimo",
  capacidade: "ultimo_contrato",
  classe: "READ",
  grupo: "READ",
  entrada: entradaUltimo,
  papeis: PAPEIS_ADMIN,
  descricao: "O contrato mais recente da empresa (mesma ordem do painel de Contratos).",
  preparar(bruto) {
    const { incluirCancelados } = entradaUltimo.parse(bruto);
    return async (tx, tenant, contexto) => {
      const recentes = await ultimosContratosDoTenant(tx, tenant.empresaComprovada, { limite: 2, incluirCancelados });
      const entidade = (c: (typeof recentes)[number]): EntidadeRef => ({
        tipo: "CONTRATO", id: c.contratoId, rotulo: rotuloContrato({ cliente: c.cliente, dataEvento: c.dataEvento, versaoVigente: null }), tela: "contrato",
        relacoes: { ...(c.clienteId ? { cliente: c.clienteId } : {}), ...(c.festaId ? { festa: c.festaId } : {}) },
      });
      if (!recentes.length) {
        return montarResposta("ultimo_contrato", contexto, { estado: "sem_dados", resumo: "Ainda não há contratos registrados.", fatos: [ausencia("Nenhum contrato no painel.", FONTE_CONTRATOS)], fontes: [FONTE_CONTRATOS], entidades: [] });
      }
      // Empate no instante de criação: devolve os dois, sem escolher.
      if (recentes.length > 1 && recentes[0].criadoEm === recentes[1].criadoEm) {
        return montarResposta("ultimo_contrato", contexto, {
          estado: "informativo",
          resumo: `Dois contratos foram criados no mesmo instante: ${recentes.map((c) => entidade(c).rotulo).join(" e ")}.`,
          fatos: recentes.map((c) => fato(`${entidade(c).rotulo}.`, FONTE_CONTRATOS)),
          itens: recentes.map((c, i) => ({ id: `contrato_${i}`, prioridade: "baixa" as const, titulo: entidade(c).rotulo, detalhe: "Contrato", destino: montarDestino("contrato", c.contratoId) })),
          fontes: [FONTE_CONTRATOS],
          entidades: recentes.map(entidade),
        });
      }
      const [c] = recentes;
      return montarResposta("ultimo_contrato", contexto, {
        estado: "informativo",
        resumo: `O contrato mais recente é ${entidade(c).rotulo}.`,
        fatos: [fato(`Criado em ${dataCurta(c.criadoEm.slice(0, 10))}; situação ${c.status === "ASSINADO" ? "assinado" : c.status === "CANCELADO" ? "cancelado" : "não assinado"}.`, FONTE_CONTRATOS)],
        itens: [{ id: "contrato", prioridade: "baixa", titulo: entidade(c).rotulo, detalhe: "Contrato mais recente", destino: montarDestino("contrato", c.contratoId) }],
        fontes: [FONTE_CONTRATOS],
        entidades: [entidade(c)],
      });
    };
  },
};
