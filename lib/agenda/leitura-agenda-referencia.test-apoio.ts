/**
 * SÓ PARA TESTES (O-2 / P3-1 do plano "Agenda: concorrência otimista do agregado"): o lerAgendaEscopo de origin/staging
 * a590d247 (lib/agenda/configuracao-unidade.ts:135–265), copiado sem mudança de SQL nem de mapeamento, como oráculo
 * da equivalência integral do DTO depois da troca para a projeção única. Única adaptação: o escopo vem do chamador
 * (escopoValido não é exportado). Não usar fora de testes.
 */
import type { DbExecutor } from "../db/contracts.ts";
import { listarConfiguracoesAgendaAtivas } from "../disponibilidade/repositories/disponibilidade.repository.ts";
import { combinadosInstalados } from "./salao-festa.ts";
import type { AgendaEscopo, CapacidadeTipo, EscopoConfiguravel, HorarioAgenda, Modo, SalaoCombinado } from "./configuracao-unidade.ts";

const TODOS_OS_DIAS = [1, 2, 3, 4, 5, 6, 7];
const SEM_UNIDADE = "00000000-0000-0000-0000-000000000000";
const hora = (texto: string) => texto.slice(0, 5);

async function festasFuturas(db: DbExecutor, ids: string[]) {
  const mapa = new Map<string, HorarioAgenda["festasFuturas"]>();
  if (ids.length === 0) return mapa;
  const r = await db.query<{ id: string; quantidade: number; proxima: string; ultima: string }>(
    `SELECT configuracao_agenda_id::text AS id, count(*)::int AS quantidade,
            min(data_evento)::text AS proxima, max(data_evento)::text AS ultima
       FROM fechamentos
      WHERE configuracao_agenda_id = ANY($1::uuid[])
        AND data_evento >= CURRENT_DATE
        AND status <> 'CANCELADO'
      GROUP BY configuracao_agenda_id`,
    [ids],
  );
  for (const l of r.rows) mapa.set(l.id, { quantidade: Number(l.quantidade), proxima: l.proxima, ultima: l.ultima });
  return mapa;
}

type LinhaHorario = {
  id: string;
  codigo: string;
  nome: string;
  inicio: string;
  fim: string;
  dias_semana: number[] | null;
  capacidade: number;
  desativado_a_partir_de: string | null;
  tolerancia_inicio_minutos: number;
  passo_inicio_minutos: number;
  ordem_exibicao: number;
};

async function horariosProprios(db: DbExecutor, empresaId: string, estabelecimentoId: string | null) {
  const r = await db.query<LinhaHorario>(
    `SELECT id::text AS id, codigo, nome, horario_inicio_padrao::text AS inicio, horario_fim_padrao::text AS fim,
            dias_semana, capacidade, desativado_a_partir_de::text AS desativado_a_partir_de,
            tolerancia_inicio_minutos, passo_inicio_minutos, ordem_exibicao
       FROM configuracao_agenda
      WHERE ativo AND NOT horario_livre
        AND empresa_id = $1::uuid
        AND coalesce(estabelecimento_id, $3::uuid) = coalesce($2::uuid, $3::uuid)
      ORDER BY ordem_exibicao, codigo`,
    [empresaId, estabelecimentoId, SEM_UNIDADE],
  );
  return r.rows;
}

async function saloesDoHorario(db: DbExecutor, ids: string[]) {
  const mapa = new Map<string, string[]>();
  if (ids.length === 0) return mapa;
  const r = await db.query<{ configuracao_agenda_id: string; salao_id: string }>(
    `SELECT configuracao_agenda_id::text AS configuracao_agenda_id, salao_id::text AS salao_id
       FROM configuracao_agenda_saloes WHERE configuracao_agenda_id = ANY($1::uuid[])`,
    [ids],
  );
  for (const l of r.rows) mapa.set(l.configuracao_agenda_id, [...(mapa.get(l.configuracao_agenda_id) ?? []), l.salao_id]);
  return mapa;
}

export async function lerAgendaReferencia(db: DbExecutor, empresaId: string, estabelecimentoId: string | null, escopo: EscopoConfiguravel): Promise<Omit<AgendaEscopo, "versaoAgenda">> {
  const config = await db.query<{
    modo: Modo; capacidade_tipo: CapacidadeTipo; limite_festas_dia: number | null; intervalo_minimo_minutos: number;
    configurado_por: string | null; configurado_em: string;
  }>(
    `SELECT c.modo, c.capacidade_tipo, c.limite_festas_dia, c.intervalo_minimo_minutos,
            u.nome AS configurado_por, c.configurado_em::text AS configurado_em
       FROM agenda_escopo_config c
       LEFT JOIN usuarios_administrativos u ON u.id = c.configurado_por
      WHERE c.empresa_id = $1::uuid AND coalesce(c.estabelecimento_id, $3::uuid) = coalesce($2::uuid, $3::uuid)`,
    [empresaId, estabelecimentoId, SEM_UNIDADE],
  );
  const v098 = await combinadosInstalados(db);
  const saloes = await db.query<{ id: string; nome: string; capacidade_convidados: number | null }>(
    `SELECT id::text AS id, nome, capacidade_convidados
       FROM agenda_saloes
      WHERE ativo AND empresa_id = $1::uuid AND coalesce(estabelecimento_id, $3::uuid) = coalesce($2::uuid, $3::uuid)${v098 ? " AND NOT combinado" : ""}
      ORDER BY ordem, nome`,
    [empresaId, estabelecimentoId, SEM_UNIDADE],
  );
  const combinados = v098 ? await combinadosDoEscopo(db, empresaId, estabelecimentoId) : [];
  const proprios = await horariosProprios(db, empresaId, estabelecimentoId);
  let horarios: HorarioAgenda[];
  if (proprios.length > 0) {
    const ids = proprios.map((h) => h.id);
    const [festas, ligacoes] = [await festasFuturas(db, ids), await saloesDoHorario(db, ids)];
    horarios = proprios.map((h) => ({
      id: h.id, codigo: h.codigo, nome: h.nome, inicio: hora(h.inicio), fim: hora(h.fim),
      dias: h.dias_semana?.map(Number) ?? TODOS_OS_DIAS, capacidade: Number(h.capacidade),
      desativadoAPartirDe: h.desativado_a_partir_de, saloes: ligacoes.get(h.id) ?? [], herdado: false,
      festasFuturas: festas.get(h.id) ?? { quantidade: 0, proxima: null, ultima: null },
    }));
  } else {
    // Ainda sem horários próprios: os que valem hoje (empresa ou modelos globais), para o assistente pré-preencher.
    const herdados = await listarConfiguracoesAgendaAtivas(db, { empresaId, estabelecimentoId });
    const festas = await festasFuturas(db, herdados.map((h) => h.id));
    horarios = herdados.map((h) => ({
      id: h.id, codigo: h.codigo, nome: h.nome, inicio: hora(h.horarioInicioPadrao), fim: hora(h.horarioFimPadrao),
      dias: h.diasSemana ?? TODOS_OS_DIAS, capacidade: 1, desativadoAPartirDe: h.desativadoAPartirDe ?? null,
      saloes: [], herdado: true, festasFuturas: festas.get(h.id) ?? { quantidade: 0, proxima: null, ultima: null },
    }));
  }
  const c = config.rows[0];
  return {
    escopo,
    config: c ? {
      modo: c.modo, capacidadeTipo: c.capacidade_tipo, limiteFestasDia: c.limite_festas_dia == null ? null : Number(c.limite_festas_dia),
      intervaloMinimoMinutos: Number(c.intervalo_minimo_minutos), configuradoPor: c.configurado_por, configuradoEm: c.configurado_em,
    } : null,
    saloes: saloes.rows.map((s) => ({ id: s.id, nome: s.nome, capacidadeConvidados: s.capacidade_convidados == null ? null : Number(s.capacidade_convidados) })),
    combinados,
    combinadosDisponiveis: v098,
    horarios,
  };
}

/** 098: combinados ativos do escopo, com a composição (membros na ordem dos salões) e a elegibilidade. */
async function combinadosDoEscopo(db: DbExecutor, empresaId: string, estabelecimentoId: string | null): Promise<SalaoCombinado[]> {
  const r = await db.query<{ id: string; nome: string; capacidade_convidados: number | null; membros: Array<{ id: string; nome: string; ativo: boolean }> }>(
    `SELECT c.id::text AS id, c.nome, c.capacidade_convidados,
            coalesce((SELECT json_agg(json_build_object('id', m.id::text, 'nome', m.nome, 'ativo', m.ativo) ORDER BY m.ordem, m.nome)
                        FROM agenda_saloes m WHERE m.id = ANY (c.membros)), '[]'::json) AS membros
       FROM agenda_saloes c
      WHERE c.combinado AND c.ativo AND c.empresa_id = $1::uuid AND coalesce(c.estabelecimento_id, $3::uuid) = coalesce($2::uuid, $3::uuid)
      ORDER BY c.ordem, c.nome`,
    [empresaId, estabelecimentoId, SEM_UNIDADE],
  );
  return r.rows.map((c) => ({
    id: c.id, nome: c.nome, capacidadeConvidados: c.capacidade_convidados == null ? null : Number(c.capacidade_convidados),
    membros: c.membros, elegivel: c.membros.length >= 2 && c.membros.every((m) => m.ativo),
  }));
}
