import type { DbExecutor } from "../db/contracts.ts";
import { escopoDaEmpresa } from "../disponibilidade/escopo.ts";
import { consultarDisponibilidadePeriodo } from "../disponibilidade/services/availability.service.ts";

/**
 * Sugestão de datas vagas para divulgação. SOMENTE LEITURA da agenda existente (mesmo serviço da agenda pública):
 * nada é reservado, bloqueado, precificado ou descontado. A tela apresenta como sugestão revisável; a decisão é humana.
 */
export type DataVaga = { data: string; diaSemana: number; horariosLivres: number; fimDeSemana: boolean };
export type SugestaoDatas = { disponivel: boolean; motivo: string | null; datas: DataVaga[]; escopo: "UNIDADE" | "EMPRESA" };

export function somarDias(iso: string, dias: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export async function sugerirDatasVagas(
  tx: DbExecutor, empresaId: string, unidadeId: string | null, hojeIso: string, dias = 60,
  deps = { escopoDaEmpresa, consultarDisponibilidadePeriodo },
): Promise<SugestaoDatas> {
  let escopo: { empresaId: string | null; estabelecimentoId: string | null };
  let nivel: SugestaoDatas["escopo"] = unidadeId ? "UNIDADE" : "EMPRESA";
  try {
    escopo = await deps.escopoDaEmpresa(tx, empresaId, unidadeId);
  } catch {
    // Unidade sem agenda própria (ex.: SUSPENSO, regra da 062): usa a agenda da empresa, e a tela diz isso.
    escopo = await deps.escopoDaEmpresa(tx, empresaId, null).catch(() => ({ empresaId, estabelecimentoId: null }));
    nivel = "EMPRESA";
  }
  const inicio = somarDias(hojeIso, 1);
  const fim = somarDias(hojeIso, Math.min(Math.max(dias, 7), 61));
  try {
    const agenda = await deps.consultarDisponibilidadePeriodo(inicio, fim, tx, undefined, escopo as never);
    const datas = agenda.map((d) => {
      const livres = d.periodos.reduce((soma, p) => soma + p.horarios.filter((h) => h.status === "DISPONIVEL").length, 0);
      const diaSemana = new Date(`${d.data}T12:00:00Z`).getUTCDay();
      return { data: d.data, diaSemana, horariosLivres: livres, fimDeSemana: diaSemana === 0 || diaSemana === 5 || diaSemana === 6 };
    }).filter((d) => d.horariosLivres > 0);
    return { disponivel: true, motivo: datas.length === 0 ? "Nenhum horário livre no período consultado." : null, datas, escopo: nivel };
  } catch {
    return { disponivel: false, motivo: "Agenda indisponível para sugestão (sem configuração de horários ou leitura recusada).", datas: [], escopo: nivel };
  }
}
