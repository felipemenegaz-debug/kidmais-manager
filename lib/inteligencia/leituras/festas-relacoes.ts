import { z } from "zod";
import { relacoesContratoDoTenant } from "../../contratos/services/leitura-tenant.ts";
import { festaDoTenant, festasDoTenant, type FestaRelacionada } from "../../festas/leitura-tenant.ts";
import type { EntidadeRef, RespostaLeitura } from "../contratos.ts";
import type { ContextoFerramenta, Ferramenta } from "../ferramentas.ts";
import { InteligenciaError } from "../politica.ts";
import { montarDestino } from "../rotas-navegacao.ts";
import { PAPEIS_ADMIN, ausencia, comEntidade, dataCurta, fato, montarResposta, plural, somarDias } from "./comum.ts";

/**
 * Leituras-âncora (AI V1.1, PR 4): festas e relações do Core, com ENTIDADES estruturadas reutilizáveis.
 *
 * - `proximas_festas`: próximas (ASC, a partir de hoje) ou últimas (DESC, até ontem), com intervalo e limite validados.
 * - `relacoes_festa`: festa → cliente e festa → contrato (versão vigente e status).
 * - `relacoes_contrato`: contrato → cliente e contrato → festa, quando existir.
 *
 * Tenant: sempre a empresa comprovada (mesmo predicado da agenda e do Dashboard). Outra empresa ⇒ inexistente (404).
 * Relações vêm do Core, nunca do texto nem do modelo. Sem CPF, telefone, e-mail ou endereço. Nunca escrevem.
 */
const FONTE_FESTAS = "festas.agenda";
const FONTE_CONTRATOS = "contratos.versao_vigente";

const dataIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "data inválida");
const MAX_DIAS = 366;

const entradaProximas = z.object({
  ordem: z.enum(["ASC", "DESC"]).optional(),
  inicio: dataIso.optional(),
  fim: dataIso.optional(),
  limite: z.number().int().min(1).max(20).optional(),
}).strict().superRefine((e, ctx) => {
  if (e.inicio && e.fim) {
    if (e.inicio > e.fim) ctx.addIssue({ code: "custom", message: "inicio depois de fim" });
    const dias = (Date.parse(`${e.fim}T00:00:00Z`) - Date.parse(`${e.inicio}T00:00:00Z`)) / 86_400_000;
    if (dias > MAX_DIAS) ctx.addIssue({ code: "custom", message: "intervalo maior que um ano" });
  }
});

const hora = (h: string) => (h ? ` às ${h}` : "");
export function rotuloFesta(f: Pick<FestaRelacionada, "cliente" | "data" | "horaInicio">): string {
  return `Festa de ${f.cliente} — ${dataCurta(f.data)}${hora(f.horaInicio)}`.slice(0, 120);
}

function entidadesDaFesta(f: FestaRelacionada): EntidadeRef {
  return {
    tipo: "FESTA", id: f.festaId, rotulo: rotuloFesta(f), tela: "festa",
    relacoes: { contrato: f.contratoId, ...(f.clienteId ? { cliente: f.clienteId } : {}) },
  };
}

const naoEncontrado = (o: string) => new InteligenciaError("NAO_ENCONTRADO", `${o} não encontrada.`, 404);

export const proximasFestas: Ferramenta<RespostaLeitura> = {
  nome: "festas.proximas",
  capacidade: "proximas_festas",
  classe: "READ",
  grupo: "READ",
  entrada: entradaProximas,
  papeis: PAPEIS_ADMIN,
  descricao: "Próximas festas da empresa (ou as últimas), em ordem cronológica, com cliente e contrato.",
  preparar(bruto) {
    const e = entradaProximas.parse(bruto);
    const ordem = e.ordem ?? "ASC";
    const limite = e.limite ?? 5;
    return async (tx, tenant, contexto: ContextoFerramenta) => {
      // Sem intervalo: próximas a partir de hoje; últimas até ontem (a de hoje ainda não é "última").
      const inicio = e.inicio ?? (ordem === "ASC" ? contexto.hoje : null);
      const fim = e.fim ?? (ordem === "DESC" ? somarDias(contexto.hoje, -1) : null);
      const festas = await festasDoTenant(tx, tenant.empresaComprovada, { ordem, inicio, fim, limite });
      const rotuloConjunto = ordem === "ASC" ? "próxima" : "última";
      if (!festas.length) {
        return montarResposta("proximas_festas", contexto, {
          estado: "sem_dados",
          resumo: ordem === "ASC" ? "Não há festas futuras registradas." : "Não há festas anteriores registradas.",
          fatos: [ausencia(ordem === "ASC" ? "Nenhuma festa a partir de hoje." : "Nenhuma festa até ontem.", FONTE_FESTAS)],
          fontes: [FONTE_FESTAS],
          entidades: [],
        });
      }
      const [primeira] = festas;
      return montarResposta("proximas_festas", contexto, {
        estado: "informativo",
        resumo: festas.length === 1 || limite === 1
          ? `A ${rotuloConjunto} festa é em ${dataCurta(primeira.data)}${hora(primeira.horaInicio)}, cliente ${primeira.cliente}.`
          : `${festas.length} ${plural(festas.length, `${rotuloConjunto} festa`, `${rotuloConjunto}s festas`)}; a primeira é em ${dataCurta(primeira.data)}${hora(primeira.horaInicio)}.`,
        fatos: festas.map((f) => fato(`${dataCurta(f.data)}${hora(f.horaInicio)} · ${f.cliente} · ${f.pacote} · ${f.convidados} convidados`, FONTE_FESTAS)),
        itens: festas.map((f, i) => ({
          id: `festa_${i}`, prioridade: "baixa" as const, titulo: rotuloFesta(f),
          detalhe: `${f.pacote} · ${f.convidados} convidados · contrato ${f.contratoStatus === "ASSINADO" ? "assinado" : "não assinado"}`,
          destino: montarDestino("festa", f.festaId),
        })),
        fontes: [FONTE_FESTAS],
        entidades: festas.map(entidadesDaFesta),
      });
    };
  },
};

export const relacoesFesta: Ferramenta<RespostaLeitura> = {
  nome: "festas.relacoes",
  capacidade: "relacoes_festa",
  classe: "READ",
  grupo: "READ",
  entrada: comEntidade,
  papeis: PAPEIS_ADMIN,
  entidade: "festa",
  descricao: "Cliente e contrato de uma festa (relações do sistema).",
  preparar(bruto) {
    const { id } = comEntidade.parse(bruto);
    return async (tx, tenant, contexto) => {
      const f = await festaDoTenant(tx, tenant.empresaComprovada, id);
      if (!f) throw naoEncontrado("Festa");
      const contrato = `Contrato${f.versaoVigente ? ` V${f.versaoVigente}` : ""} ${f.contratoStatus === "ASSINADO" ? "assinado" : f.contratoStatus === "CANCELADO" ? "cancelado" : "ainda não assinado"}.`;
      return montarResposta("relacoes_festa", contexto, {
        estado: "informativo",
        resumo: `${rotuloFesta(f)}. Cliente: ${f.cliente}. ${contrato}`,
        fatos: [
          fato(`Data: ${dataCurta(f.data)}${hora(f.horaInicio)}; ${f.convidados} convidados; pacote ${f.pacote}.`, FONTE_FESTAS),
          f.clienteId ? fato(`Cliente: ${f.cliente}.`, FONTE_FESTAS) : ausencia("Festa sem cliente vinculado no fechamento.", FONTE_FESTAS),
          fato(contrato, FONTE_CONTRATOS),
        ],
        itens: [
          { id: "festa", prioridade: "baixa", titulo: rotuloFesta(f), detalhe: "Festa", destino: montarDestino("festa", f.festaId) },
          ...(f.clienteId ? [{ id: "cliente", prioridade: "baixa" as const, titulo: f.cliente, detalhe: "Cliente", destino: montarDestino("cliente", f.clienteId) }] : []),
          { id: "contrato", prioridade: "baixa", titulo: "Contrato", detalhe: contrato, destino: montarDestino("contrato", f.contratoId) },
        ],
        fontes: [FONTE_FESTAS, FONTE_CONTRATOS],
        entidades: [
          entidadesDaFesta(f),
          ...(f.clienteId ? [{ tipo: "CLIENTE" as const, id: f.clienteId, rotulo: f.cliente.slice(0, 120), tela: "cliente" as const, relacoes: { festa: f.festaId } }] : []),
          { tipo: "CONTRATO", id: f.contratoId, rotulo: `Contrato${f.versaoVigente ? ` V${f.versaoVigente}` : ""} — ${rotuloFesta(f)}`.slice(0, 120), tela: "contrato", relacoes: { festa: f.festaId, ...(f.clienteId ? { cliente: f.clienteId } : {}) } },
        ],
      });
    };
  },
};

export const relacoesContrato: Ferramenta<RespostaLeitura> = {
  nome: "contratos.relacoes",
  capacidade: "relacoes_contrato",
  classe: "READ",
  grupo: "READ",
  entrada: comEntidade,
  papeis: PAPEIS_ADMIN,
  entidade: "contrato",
  descricao: "Cliente e festa de um contrato (relações do sistema).",
  preparar(bruto) {
    const { id } = comEntidade.parse(bruto);
    return async (tx, tenant, contexto) => {
      const r = await relacoesContratoDoTenant(tx, tenant.empresaComprovada, id);
      if (!r) throw new InteligenciaError("NAO_ENCONTRADO", "Contrato não encontrado.", 404);
      const rotulo = `Contrato${r.versaoVigente ? ` V${r.versaoVigente}` : ""}${r.cliente ? ` — ${r.cliente}` : ""}${r.dataEvento ? ` — ${dataCurta(r.dataEvento)}` : ""}`.slice(0, 120);
      return montarResposta("relacoes_contrato", contexto, {
        estado: "informativo",
        resumo: `${rotulo}.${r.festaId ? " Festa vinculada." : " Ainda sem festa vinculada."}`,
        fatos: [
          r.clienteId ? fato(`Cliente: ${r.cliente}.`, FONTE_CONTRATOS) : ausencia("Contrato sem cliente vinculado no fechamento.", FONTE_CONTRATOS),
          r.festaId ? fato("Há uma festa ativa para este contrato.", FONTE_FESTAS) : ausencia("Nenhuma festa ativa para este contrato.", FONTE_FESTAS),
        ],
        itens: [
          { id: "contrato", prioridade: "baixa", titulo: rotulo, detalhe: "Contrato", destino: montarDestino("contrato", r.contratoId) },
          ...(r.clienteId ? [{ id: "cliente", prioridade: "baixa" as const, titulo: r.cliente ?? "Cliente", detalhe: "Cliente", destino: montarDestino("cliente", r.clienteId) }] : []),
          ...(r.festaId ? [{ id: "festa", prioridade: "baixa" as const, titulo: "Festa", detalhe: "Festa", destino: montarDestino("festa", r.festaId) }] : []),
        ],
        fontes: [FONTE_CONTRATOS, FONTE_FESTAS],
        entidades: [
          { tipo: "CONTRATO", id: r.contratoId, rotulo, tela: "contrato", relacoes: { ...(r.clienteId ? { cliente: r.clienteId } : {}), ...(r.festaId ? { festa: r.festaId } : {}) } },
          ...(r.clienteId ? [{ tipo: "CLIENTE" as const, id: r.clienteId, rotulo: (r.cliente ?? "Cliente").slice(0, 120), tela: "cliente" as const, relacoes: { contrato: r.contratoId } }] : []),
          ...(r.festaId ? [{ tipo: "FESTA" as const, id: r.festaId, rotulo: `Festa — ${rotulo}`.slice(0, 120), tela: "festa" as const, relacoes: { contrato: r.contratoId } }] : []),
        ],
      });
    };
  },
};
