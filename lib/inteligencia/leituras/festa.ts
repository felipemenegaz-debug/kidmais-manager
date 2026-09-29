import { z } from "zod";
import { reaisDe } from "../../financeiro/calculos.ts";
import type { ItemResposta, RespostaLeitura } from "../contratos.ts";
import type { ContextoFerramenta, Ferramenta } from "../ferramentas.ts";
import { PAPEIS_ADMIN, ausencia, calculo, comEntidade, dataCurta, diasEntre, evidencia, fato, montarResposta, plural } from "./comum.ts";

/**
 * `resumir_festa`, `pendencias_da_festa` e `festa_em_risco`.
 *
 * Fonte única: `consultarFestas` (porta), que prova o tenant, exige a capacidade FESTA_CONSULTAR
 * e responde festa de outra empresa como inexistente. Roda fora da transação do gateway.
 * Do detalhe bruto só se leem os campos abaixo; nome, CPF e contatos do contratante não são usados.
 * O risco é uma regra determinística e explicável, não uma estimativa do modelo.
 */
const FONTE = "festas.detalhe";

const registro = z.object({ estado: z.string(), prioridade: z.string(), prazo: z.string().nullable().optional() }).passthrough();
const detalheSchema = z.object({
  festa: z.object({ id: z.string(), estado: z.string() }).passthrough(),
  contrato: z.object({
    status: z.string(),
    numero_versao: z.number().optional(),
    snapshot: z.object({
      evento: z.object({
        data: z.string(),
        horarioInicio: z.string().optional(),
        convidados: z.number().optional(),
        pacote: z.object({ nome: z.string() }).passthrough().optional(),
      }).passthrough(),
    }).passthrough(),
  }).passthrough(),
  itens: z.object({
    pendencias: z.array(registro.extend({ descricao: z.string() })).default([]),
    tarefas: z.array(registro.extend({ titulo: z.string() })).default([]),
    solicitacoes: z.array(z.object({ tipo: z.string() }).passthrough()).default([]),
  }).passthrough(),
  buffet: z.object({ campos: z.array(z.string()), valores: z.record(z.string(), z.string().nullable().optional()) }).passthrough().nullable().optional(),
  financeiroPendente: z.boolean().optional(),
  financeiro: z.object({ saldo: z.union([z.string(), z.number()]).optional() }).passthrough().nullable().optional(),
  excedentes: z.number().nullable().optional(),
  contratoAtualizado: z.boolean().optional(),
}).passthrough();

type Detalhe = z.infer<typeof detalheSchema>;

const ABERTA = (estado: string) => estado === "ABERTA" || estado === "EM_TRATAMENTO";
const PENDENTE = (estado: string) => estado === "PENDENTE";
const PESO: Readonly<Record<string, number>> = { CRITICA: 0, ATENCAO: 1, NORMAL: 2 };
const PRIORIDADE: Readonly<Record<string, ItemResposta["prioridade"]>> = { CRITICA: "alta", ATENCAO: "media", NORMAL: "baixa" };

function lerDetalhe(bruto: unknown): Detalhe | null {
  const lido = detalheSchema.safeParse(bruto);
  return lido.success ? lido.data : null;
}

function indisponivel(capacidade: string, contexto: ContextoFerramenta, motivo: string): RespostaLeitura {
  return montarResposta(capacidade, contexto, { estado: "sem_dados", resumo: "Não há dados suficientes para responder sobre esta festa.", fatos: [ausencia(motivo, FONTE)], fontes: [FONTE] });
}

function buffetPendente(d: Detalhe) {
  if (!d.buffet) return [] as string[];
  return d.buffet.campos.filter((campo) => !d.buffet!.valores[campo]?.trim());
}

function saldoCentavos(d: Detalhe) {
  const bruto = d.financeiro?.saldo;
  const n = typeof bruto === "number" ? bruto : Number(bruto);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function montarResumoFesta(d: Detalhe, contexto: ContextoFerramenta): RespostaLeitura {
  const destino = `/admin/festas/${d.festa.id}`;
  const e = d.contrato.snapshot.evento;
  const dias = diasEntre(contexto.hoje, e.data);
  const pendencias = d.itens.pendencias.filter((p) => ABERTA(p.estado));
  const tarefas = d.itens.tarefas.filter((t) => PENDENTE(t.estado));
  const buffet = buffetPendente(d);
  const saldo = saldoCentavos(d);
  const fatos = [
    fato(`Festa em ${dataCurta(e.data)}${e.horarioInicio ? ` às ${e.horarioInicio.slice(0, 5)}` : ""}${e.pacote ? `, pacote ${e.pacote.nome}` : ""}${e.convidados ? `, ${e.convidados} convidados` : ""}.`, FONTE),
    calculo(dias > 0 ? `Faltam ${dias} ${plural(dias, "dia", "dias")}.` : dias === 0 ? "A festa é hoje." : `A festa foi há ${-dias} ${plural(-dias, "dia", "dias")}.`, FONTE),
    fato(`Contrato ${d.contrato.status === "ASSINADO" ? "assinado" : d.contrato.status === "CANCELADO" ? "cancelado" : "ainda não assinado"}${d.contrato.numero_versao ? ` (V${d.contrato.numero_versao})` : ""}.`, FONTE),
    pendencias.length ? fato(`${pendencias.length} ${plural(pendencias.length, "pendência aberta", "pendências abertas")}.`, FONTE) : fato("Nenhuma pendência aberta.", FONTE),
    tarefas.length ? fato(`${tarefas.length} ${plural(tarefas.length, "tarefa pendente", "tarefas pendentes")}.`, FONTE) : fato("Nenhuma tarefa pendente.", FONTE),
    d.buffet ? (buffet.length ? fato(`Buffet sem definição em: ${buffet.join(", ")}.`, FONTE) : fato("Buffet definido.", FONTE)) : ausencia("Buffet não informado para esta festa.", FONTE),
    saldo == null ? ausencia("Sem plano financeiro vinculado a esta festa.", FONTE) : fato(`Saldo a receber do contrato: ${reaisDe(saldo)}.`, FONTE),
    ...(d.excedentes ? [fato(`${d.excedentes} ${plural(d.excedentes, "convidado excedente", "convidados excedentes")} na última contagem.`, FONTE)] : []),
    ...(d.contratoAtualizado ? [fato("O contrato foi atualizado depois da criação da festa.", FONTE)] : []),
  ];
  return montarResposta("resumir_festa", contexto, {
    estado: pendencias.length || tarefas.length || buffet.length ? "atencao" : "informativo",
    resumo: `${d.festa.estado === "CANCELADA" ? "Festa cancelada" : dias >= 0 ? `Festa em ${dias} ${plural(dias, "dia", "dias")}` : "Festa realizada"}: ${pendencias.length} ${plural(pendencias.length, "pendência", "pendências")}, ${tarefas.length} ${plural(tarefas.length, "tarefa", "tarefas")}${buffet.length ? ", buffet a definir" : ""}.`,
    fatos,
    evidencias: [
      evidencia(FONTE, "Pendências abertas", pendencias.length, destino),
      evidencia(FONTE, "Tarefas pendentes", tarefas.length, destino),
      evidencia(FONTE, "Campos de buffet sem definição", buffet.length, destino),
    ],
    fontes: [FONTE],
  });
}

export function montarPendenciasFesta(d: Detalhe, contexto: ContextoFerramenta): RespostaLeitura {
  const destino = `/admin/festas/${d.festa.id}`;
  const pendencias = d.itens.pendencias.filter((p) => ABERTA(p.estado)).sort((a, b) => (PESO[a.prioridade] ?? 3) - (PESO[b.prioridade] ?? 3));
  const tarefas = d.itens.tarefas.filter((t) => PENDENTE(t.estado)).sort((a, b) => (PESO[a.prioridade] ?? 3) - (PESO[b.prioridade] ?? 3));
  const buffet = buffetPendente(d);
  const itens: ItemResposta[] = [
    ...pendencias.map((p, i) => ({ id: `pendencia_${i}`, prioridade: PRIORIDADE[p.prioridade] ?? "baixa", titulo: p.descricao.slice(0, 140), detalhe: `Pendência${p.prazo ? ` · prazo ${dataCurta(p.prazo)}` : ""}`, destino })),
    ...tarefas.map((t, i) => ({ id: `tarefa_${i}`, prioridade: PRIORIDADE[t.prioridade] ?? "baixa", titulo: t.titulo.slice(0, 140), detalhe: `Tarefa${t.prazo ? ` · prazo ${dataCurta(t.prazo)}` : ""}`, destino })),
    ...(buffet.length ? [{ id: "buffet", prioridade: "media" as const, titulo: "Definir buffet", detalhe: buffet.join(", "), destino }] : []),
    ...(d.financeiroPendente ? [{ id: "financeiro", prioridade: "media" as const, titulo: "Pendência financeira em tratamento", detalhe: "Consulte o Financeiro da festa.", destino }] : []),
  ];
  const total = itens.length;
  return montarResposta("pendencias_da_festa", contexto, {
    estado: total ? "atencao" : "em_dia",
    resumo: total ? `${total} ${plural(total, "item precisa", "itens precisam")} de atenção nesta festa.` : "Nenhuma pendência aberta nesta festa.",
    fatos: [
      fato(`${pendencias.length} ${plural(pendencias.length, "pendência aberta", "pendências abertas")}, ${pendencias.filter((p) => p.prioridade === "CRITICA").length} crítica(s).`, FONTE),
      fato(`${tarefas.length} ${plural(tarefas.length, "tarefa pendente", "tarefas pendentes")}.`, FONTE),
      ...(d.buffet ? [] : [ausencia("Buffet não informado para esta festa.", FONTE)]),
    ],
    itens,
    evidencias: [evidencia(FONTE, "Itens em aberto", total, destino)],
    fontes: [FONTE],
  });
}

export type MotivoRisco = { nivel: "alto" | "medio"; texto: string };

/** Regras fixas e explicáveis. Cada motivo aponta um dado lido do domínio. */
export function avaliarRisco(d: Detalhe, hoje: string): MotivoRisco[] {
  const motivos: MotivoRisco[] = [];
  if (d.festa.estado === "CANCELADA" || d.festa.estado === "REMOVIDA") return motivos;
  const dias = diasEntre(hoje, d.contrato.snapshot.evento.data);
  if (dias < 0) return motivos;
  if (d.contrato.status !== "ASSINADO") motivos.push({ nivel: dias <= 15 ? "alto" : "medio", texto: `Contrato ainda não assinado, festa em ${dias} ${plural(dias, "dia", "dias")}.` });
  const pendencias = d.itens.pendencias.filter((p) => ABERTA(p.estado));
  const criticas = pendencias.filter((p) => p.prioridade === "CRITICA");
  if (criticas.length) motivos.push({ nivel: "alto", texto: `${criticas.length} ${plural(criticas.length, "pendência crítica aberta", "pendências críticas abertas")}.` });
  const atencao = pendencias.filter((p) => p.prioridade === "ATENCAO");
  if (atencao.length) motivos.push({ nivel: "medio", texto: `${atencao.length} ${plural(atencao.length, "pendência de atenção aberta", "pendências de atenção abertas")}.` });
  const atrasadas = d.itens.tarefas.filter((t) => PENDENTE(t.estado) && t.prazo && t.prazo.slice(0, 10) < hoje);
  if (atrasadas.length) motivos.push({ nivel: atrasadas.some((t) => t.prioridade === "CRITICA") ? "alto" : "medio", texto: `${atrasadas.length} ${plural(atrasadas.length, "tarefa com prazo vencido", "tarefas com prazo vencido")}.` });
  const buffet = buffetPendente(d);
  if (buffet.length && dias <= 10) motivos.push({ nivel: dias <= 3 ? "alto" : "medio", texto: `Buffet sem definição (${buffet.join(", ")}) a ${dias} ${plural(dias, "dia", "dias")} da festa.` });
  const saldo = saldoCentavos(d);
  if (saldo != null && saldo > 0 && dias <= 7) motivos.push({ nivel: "medio", texto: `Saldo de ${reaisDe(saldo)} a receber a ${dias} ${plural(dias, "dia", "dias")} da festa.` });
  if (d.financeiroPendente) motivos.push({ nivel: "medio", texto: "Pendência financeira em tratamento." });
  return motivos;
}

export function montarRiscoFesta(d: Detalhe, contexto: ContextoFerramenta): RespostaLeitura {
  const destino = `/admin/festas/${d.festa.id}`;
  const motivos = avaliarRisco(d, contexto.hoje);
  const nivel = motivos.some((m) => m.nivel === "alto") ? "alto" : motivos.length ? "medio" : "baixo";
  const dias = diasEntre(contexto.hoje, d.contrato.snapshot.evento.data);
  if (dias < 0 || d.festa.estado === "CANCELADA" || d.festa.estado === "REMOVIDA") {
    return montarResposta("festa_em_risco", contexto, { estado: "informativo", resumo: "Esta festa não está mais por acontecer; a análise de risco não se aplica.", fatos: [fato(`Situação: ${d.festa.estado}.`, FONTE)], fontes: [FONTE] });
  }
  return montarResposta("festa_em_risco", contexto, {
    estado: nivel === "baixo" ? "em_dia" : "atencao",
    resumo: nivel === "baixo" ? "Nenhum sinal de risco encontrado pelas regras de acompanhamento." : `Risco ${nivel}: ${motivos.length} ${plural(motivos.length, "motivo", "motivos")}.`,
    fatos: [
      calculo(`Classificação por regras fixas: contrato, pendências, tarefas vencidas, buffet, saldo e financeiro. Nível: ${nivel}.`, FONTE),
      ...motivos.map((m) => fato(m.texto, FONTE)),
    ],
    itens: motivos.map((m, i) => ({ id: `risco_${i}`, prioridade: m.nivel === "alto" ? "alta" as const : "media" as const, titulo: m.texto, detalhe: m.nivel === "alto" ? "Risco alto" : "Risco médio", destino })),
    evidencias: [evidencia(FONTE, "Motivos encontrados", motivos.length, destino)],
    fontes: [FONTE],
  });
}

function ferramentaFesta(nome: string, capacidade: string, descricao: string, montar: (d: Detalhe, c: ContextoFerramenta) => RespostaLeitura): Ferramenta<RespostaLeitura> {
  return {
    nome,
    capacidade,
    classe: "READ",
    grupo: "READ",
    papeis: PAPEIS_ADMIN,
    descricao,
    entidade: "festa",
    modo: "SERVICO_PROPRIO",
    preparar(parametros) {
      const { id } = comEntidade.parse(parametros);
      return async (_tenant, contexto) => {
        if (!contexto.portas.festas) return indisponivel(capacidade, contexto, "Serviço de festas indisponível para a IA.");
        const detalhe = lerDetalhe(await contexto.portas.festas.consultarDetalhe(id));
        if (!detalhe) return indisponivel(capacidade, contexto, "O detalhe da festa não trouxe os campos necessários.");
        return montar(detalhe, contexto);
      };
    },
  };
}

export const resumirFesta = ferramentaFesta("festas.resumir", "resumir_festa", "Data, contrato, pendências, tarefas, buffet e saldo da festa aberta.", montarResumoFesta);
export const pendenciasDaFesta = ferramentaFesta("festas.pendencias", "pendencias_da_festa", "Pendências, tarefas e definições que faltam na festa aberta.", montarPendenciasFesta);
export const festaEmRisco = ferramentaFesta("festas.risco", "festa_em_risco", "Sinais de risco da festa aberta, com o motivo de cada um.", montarRiscoFesta);
