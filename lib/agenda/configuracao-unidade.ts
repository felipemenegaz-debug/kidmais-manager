import type { DbExecutor } from "../db/contracts.ts";
import { auditarMutacaoComercial } from "../comercial/auditoria-comercial.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import { agendaPorEscopoInstalada, unidadesDaEmpresa } from "../disponibilidade/escopo.ts";
import { candidatasAgendaPorNivel } from "../disponibilidade/repositories/disponibilidade.repository.ts";
import { linhaDoTempo, type Trecho } from "./vigencias.ts";
import { combinadosInstalados } from "./salao-festa.ts";
import { membrosCanonicos } from "./saloes-conjuntos.ts";
import { pacoteSemSalaoNaAgendaPorSalao, SALAO_DE_AGENDA_POR_SALAO } from "./salao-do-pacote.ts";
import { versaoAgenda, type LinhaConfigProjecao, type LinhaHorarioProjecao, type LinhaSalaoProjecao, type NivelHeranca, type ProjecaoVersao } from "./versao-agenda.ts";
import { AGENDA_MAIS_DE_UM_SALAO_LIBERADA, AVISO_MAIS_DE_UM_SALAO_EM_BREVE, AVISO_SALAO_DO_PACOTE, AVISO_SALAO_DO_PACOTE_ORIGEM, AVISO_UM_SALAO, AVISO_VOLTA_UM_SALAO } from "./saloes-liberacao.ts";

/**
 * Configuração da agenda por unidade (093, etapa 2a das decisões de Felipe em 22/10/2026).
 * Escopo = unidade agendável (062) ou, sem unidade agendável, a própria empresa. O assistente da primeira entrada pode
 * ser respondido por qualquer usuário da unidade; depois, editar exige Gestão (conferido na rota).
 */
export type Modo = "FIXO" | "LIVRE";
export type CapacidadeTipo = "POR_HORARIO" | "POR_SALAO";

export type EscopoConfiguravel = { estabelecimentoId: string | null; nome: string; configurado: boolean };

export type HorarioAgenda = {
  id: string;
  codigo: string;
  nome: string;
  inicio: string;
  fim: string;
  dias: number[];
  capacidade: number;
  desativadoAPartirDe: string | null;
  saloes: string[];
  herdado: boolean;
  festasFuturas: { quantidade: number; proxima: string | null; ultima: string | null };
};

export type AgendaEscopo = {
  escopo: EscopoConfiguravel;
  config: null | {
    modo: Modo;
    capacidadeTipo: CapacidadeTipo;
    limiteFestasDia: number | null;
    intervaloMinimoMinutos: number;
    configuradoPor: string | null;
    configuradoEm: string;
  };
  /** Salões simples ativos (com a 098; sem ela, todos os ativos). */
  saloes: Array<{ id: string; nome: string; capacidadeConvidados: number | null }>;
  /** 098: salões combinados ativos ("salão inteiro" = A+B), com a composição; vazio sem a 098. */
  combinados: SalaoCombinado[];
  /** 098 instalada: a tela oferece criar salões combinados. */
  combinadosDisponiveis?: boolean;
  horarios: HorarioAgenda[];
  /** Versão do agregado do escopo (lib/agenda/versao-agenda.ts), da mesma leitura que gerou este objeto. */
  versaoAgenda: string;
};

export type SalaoCombinado = {
  id: string;
  nome: string;
  capacidadeConvidados: number | null;
  membros: Array<{ id: string; nome: string; ativo: boolean }>;
  /** Todos os membros ativos: pode receber festa nova. */
  elegivel: boolean;
};

/** D5: ocupação de hoje em diante (São Paulo, kidmais098_hoje) que impede desativar um salão. */
export type ImpedimentoSalao = { fechamentoId: string; data: string; inicio: string; fim: string; salao: string; remarcacao: boolean };

export type HorarioInformado = {
  id?: string;
  nome: string;
  inicio: string;
  fim: string;
  dias: number[];
  capacidade: number;
  /** Nomes dos salões (os ids nascem no mesmo salvamento). */
  saloes: string[];
};

export type SalvarAgenda = {
  estabelecimentoId: string | null;
  modo: Modo;
  capacidadeTipo: CapacidadeTipo;
  limiteFestasDia: number | null;
  intervaloMinimoMinutos: number;
  saloes: Array<{ id?: string; nome: string; capacidadeConvidados: number | null }>;
  horarios: HorarioInformado[];
  /** Versão que o usuário viu (GET). Ausente ou malformada = null: o save recusa com AGENDA_MUDOU, nunca pula a conferência. */
  versaoEsperada: string | null;
};

type Contexto = { empresaId: string; usuarioId: string; requestId: string };

const TODOS_OS_DIAS = [1, 2, 3, 4, 5, 6, 7];
const SEM_UNIDADE = "00000000-0000-0000-0000-000000000000";

export class AgendaConfiguracaoError extends PacoteAdminError {}

function recusar(code: string, message: string, status = 409): never {
  throw new AgendaConfiguracaoError(code, message, status);
}

const hora = (texto: string) => texto.slice(0, 5);
const minutos = (texto: string) => {
  const [h, m] = texto.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export async function agendaConfiguravelInstalada(db: DbExecutor) {
  const r = await db.query<{ ok: boolean }>(`SELECT to_regclass('public.agenda_escopo_config') IS NOT NULL AS ok`);
  return r.rows[0]?.ok === true && (await agendaPorEscopoInstalada(db));
}

/** Unidades agendáveis da empresa; sem nenhuma, a própria empresa é o único escopo. */
export async function escoposDaEmpresa(db: DbExecutor, empresaId: string): Promise<EscopoConfiguravel[]> {
  if (!(await agendaConfiguravelInstalada(db))) return [];
  const configurados = await db.query<{ estabelecimento_id: string | null }>(
    `SELECT estabelecimento_id::text AS estabelecimento_id FROM agenda_escopo_config WHERE empresa_id = $1::uuid`,
    [empresaId],
  );
  const feito = new Set(configurados.rows.map((l) => l.estabelecimento_id ?? SEM_UNIDADE));
  const unidades = await unidadesDaEmpresa(db, empresaId);
  if (unidades.length > 0) {
    return unidades.map((u) => ({ estabelecimentoId: u.id, nome: u.nome, configurado: feito.has(u.id) }));
  }
  const empresa = await db.query<{ nome: string }>(`SELECT nome FROM empresas WHERE id = $1::uuid`, [empresaId]);
  return [{ estabelecimentoId: null, nome: empresa.rows[0]?.nome ?? "Empresa", configurado: feito.has(SEM_UNIDADE) }];
}

async function escopoValido(db: DbExecutor, empresaId: string, estabelecimentoId: string | null) {
  const escopos = await escoposDaEmpresa(db, empresaId);
  if (escopos.length === 0) recusar("AGENDA_CONFIGURAVEL_INDISPONIVEL", "A configuração da agenda ainda não está disponível.", 503);
  const escopo = escopos.find((e) => e.estabelecimentoId === estabelecimentoId);
  if (!escopo) recusar("UNIDADE_INVALIDA", "Escolha uma unidade ativa desta empresa.");
  return escopo;
}

/** Festas não canceladas, de hoje em diante, marcadas em cada horário. */
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

/** Colunas de um horário na projeção: horas e datas por to_char (independem de DateStyle). */
const colunasHorario = (h: string) => `${h}.id::text AS id, ${h}.codigo, ${h}.nome,
            to_char(${h}.horario_inicio_padrao, 'HH24:MI:SS.US') AS inicio, to_char(${h}.horario_fim_padrao, 'HH24:MI:SS.US') AS fim,
            ${h}.dias_semana, ${h}.capacidade, ${h}.ordem_exibicao, ${h}.ativo, ${h}.horario_livre,
            to_char(${h}.desativado_a_partir_de, 'YYYY-MM-DD') AS desativado_a_partir_de,
            ${h}.tolerancia_inicio_minutos, ${h}.passo_inicio_minutos`;

type ConfigProjecao = LinhaConfigProjecao & { configurado_por: string | null; configurado_em: string };
type SalaoProjecao = LinhaSalaoProjecao & { membros_info: SalaoCombinado["membros"] | null };
type HorarioEfetivo = LinhaHorarioProjecao & { nivel: number };
type Projecao = ProjecaoVersao & { configLida: ConfigProjecao | null; saloesLidos: SalaoProjecao[] };

/**
 * Plano "Agenda: concorrência otimista do agregado" (rev. 1.1): UMA instrução lê tudo o que o save sobrescreve ou decide
 * (configuração, todos os salões, todas as linhas próprias, herdados efetivos com o nível, vínculos). Em READ COMMITTED
 * uma instrução tem uma única fotografia: o DTO editável e a versão saem do mesmo resultado, no GET e no save.
 * Listas agregadas na ordem de apresentação de hoje (salões por ordem/nome, horários por ordem/código).
 */
async function projecaoAgenda(db: DbExecutor, empresaId: string, estabelecimentoId: string | null, v098: boolean): Promise<Projecao> {
  const r = await db.query<{ config: ConfigProjecao | null; saloes: SalaoProjecao[]; proprios: LinhaHorarioProjecao[]; efetivos: HorarioEfetivo[];
    vinculos: ProjecaoVersao["vinculos"] }>(
    `WITH cfg AS (
       SELECT c.modo, c.capacidade_tipo, c.limite_festas_dia, c.intervalo_minimo_minutos,
              u.nome AS configurado_por, c.configurado_em::text AS configurado_em
         FROM agenda_escopo_config c
         LEFT JOIN usuarios_administrativos u ON u.id = c.configurado_por
        WHERE c.empresa_id = $1::uuid AND coalesce(c.estabelecimento_id, $3::uuid) = coalesce($2::uuid, $3::uuid)
     ), saloes AS (
       SELECT s.id::text AS id, s.nome, s.capacidade_convidados, s.ordem, s.ativo,
              ${v098
    ? `s.combinado, (SELECT array_agg(x::text) FROM unnest(s.membros) x) AS membros,
              CASE WHEN s.combinado THEN coalesce((SELECT json_agg(json_build_object('id', m.id::text, 'nome', m.nome, 'ativo', m.ativo) ORDER BY m.ordem, m.nome)
                                                     FROM agenda_saloes m WHERE m.id = ANY (s.membros)), '[]'::json) END AS membros_info`
    : `NULL::boolean AS combinado, NULL::text[] AS membros, NULL::json AS membros_info`}
         FROM agenda_saloes s
        WHERE s.empresa_id = $1::uuid AND coalesce(s.estabelecimento_id, $3::uuid) = coalesce($2::uuid, $3::uuid)
     ), proprios AS (
       SELECT ${colunasHorario("h")}
         FROM configuracao_agenda h
        WHERE h.empresa_id = $1::uuid AND coalesce(h.estabelecimento_id, $3::uuid) = coalesce($2::uuid, $3::uuid)
     ), candidatas AS (${candidatasAgendaPorNivel("$1", "$2")}
     ), efetivos AS (
       SELECT ${colunasHorario("h")}, k.nivel
         FROM candidatas k JOIN configuracao_agenda h ON h.id = k.id
        WHERE k.nivel = (SELECT max(nivel) FROM candidatas)
     )
     SELECT (SELECT row_to_json(cfg) FROM cfg) AS config,
            coalesce((SELECT json_agg(s ORDER BY s.ordem, s.nome) FROM saloes s), '[]'::json) AS saloes,
            coalesce((SELECT json_agg(p ORDER BY p.ordem_exibicao, p.codigo) FROM proprios p), '[]'::json) AS proprios,
            coalesce((SELECT json_agg(e ORDER BY e.ordem_exibicao, e.codigo) FROM efetivos e), '[]'::json) AS efetivos,
            coalesce((SELECT json_agg(json_build_object('configuracao_agenda_id', v.configuracao_agenda_id::text, 'salao_id', v.salao_id::text))
                        FROM configuracao_agenda_saloes v WHERE v.configuracao_agenda_id::text IN (SELECT id FROM proprios)), '[]'::json) AS vinculos`,
    [empresaId, estabelecimentoId, SEM_UNIDADE],
  );
  const l = r.rows[0]!;
  // Próprios ativos e não livres = PROPRIO (mesma regra de antes em lerAgendaEscopo); senão, o nível dos efetivos.
  const temProprios = l.proprios.some((h) => h.ativo && !h.horario_livre);
  const nivelEfetivo = l.efetivos[0]?.nivel;
  const nivel: NivelHeranca = temProprios ? "PROPRIO" : nivelEfetivo == null ? "NENHUM" : Number(nivelEfetivo) === 1 ? "EMPRESA" : "GLOBAL";
  return {
    empresaId, estabelecimentoId, v098,
    config: l.config, configLida: l.config,
    saloes: l.saloes, saloesLidos: l.saloes,
    proprios: l.proprios,
    nivel,
    herdados: temProprios ? [] : l.efetivos.map(({ nivel: _nivel, ...h }) => { void _nivel; return h; }),
    vinculos: l.vinculos,
  };
}

type Leitura = { agenda: AgendaEscopo; projecao: Projecao };

async function lerAgendaComProjecao(db: DbExecutor, empresaId: string, estabelecimentoId: string | null): Promise<Leitura> {
  const escopo = await escopoValido(db, empresaId, estabelecimentoId);
  const v098 = await combinadosInstalados(db);
  const projecao = await projecaoAgenda(db, empresaId, estabelecimentoId, v098);
  const numero = (v: number | null) => (v == null ? null : Number(v));
  const saloes = projecao.saloesLidos.filter((s) => s.ativo && !(v098 && s.combinado));
  const combinados: SalaoCombinado[] = v098
    ? projecao.saloesLidos.filter((s) => s.ativo && s.combinado).map((c) => {
      const membros = c.membros_info ?? [];
      return { id: c.id, nome: c.nome, capacidadeConvidados: numero(c.capacidade_convidados), membros, elegivel: membros.length >= 2 && membros.every((m) => m.ativo) };
    })
    : [];
  let horarios: HorarioAgenda[];
  if (projecao.nivel === "PROPRIO") {
    const proprios = projecao.proprios.filter((h) => h.ativo && !h.horario_livre);
    const festas = await festasFuturas(db, proprios.map((h) => h.id));
    const ligacoes = new Map<string, string[]>();
    for (const v of projecao.vinculos) ligacoes.set(v.configuracao_agenda_id, [...(ligacoes.get(v.configuracao_agenda_id) ?? []), v.salao_id]);
    horarios = proprios.map((h) => ({
      id: h.id, codigo: h.codigo, nome: h.nome, inicio: hora(h.inicio), fim: hora(h.fim),
      dias: h.dias_semana?.map(Number) ?? TODOS_OS_DIAS, capacidade: Number(h.capacidade),
      desativadoAPartirDe: h.desativado_a_partir_de, saloes: ligacoes.get(h.id) ?? [], herdado: false,
      festasFuturas: festas.get(h.id) ?? { quantidade: 0, proxima: null, ultima: null },
    }));
  } else {
    // Ainda sem horários próprios: os que valem hoje (empresa ou modelos globais), para o assistente pré-preencher.
    const festas = await festasFuturas(db, projecao.herdados.map((h) => h.id));
    horarios = projecao.herdados.map((h) => ({
      id: h.id, codigo: h.codigo, nome: h.nome, inicio: hora(h.inicio), fim: hora(h.fim),
      dias: h.dias_semana?.map(Number) ?? TODOS_OS_DIAS, capacidade: 1, desativadoAPartirDe: h.desativado_a_partir_de ?? null,
      saloes: [], herdado: true, festasFuturas: festas.get(h.id) ?? { quantidade: 0, proxima: null, ultima: null },
    }));
  }
  const c = projecao.configLida;
  const agenda: AgendaEscopo = {
    escopo,
    config: c ? {
      modo: c.modo as Modo, capacidadeTipo: c.capacidade_tipo as CapacidadeTipo, limiteFestasDia: numero(c.limite_festas_dia),
      intervaloMinimoMinutos: Number(c.intervalo_minimo_minutos), configuradoPor: c.configurado_por, configuradoEm: c.configurado_em,
    } : null,
    saloes: saloes.map((s) => ({ id: s.id, nome: s.nome, capacidadeConvidados: numero(s.capacidade_convidados) })),
    combinados,
    combinadosDisponiveis: v098,
    horarios,
    versaoAgenda: versaoAgenda(projecao),
  };
  return { agenda, projecao };
}

export async function lerAgendaEscopo(db: DbExecutor, empresaId: string, estabelecimentoId: string | null): Promise<AgendaEscopo> {
  return (await lerAgendaComProjecao(db, empresaId, estabelecimentoId)).agenda;
}

/** "Hoje" da agenda: data de São Paulo (kidmais098_hoje), o MESMO corte do gatilho do D5 e do invariante da 098. */
export async function hojeDaAgenda(db: DbExecutor) {
  const v098 = await combinadosInstalados(db);
  const r = await db.query<{ d: string }>(v098
    ? `SELECT kidmais098_hoje()::text AS d`
    : `SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS d`);
  return r.rows[0]!.d;
}

/**
 * D5 (decisão de Felipe, 23/10/2026): ocupações de hoje em diante (origem e destino de hold, como kidmais094_ocupacoes)
 * no próprio salão ou num combinado que o contém. Mesmo corte do gatilho da 098 (kidmais098_hoje()).
 */
export async function impedimentosDesativacao(db: DbExecutor, salaoIds: string[]): Promise<ImpedimentoSalao[]> {
  if (salaoIds.length === 0 || !(await combinadosInstalados(db))) return [];
  const r = await db.query<{ fechamento_id: string; data: string; inicio: string; fim: string; salao: string; origem: string }>(
    `SELECT o.fechamento_id::text AS fechamento_id, o.data::text AS data, o.horario_inicio::text AS inicio,
            o.horario_fim::text AS fim, s.nome AS salao, o.origem
       FROM kidmais094_ocupacoes(kidmais098_hoje(), 'infinity'::date) o
       JOIN agenda_saloes s ON s.id = o.salao_id
      WHERE o.salao_id = ANY ($1::uuid[])
         OR o.salao_id IN (SELECT c.id FROM agenda_saloes c WHERE c.combinado AND c.membros && $1::uuid[])
      ORDER BY o.data, o.horario_inicio, s.nome`,
    [salaoIds],
  );
  return r.rows.map((l) => ({
    fechamentoId: l.fechamento_id, data: l.data, inicio: hora(l.inicio), fim: hora(l.fim), salao: l.salao,
    remarcacao: l.origem === "REVISAO_DESTINO",
  }));
}

function mensagemImpedimentos(nome: string, lista: ImpedimentoSalao[]) {
  const datas = lista.slice(0, 5).map((i) => `${i.data.split("-").reverse().join("/")} ${i.inicio}–${i.fim} (${i.salao}${i.remarcacao ? ", remarcação" : ""})`);
  const resto = lista.length > 5 ? ` e mais ${lista.length - 5}` : "";
  return `Não dá para desativar ${nome}: há ${lista.length} festa(s) de hoje em diante usando este salão: ${datas.join("; ")}${resto}. Remarque ou cancele essas festas antes.`;
}

/** Trava TODOS os salões do escopo, por id, antes de qualquer DML do cadastro (mesma ordem da reserva: id crescente). */
async function travarSaloesDoEscopo(tx: DbExecutor, empresaId: string, estabelecimentoId: string | null) {
  await tx.query(
    `SELECT id FROM agenda_saloes WHERE empresa_id = $1::uuid AND estabelecimento_id IS NOT DISTINCT FROM $2::uuid
      ORDER BY id FOR NO KEY UPDATE`,
    [empresaId, estabelecimentoId],
  );
}

export async function escopoJaConfigurado(db: DbExecutor, empresaId: string, estabelecimentoId: string | null) {
  const r = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM agenda_escopo_config
                     WHERE empresa_id = $1::uuid AND coalesce(estabelecimento_id, $3::uuid) = coalesce($2::uuid, $3::uuid)) AS ok`,
    [empresaId, estabelecimentoId, SEM_UNIDADE],
  );
  return r.rows[0]?.ok === true;
}

/**
 * Decisão de Felipe (25/10/2026): só quem já está por salão continua nele até a agenda com mais de um salão ser liberada.
 * Parecer do Astra (25/10/2026, P2): voltar de "por salão" para "um salão" fica bloqueado por ora — as reservas não
 * compartilham a trava da configuração, e duas festas em salões distintos num dia ainda vazio poderiam entrar entre a
 * conferência e a troca. Volta só quando houver um protocolo comum entre a troca e as reservas.
 */
export function exigirTipoDeAgendaLiberado(pedido: CapacidadeTipo, atual: CapacidadeTipo | null, liberada = AGENDA_MAIS_DE_UM_SALAO_LIBERADA) {
  if (pedido === "POR_SALAO" && !liberada && atual !== "POR_SALAO") recusar("DADOS_INVALIDOS", AVISO_MAIS_DE_UM_SALAO_EM_BREVE);
  if (atual === "POR_SALAO" && pedido === "POR_HORARIO") recusar("DADOS_INVALIDOS", AVISO_VOLTA_UM_SALAO);
}

function validarEntrada(input: SalvarAgenda) {
  if (input.limiteFestasDia != null && (!Number.isInteger(input.limiteFestasDia) || input.limiteFestasDia < 1 || input.limiteFestasDia > 50)) {
    recusar("DADOS_INVALIDOS", "Informe um limite de festas por dia entre 1 e 50.");
  }
  if (!Number.isInteger(input.intervaloMinimoMinutos) || input.intervaloMinimoMinutos < 0 || input.intervaloMinimoMinutos > 480) {
    recusar("DADOS_INVALIDOS", "Informe um intervalo entre festas de até 8 horas.");
  }
  const nomesSaloes = input.saloes.map((s) => s.nome.trim().toLocaleLowerCase("pt-BR"));
  if (nomesSaloes.some((n) => !n) || new Set(nomesSaloes).size !== nomesSaloes.length) {
    recusar("DADOS_INVALIDOS", "Dê um nome diferente a cada salão.");
  }
  if (input.capacidadeTipo === "POR_SALAO" && input.saloes.length === 0) {
    recusar("DADOS_INVALIDOS", "Cadastre pelo menos um salão.");
  }
  if (input.modo === "FIXO" && input.horarios.length === 0) recusar("DADOS_INVALIDOS", "Cadastre pelo menos um horário.");
  for (const h of input.horarios) {
    if (!h.nome.trim()) recusar("DADOS_INVALIDOS", "Dê um nome a cada horário.");
    if (!/^\d{2}:\d{2}$/.test(h.inicio) || !/^\d{2}:\d{2}$/.test(h.fim) || minutos(h.fim) <= minutos(h.inicio)) {
      recusar("DADOS_INVALIDOS", `O fim do horário ${h.nome} precisa ser depois do início.`);
    }
    if (h.dias.length === 0 || h.dias.some((d) => !TODOS_OS_DIAS.includes(d))) recusar("DADOS_INVALIDOS", `Escolha os dias do horário ${h.nome}.`);
    if (!Number.isInteger(h.capacidade) || h.capacidade < 1 || h.capacidade > 20) recusar("DADOS_INVALIDOS", "Informe de 1 a 20 festas ao mesmo tempo.");
    if (input.capacidadeTipo === "POR_HORARIO" && h.capacidade !== 1) recusar("DADOS_INVALIDOS", AVISO_UM_SALAO);
    if (input.capacidadeTipo === "POR_SALAO" && h.saloes.length === 0) recusar("DADOS_INVALIDOS", `Escolha os salões do horário ${h.nome}.`);
  }
}

/** Regras ligadas ao horário de origem (preço NOBRE/PADRÃO, disponibilidade e descontos dos pacotes da empresa). */
async function copiarRegras(tx: DbExecutor, empresaId: string, origemId: string | null, destinoId: string, dias: number[], corte: string) {
  if (origemId) {
    await tx.query(
      `INSERT INTO regras_categoria_horario (dia_semana, configuracao_agenda_id, categoria_horario, vigencia_inicio, vigencia_fim, ativo, observacoes)
       SELECT dia_semana, $2::uuid, categoria_horario, GREATEST(vigencia_inicio, $3::date), vigencia_fim, true, 'Copiada pela configuração da agenda (093)'
         FROM regras_categoria_horario
        WHERE configuracao_agenda_id = $1::uuid AND ativo AND (vigencia_fim IS NULL OR vigencia_fim >= $3::date)`,
      [origemId, destinoId, corte],
    );
    await tx.query(
      `INSERT INTO regras_disponibilidade_pacote (pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio, vigencia_fim, ativo, observacoes)
       SELECT r.pacote_id, r.dia_semana, $2::uuid, r.estado, GREATEST(r.vigencia_inicio, $4::date), r.vigencia_fim, true, r.observacoes
         FROM regras_disponibilidade_pacote r JOIN pacotes p ON p.id = r.pacote_id AND p.empresa_id = $3::uuid
        WHERE r.configuracao_agenda_id = $1::uuid AND r.ativo AND (r.vigencia_fim IS NULL OR r.vigencia_fim >= $4::date)`,
      [origemId, destinoId, empresaId, corte],
    );
    await tx.query(
      `INSERT INTO regras_desconto_pacote (pacote_id, dia_semana, configuracao_agenda_id, percentual, base_calculo, codigo, titulo, prioridade, vigencia_inicio, vigencia_fim, ativo, observacoes)
       SELECT r.pacote_id, r.dia_semana, $2::uuid, r.percentual, r.base_calculo, r.codigo, r.titulo, r.prioridade,
              GREATEST(r.vigencia_inicio, $4::date), r.vigencia_fim, true, r.observacoes
         FROM regras_desconto_pacote r JOIN pacotes p ON p.id = r.pacote_id AND p.empresa_id = $3::uuid
        WHERE r.configuracao_agenda_id = $1::uuid AND r.ativo AND (r.vigencia_fim IS NULL OR r.vigencia_fim >= $4::date)`,
      [origemId, destinoId, empresaId, corte],
    );
  }
  // Todo horário precisa de categoria de preço em cada dia em que existe; sem origem, promocional (PADRAO).
  await tx.query(
    `INSERT INTO regras_categoria_horario (dia_semana, configuracao_agenda_id, categoria_horario, vigencia_inicio, ativo, observacoes)
     SELECT d, $1::uuid, 'PADRAO', $3::date, true, 'Padrão da configuração da agenda (093)'
       FROM unnest($2::smallint[]) AS d
      WHERE NOT EXISTS (SELECT 1 FROM regras_categoria_horario r WHERE r.configuracao_agenda_id = $1::uuid AND r.dia_semana = d AND r.ativo)`,
    [destinoId, dias, corte],
  );
}

/** Horário técnico do modo livre: preço, disponibilidade e descontos por dia da semana (decisão de Felipe). */
async function garantirHorarioLivre(tx: DbExecutor, empresaId: string, estabelecimentoId: string | null, fixosIds: string[], corte: string) {
  const existente = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM configuracao_agenda
      WHERE horario_livre AND empresa_id = $1::uuid AND coalesce(estabelecimento_id, $3::uuid) = coalesce($2::uuid, $3::uuid)`,
    [empresaId, estabelecimentoId, SEM_UNIDADE],
  );
  if (existente.rows[0]) {
    await tx.query(`UPDATE configuracao_agenda SET ativo = true WHERE id = $1::uuid`, [existente.rows[0].id]);
    return existente.rows[0].id;
  }
  const criado = await tx.query<{ id: string }>(
    `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos,
                                      passo_inicio_minutos, ordem_exibicao, ativo, empresa_id, estabelecimento_id, horario_livre)
     VALUES ('HORARIO_LIVRE', 'Horário livre', '00:00', '23:59', 0, 30, 99, true, $1::uuid, $2::uuid, true)
     RETURNING id::text AS id`,
    [empresaId, estabelecimentoId],
  );
  const id = criado.rows[0]!.id;
  // Parecer do Astra (P2): as regras dos horários fixos viram, por dia (e pacote/código), uma linha do tempo SEM
  // sobreposição e sem perder trechos — cortada em todos os limites, com a precedência resolvida em cada trecho:
  // NOBRE se algum horário era nobre (buracos = PADRAO); o pacote vale onde valia em algum horário; desconto do
  // horário de menor ordem. Início no passado vira hoje; término preservado.
  // Corte único lido no save depois do advisory (plano rev. 1.1, seção 3), não a data do início da transação.
  const hoje = corte;
  const categorias = await tx.query<{ dia: number; categoria: "PADRAO" | "NOBRE"; inicio: string; fim: string | null }>(
    `SELECT dia_semana AS dia, categoria_horario AS categoria, vigencia_inicio::text AS inicio, vigencia_fim::text AS fim
       FROM regras_categoria_horario WHERE configuracao_agenda_id = ANY($1::uuid[]) AND ativo`,
    [fixosIds],
  );
  for (let dia = 1; dia <= 7; dia += 1) {
    const trechos = linhaDoTempo(
      categorias.rows.filter((r) => Number(r.dia) === dia).map((r) => ({ inicio: r.inicio, fim: r.fim, valor: r.categoria })),
      hoje, (ativos) => (ativos.includes("NOBRE") ? "NOBRE" : "PADRAO"), (a, b) => a === b, "PADRAO" as const,
    );
    for (const t of trechos) {
      await tx.query(
        `INSERT INTO regras_categoria_horario (dia_semana, configuracao_agenda_id, categoria_horario, vigencia_inicio, vigencia_fim, ativo, observacoes)
         VALUES ($1, $2::uuid, $3, $4::date, $5::date, true, 'Horário livre por dia da semana (093)')`,
        [dia, id, t.valor, t.inicio, t.fim],
      );
    }
  }
  const disponiveis = await tx.query<{ pacote: string; dia: number; inicio: string; fim: string | null }>(
    `SELECT r.pacote_id::text AS pacote, r.dia_semana AS dia, r.vigencia_inicio::text AS inicio, r.vigencia_fim::text AS fim
       FROM regras_disponibilidade_pacote r JOIN pacotes p ON p.id = r.pacote_id AND p.empresa_id = $2::uuid
      WHERE r.configuracao_agenda_id = ANY($1::uuid[]) AND r.ativo AND r.estado = 'DISPONIVEL'`,
    [fixosIds, empresaId],
  );
  const porPacoteDia = new Map<string, Trecho<true>[]>();
  for (const r of disponiveis.rows) {
    const chave = `${r.pacote}|${r.dia}`;
    porPacoteDia.set(chave, [...(porPacoteDia.get(chave) ?? []), { inicio: r.inicio, fim: r.fim, valor: true }]);
  }
  for (const [chave, regras] of porPacoteDia) {
    const [pacote, dia] = chave.split("|");
    for (const t of linhaDoTempo(regras, hoje, () => true as const, () => true)) {
      await tx.query(
        `INSERT INTO regras_disponibilidade_pacote (pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio, vigencia_fim, ativo, observacoes)
         VALUES ($1::uuid, $2, $3::uuid, 'DISPONIVEL', $4::date, $5::date, true, 'Horário livre por dia da semana (093)')`,
        [pacote, Number(dia), id, t.inicio, t.fim],
      );
    }
  }
  type Desconto = { percentual: string; base: string; titulo: string | null; prioridade: number; ordem: number };
  const descontos = await tx.query<{ pacote: string; dia: number; codigo: string; inicio: string; fim: string | null } & Desconto>(
    `SELECT r.pacote_id::text AS pacote, r.dia_semana AS dia, r.codigo, r.percentual::text AS percentual, r.base_calculo AS base,
            r.titulo, r.prioridade, c.ordem_exibicao AS ordem, r.vigencia_inicio::text AS inicio, r.vigencia_fim::text AS fim
       FROM regras_desconto_pacote r
       JOIN pacotes p ON p.id = r.pacote_id AND p.empresa_id = $2::uuid
       JOIN configuracao_agenda c ON c.id = r.configuracao_agenda_id
      WHERE r.configuracao_agenda_id = ANY($1::uuid[]) AND r.ativo`,
    [fixosIds, empresaId],
  );
  const porDesconto = new Map<string, Trecho<Desconto>[]>();
  for (const r of descontos.rows) {
    const chave = `${r.pacote}|${r.dia}|${r.codigo}`;
    porDesconto.set(chave, [...(porDesconto.get(chave) ?? []), {
      inicio: r.inicio, fim: r.fim,
      valor: { percentual: r.percentual, base: r.base, titulo: r.titulo, prioridade: Number(r.prioridade), ordem: Number(r.ordem) },
    }]);
  }
  for (const [chave, regras] of porDesconto) {
    const [pacote, dia, codigo] = chave.split("|");
    const trechos = linhaDoTempo(regras, hoje, (ativos) => [...ativos].sort((a, b) => a.ordem - b.ordem)[0]!,
      (a, b) => a.percentual === b.percentual && a.base === b.base && a.titulo === b.titulo && a.prioridade === b.prioridade);
    for (const t of trechos) {
      await tx.query(
        `INSERT INTO regras_desconto_pacote (pacote_id, dia_semana, configuracao_agenda_id, percentual, base_calculo, codigo, titulo, prioridade, vigencia_inicio, vigencia_fim, ativo, observacoes)
         VALUES ($1::uuid, $2, $3::uuid, $4::numeric, $5, $6, $7, $8, $9::date, $10::date, true, 'Horário livre por dia da semana (093)')`,
        [pacote, Number(dia), id, t.valor.percentual, t.valor.base, codigo, t.valor.titulo, t.valor.prioridade, t.inicio, t.fim],
      );
    }
  }
  return id;
}

/**
 * Corte das regras copiadas: data no fuso da SESSÃO (o mesmo do CURRENT_DATE de antes; unificar com São Paulo é a O-1
 * do plano), mas no instante da leitura (clock_timestamp), lida pelo save depois do advisory.
 */
export async function lerCorteDaAgenda(tx: DbExecutor) {
  const r = await tx.query<{ d: string }>(`SELECT to_char((clock_timestamp() AT TIME ZONE current_setting('TimeZone'))::date, 'YYYY-MM-DD') AS d`);
  return r.rows[0]!.d;
}

/**
 * Grava a configuração do escopo inteiro (assistente ou tela). Horários com festas futuras não mudam início, fim nem
 * dias (decisão de Felipe: bloquear, avisar e oferecer "desativar a partir de"). Troca de modo/capacidade é
 * permitida: as festas já marcadas ficam como estão — exceto voltar de "por salão" para "um salão", bloqueada por ora.
 * `maisDeUmSalaoLiberada` só existe para as provas da agenda por salão (093/098); a rota usa a constante.
 *
 * Concorrência otimista (plano "Agenda: concorrência otimista do agregado", rev. 1.1): advisory → escopo → salões (098)
 * → leitura atual (projeção única) → AGENDA_JA_CONFIGURADA → versão esperada (409 AGENDA_MUDOU, sem nenhuma escrita)
 * → validações que dependem do estado → corte das regras → DML. Uma aba desatualizada recebe sempre AGENDA_MUDOU.
 * `lerCorte` só existe para as provas do corte (relógio injetado); a rota usa o padrão.
 */
export async function salvarAgendaEscopo(tx: DbExecutor, input: SalvarAgenda, ctx: Contexto, origem: "ASSISTENTE" | "CONFIGURACOES",
  opcoes: { maisDeUmSalaoLiberada?: boolean; lerCorte?: (tx: DbExecutor) => Promise<string> } = {}) {
  validarEntrada(input);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('kidmais:agenda-config:' || $1::text, 0))`, [ctx.empresaId]);
  await escopoValido(tx, ctx.empresaId, input.estabelecimentoId);
  // 098 (P2-3 da revisão 3): logo depois do lock da configuração e antes de qualquer DML, todos os salões do escopo
  // (mantidos, omitidos e membros) numa única consulta, em ordem de id — a mesma ordem da reserva.
  if (await combinadosInstalados(tx)) await travarSaloesDoEscopo(tx, ctx.empresaId, input.estabelecimentoId);
  const { agenda: antes, projecao } = await lerAgendaComProjecao(tx, ctx.empresaId, input.estabelecimentoId);
  if (origem === "ASSISTENTE" && antes.config) recusar("AGENDA_JA_CONFIGURADA", "A agenda desta unidade já foi configurada. Altere em Configurações › Agenda.");
  if (input.versaoEsperada == null || input.versaoEsperada !== antes.versaoAgenda) {
    recusar("AGENDA_MUDOU", "A agenda mudou depois que você abriu esta tela (outra aba ou outra pessoa salvou). Nada foi gravado. Recarregue para ver a versão atual.");
  }
  const nomesCombinados = new Map(antes.combinados.map((c) => [c.nome.trim().toLocaleLowerCase("pt-BR"), c]));
  const repetido = input.saloes.find((s) => nomesCombinados.has(s.nome.trim().toLocaleLowerCase("pt-BR")));
  if (repetido) recusar("DADOS_INVALIDOS", `Já existe um salão combinado chamado ${repetido.nome.trim()}. Dê outro nome ao salão.`);
  exigirTipoDeAgendaLiberado(input.capacidadeTipo, antes.config?.capacidadeTipo ?? null, opcoes.maisDeUmSalaoLiberada ?? AGENDA_MAIS_DE_UM_SALAO_LIBERADA);
  // Corte único das regras copiadas, depois da espera pelo advisory (não a data do início da transação).
  const corte = await (opcoes.lerCorte ?? lerCorteDaAgenda)(tx);

  // Configuração do escopo.
  if (antes.config) {
    await tx.query(
      `UPDATE agenda_escopo_config SET modo = $3, capacidade_tipo = $4, limite_festas_dia = $5, intervalo_minimo_minutos = $6,
              atualizado_por = $7::uuid, atualizado_em = clock_timestamp()
        WHERE empresa_id = $1::uuid AND coalesce(estabelecimento_id, $8::uuid) = coalesce($2::uuid, $8::uuid)`,
      [ctx.empresaId, input.estabelecimentoId, input.modo, input.capacidadeTipo, input.limiteFestasDia, input.intervaloMinimoMinutos, ctx.usuarioId, SEM_UNIDADE],
    );
  } else {
    await tx.query(
      `INSERT INTO agenda_escopo_config (empresa_id, estabelecimento_id, modo, capacidade_tipo, limite_festas_dia, intervalo_minimo_minutos, configurado_por)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)`,
      [ctx.empresaId, input.estabelecimentoId, input.modo, input.capacidadeTipo, input.limiteFestasDia, input.intervaloMinimoMinutos, ctx.usuarioId],
    );
  }

  // Salões: os informados ficam ativos; os que saíram da lista são desativados (as ligações antigas permanecem).
  const idsSalao = new Map<string, string>();
  for (const [ordem, salao] of input.saloes.entries()) {
    const existente = salao.id ? antes.saloes.find((s) => s.id === salao.id) : null;
    if (salao.id && !existente) recusar("DADOS_INVALIDOS", "Salão não encontrado nesta unidade.");
    const r = existente
      ? await tx.query<{ id: string }>(
        `UPDATE agenda_saloes SET nome = $2, capacidade_convidados = $3, ordem = $4 WHERE id = $1::uuid RETURNING id::text AS id`,
        [existente.id, salao.nome.trim(), salao.capacidadeConvidados, ordem + 1],
      )
      : await tx.query<{ id: string }>(
        `INSERT INTO agenda_saloes (empresa_id, estabelecimento_id, nome, capacidade_convidados, ordem)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5) RETURNING id::text AS id`,
        [ctx.empresaId, input.estabelecimentoId, salao.nome.trim(), salao.capacidadeConvidados, ordem + 1],
      );
    idsSalao.set(salao.nome.trim().toLocaleLowerCase("pt-BR"), r.rows[0]!.id);
  }
  const mantidos = [...idsSalao.values()];
  const omitidos = antes.saloes.filter((s) => !mantidos.includes(s.id));
  // D5: salão (ou membro de combinado) com festa de hoje em diante não é desativado; o salvamento inteiro é recusado e
  // a mensagem lista as festas (o gatilho da 098 é a última barreira, com o mesmo corte de "hoje").
  for (const salao of omitidos) {
    const impedimentos = await impedimentosDesativacao(tx, [salao.id]);
    if (impedimentos.length > 0) recusar("SALAO_COM_FESTAS", mensagemImpedimentos(salao.nome, impedimentos));
  }
  for (const salao of omitidos) await tx.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [salao.id]);
  // Combinados ativos podem ser escolhidos nos horários pelo nome (A e B liberados não liberam AB).
  for (const c of antes.combinados) idsSalao.set(c.nome.trim().toLocaleLowerCase("pt-BR"), c.id);

  // Horários fixos.
  const herdados = antes.horarios.every((h) => h.herdado);
  const gravados: string[] = [];
  for (const [ordem, h] of input.horarios.entries()) {
    const atual = h.id ? antes.horarios.find((x) => x.id === h.id && !x.herdado) : null;
    if (h.id && !atual && !herdados) recusar("DADOS_INVALIDOS", "Horário não encontrado nesta unidade.");
    let id: string;
    if (atual) {
      const mudouSlot = atual.inicio !== h.inicio || atual.fim !== h.fim
        || [...atual.dias].sort().join(",") !== [...h.dias].sort().join(",");
      if (mudouSlot && atual.festasFuturas.quantidade > 0) {
        recusar("HORARIO_COM_FESTAS", `Não dá para mudar o horário ${atual.nome}: há ${atual.festasFuturas.quantidade} festa(s) marcada(s) nele. Desative-o a partir de uma data e crie um horário novo.`);
      }
      await tx.query(
        `UPDATE configuracao_agenda SET nome = $2, horario_inicio_padrao = $3::time, horario_fim_padrao = $4::time,
                dias_semana = $5::smallint[], capacidade = $6, ordem_exibicao = $7
          WHERE id = $1::uuid`,
        [atual.id, h.nome.trim(), h.inicio, h.fim, h.dias, h.capacidade, ordem + 1],
      );
      id = atual.id;
    } else {
      // Horário novo do escopo. Vindo do assistente sobre um herdado, mantém o código (TURNO_1/TURNO_2) e copia as
      // regras de preço, disponibilidade e desconto do herdado; os demais recebem um código próprio.
      const origem = h.id && herdados ? antes.horarios.find((x) => x.id === h.id) ?? null : null;
      const usados = new Set([...antes.horarios.filter((x) => !x.herdado).map((x) => x.codigo)]);
      let codigo = origem?.codigo ?? `HORARIO_${ordem + 1}`;
      for (let n = ordem + 2; usados.has(codigo) || (!origem && /^TURNO_/.test(codigo)); n += 1) codigo = `HORARIO_${n}`;
      // Tolerância e passo do herdado vêm da projeção (os mesmos valores da versão conferida), sem nova leitura.
      const herdado = origem ? projecao.herdados.find((x) => x.id === origem.id) : undefined;
      const criado = await tx.query<{ id: string }>(
        `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, tolerancia_inicio_minutos,
                                          passo_inicio_minutos, ordem_exibicao, ativo, empresa_id, estabelecimento_id,
                                          dias_semana, capacidade)
         VALUES ($1, $2, $3::time, $4::time, $5, $6, $7, true, $8::uuid, $9::uuid, $10::smallint[], $11)
         ON CONFLICT DO NOTHING
         RETURNING id::text AS id`,
        [codigo, h.nome.trim(), h.inicio, h.fim, Number(herdado?.tolerancia_inicio_minutos ?? 0), Number(herdado?.passo_inicio_minutos ?? 30), ordem + 1,
          ctx.empresaId, input.estabelecimentoId, h.dias, h.capacidade],
      );
      if (!criado.rows[0]) recusar("DADOS_INVALIDOS", `Já existe um horário com o código ${codigo} nesta unidade.`);
      id = criado.rows[0].id;
      await copiarRegras(tx, ctx.empresaId, origem?.id ?? null, id, h.dias, corte);
    }
    await tx.query(`DELETE FROM configuracao_agenda_saloes WHERE configuracao_agenda_id = $1::uuid`, [id]);
    for (const nome of input.capacidadeTipo === "POR_SALAO" ? h.saloes : []) {
      const salaoId = idsSalao.get(nome.trim().toLocaleLowerCase("pt-BR"));
      if (!salaoId) recusar("DADOS_INVALIDOS", `Salão ${nome} não cadastrado.`);
      await tx.query(`INSERT INTO configuracao_agenda_saloes (configuracao_agenda_id, salao_id) VALUES ($1::uuid, $2::uuid)`, [id, salaoId]);
    }
    gravados.push(id);
  }
  // Horários próprios que saíram da lista: só sem festas futuras (com festas, o caminho é desativar a partir de).
  // No modo livre a tela não manda horários fixos: eles ficam como estão (festas antigas continuam neles) e o cálculo
  // usa só o horário livre (parecer do Astra, P2: trocar o modo não é remover horários).
  if (!herdados && input.modo !== "LIVRE") {
    for (const h of antes.horarios.filter((x) => !gravados.includes(x.id))) {
      if (h.festasFuturas.quantidade > 0) {
        recusar("HORARIO_COM_FESTAS", `Não dá para remover o horário ${h.nome}: há ${h.festasFuturas.quantidade} festa(s) marcada(s) nele. Desative-o a partir de uma data.`);
      }
      await tx.query(`UPDATE configuracao_agenda SET ativo = false WHERE id = $1::uuid`, [h.id]);
    }
  }
  // Modo livre: o horário técnico guarda preço, disponibilidade e descontos por dia; no fixo ele fica inativo.
  if (input.modo === "LIVRE") {
    await garantirHorarioLivre(tx, ctx.empresaId, input.estabelecimentoId, gravados.length ? gravados : antes.horarios.map((h) => h.id), corte);
  } else {
    await tx.query(
      `UPDATE configuracao_agenda SET ativo = false
        WHERE horario_livre AND empresa_id = $1::uuid AND coalesce(estabelecimento_id, $3::uuid) = coalesce($2::uuid, $3::uuid)`,
      [ctx.empresaId, input.estabelecimentoId, SEM_UNIDADE],
    );
  }

  const depois = await lerAgendaEscopo(tx, ctx.empresaId, input.estabelecimentoId);
  await auditarMutacaoComercial(tx, {
    usuarioId: ctx.usuarioId,
    requestId: ctx.requestId,
    motivo: origem === "ASSISTENTE" ? "Assistente da agenda da unidade" : "Configurações da agenda",
    acao: antes.config ? "AGENDA_ATUALIZADA" : "AGENDA_CONFIGURADA",
    entidadeTipo: "AGENDA_ESCOPO",
    entidadeId: depois.horarios[0]?.id ?? ctx.empresaId,
    empresaId: ctx.empresaId,
    antes: { estabelecimentoId: input.estabelecimentoId, versaoAgenda: antes.versaoAgenda, config: antes.config, horarios: antes.horarios.map(({ festasFuturas, ...h }) => ({ ...h, festas: festasFuturas.quantidade })) },
    depois: { estabelecimentoId: input.estabelecimentoId, origem, versaoAgenda: depois.versaoAgenda, config: depois.config, saloes: depois.saloes, horarios: depois.horarios.map((h) => ({ id: h.id, nome: h.nome, inicio: h.inicio, fim: h.fim, dias: h.dias, capacidade: h.capacidade, saloes: h.saloes })) },
  });
  return depois;
}

async function horarioProprio(tx: DbExecutor, empresaId: string, horarioId: string) {
  const r = await tx.query<{ id: string; nome: string; estabelecimento_id: string | null; desativado_a_partir_de: string | null }>(
    `SELECT id::text AS id, nome, estabelecimento_id::text AS estabelecimento_id, desativado_a_partir_de::text AS desativado_a_partir_de
       FROM configuracao_agenda WHERE id = $1::uuid AND empresa_id = $2::uuid AND ativo AND NOT horario_livre
      FOR UPDATE`,
    [horarioId, empresaId],
  );
  return r.rows[0] ?? recusar("NAO_ENCONTRADO", "Horário não encontrado nesta empresa.", 404);
}

/**
 * Desativar a partir de uma data: as festas marcadas até a véspera continuam; a partir da data o horário deixa de ser
 * oferecido. A data não pode ser antes do dia seguinte à última festa marcada nem no passado.
 */
export async function desativarHorarioAPartirDe(tx: DbExecutor, ctx: Contexto, horarioId: string, aPartirDe: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(aPartirDe)) recusar("DADOS_INVALIDOS", "Informe a data.");
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('kidmais:agenda-config:' || $1::text, 0))`, [ctx.empresaId]);
  const h = await horarioProprio(tx, ctx.empresaId, horarioId);
  const festas = (await festasFuturas(tx, [horarioId])).get(horarioId);
  const hoje = (await tx.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)).rows[0]!.d;
  const minima = festas?.ultima
    ? (await tx.query<{ d: string }>(`SELECT ($1::date + 1)::text AS d`, [festas.ultima])).rows[0]!.d
    : hoje;
  if (aPartirDe < minima) {
    recusar("DATA_ANTES_DA_ULTIMA_FESTA", festas?.ultima
      ? `Escolha uma data a partir de ${minima}: a última festa marcada neste horário é em ${festas.ultima}.`
      : "Escolha uma data a partir de hoje.");
  }
  await tx.query(`UPDATE configuracao_agenda SET desativado_a_partir_de = $2::date WHERE id = $1::uuid`, [horarioId, aPartirDe]);
  const pacotesSoNesse = await tx.query<{ nome: string }>(
    `SELECT p.nome FROM pacotes p
      WHERE p.empresa_id = $1::uuid AND p.ativo AND p.arquivado_em IS NULL
        AND EXISTS (SELECT 1 FROM regras_disponibilidade_pacote r WHERE r.pacote_id = p.id AND r.ativo AND r.estado = 'DISPONIVEL'
                     AND r.configuracao_agenda_id = $2::uuid)
        AND NOT EXISTS (SELECT 1 FROM regras_disponibilidade_pacote r JOIN configuracao_agenda c ON c.id = r.configuracao_agenda_id
                         WHERE r.pacote_id = p.id AND r.ativo AND r.estado = 'DISPONIVEL' AND c.id <> $2::uuid AND c.ativo
                           AND (c.desativado_a_partir_de IS NULL OR c.desativado_a_partir_de > $3::date))
      ORDER BY p.nome`,
    [ctx.empresaId, horarioId, aPartirDe],
  );
  await auditarMutacaoComercial(tx, {
    usuarioId: ctx.usuarioId, requestId: ctx.requestId, motivo: "Desativar horário a partir de uma data",
    acao: "AGENDA_HORARIO_DESATIVADO", entidadeTipo: "CONFIGURACAO_AGENDA", entidadeId: horarioId, empresaId: ctx.empresaId,
    antes: { desativadoAPartirDe: h.desativado_a_partir_de }, depois: { desativadoAPartirDe: aPartirDe, festasMantidas: festas?.quantidade ?? 0 },
  });
  return { aPartirDe, festasMantidas: festas?.quantidade ?? 0, pacotesSemHorario: pacotesSoNesse.rows.map((p) => p.nome) };
}

/** Cancela a desativação enquanto a data não chegou. */
export async function cancelarDesativacao(tx: DbExecutor, ctx: Contexto, horarioId: string) {
  // Mesmo protocolo dos demais escritores da agenda: advisory antes da linha (plano rev. 1.1, seção 6).
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('kidmais:agenda-config:' || $1::text, 0))`, [ctx.empresaId]);
  const h = await horarioProprio(tx, ctx.empresaId, horarioId);
  const hoje = (await tx.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)).rows[0]!.d;
  if (!h.desativado_a_partir_de) recusar("SEM_DESATIVACAO", "Este horário não tem desativação marcada.");
  if (h.desativado_a_partir_de <= hoje) recusar("DESATIVACAO_EM_VIGOR", "A desativação já começou e não pode mais ser cancelada.");
  await tx.query(`UPDATE configuracao_agenda SET desativado_a_partir_de = NULL WHERE id = $1::uuid`, [horarioId]);
  await auditarMutacaoComercial(tx, {
    usuarioId: ctx.usuarioId, requestId: ctx.requestId, motivo: "Cancelar desativação do horário",
    acao: "AGENDA_DESATIVACAO_CANCELADA", entidadeTipo: "CONFIGURACAO_AGENDA", entidadeId: horarioId, empresaId: ctx.empresaId,
    antes: { desativadoAPartirDe: h.desativado_a_partir_de }, depois: { desativadoAPartirDe: null },
  });
}

export type NovoCombinado = { estabelecimentoId: string | null; nome: string; capacidadeConvidados: number | null; membros: string[] };

/**
 * 098: cria um salão combinado ("salão inteiro" = A+B). A composição é imutável: para mudar, cria-se outro e desativa-se
 * o antigo. Ordem de locks do cadastro: agenda-config → todos os salões do escopo por id (FOR NO KEY UPDATE) → INSERT
 * (o gatilho da 098 trava os membros FOR SHARE, já cobertos, valida e confere de novo no COMMIT).
 */
export async function criarSalaoCombinado(tx: DbExecutor, ctx: Contexto, input: NovoCombinado) {
  const nome = input.nome.trim();
  if (!nome || nome.length > 80) recusar("DADOS_INVALIDOS", "Dê um nome ao salão combinado.");
  if (input.capacidadeConvidados != null && (!Number.isInteger(input.capacidadeConvidados) || input.capacidadeConvidados < 1)) {
    recusar("DADOS_INVALIDOS", "Informe a capacidade em número de convidados.");
  }
  const membros = membrosCanonicos(input.membros);
  if (membros.length < 2) recusar("DADOS_INVALIDOS", "Escolha pelo menos dois salões diferentes para combinar.");
  if (!(await combinadosInstalados(tx))) recusar("SALOES_COMBINADOS_INDISPONIVEIS", "Salões combinados ainda não estão disponíveis.", 503);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('kidmais:agenda-config:' || $1::text, 0))`, [ctx.empresaId]);
  await escopoValido(tx, ctx.empresaId, input.estabelecimentoId);
  await travarSaloesDoEscopo(tx, ctx.empresaId, input.estabelecimentoId);
  const validos = await tx.query<{ id: string; nome: string }>(
    `SELECT id::text AS id, nome FROM agenda_saloes
      WHERE id = ANY ($1::uuid[]) AND empresa_id = $2::uuid AND estabelecimento_id IS NOT DISTINCT FROM $3::uuid
        AND ativo AND NOT combinado ORDER BY ordem, nome`,
    [membros, ctx.empresaId, input.estabelecimentoId],
  );
  if (validos.rows.length !== membros.length) recusar("DADOS_INVALIDOS", "Escolha salões simples e ativos desta unidade.");
  const mesmoNome = await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM agenda_saloes WHERE ativo AND empresa_id = $1::uuid AND estabelecimento_id IS NOT DISTINCT FROM $2::uuid
                     AND lower(btrim(nome)) = lower(btrim($3))) AS ok`,
    [ctx.empresaId, input.estabelecimentoId, nome],
  );
  if (mesmoNome.rows[0]?.ok) recusar("DADOS_INVALIDOS", `Já existe um salão chamado ${nome} nesta unidade.`);
  const ordem = await tx.query<{ n: number }>(
    `SELECT coalesce(max(ordem), 0)::int + 1 AS n FROM agenda_saloes WHERE empresa_id = $1::uuid AND estabelecimento_id IS NOT DISTINCT FROM $2::uuid`,
    [ctx.empresaId, input.estabelecimentoId],
  );
  const criado = await tx.query<{ id: string }>(
    `INSERT INTO agenda_saloes (empresa_id, estabelecimento_id, nome, capacidade_convidados, ordem, combinado, membros)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, $6::uuid[]) RETURNING id::text AS id`,
    [ctx.empresaId, input.estabelecimentoId, nome, input.capacidadeConvidados, Math.min(Number(ordem.rows[0]?.n ?? 1), 32767), membros],
  );
  const id = criado.rows[0]!.id;
  await auditarMutacaoComercial(tx, {
    usuarioId: ctx.usuarioId, requestId: ctx.requestId, motivo: "Criar salão combinado",
    acao: "AGENDA_SALAO_COMBINADO_CRIADO", entidadeTipo: "AGENDA_SALAO", entidadeId: id, empresaId: ctx.empresaId,
    antes: null, depois: { estabelecimentoId: input.estabelecimentoId, nome, capacidadeConvidados: input.capacidadeConvidados, membros: validos.rows },
  });
  return { id, nome, membros: validos.rows };
}

/**
 * 098 / D5: desativa um salão (simples ou combinado). Recusa, listando as festas, se ele ou um combinado que o contém
 * tiver ocupação de hoje em diante (kidmais098_hoje). Mesmos locks do cadastro.
 */
export async function desativarSalao(tx: DbExecutor, ctx: Contexto, salaoId: string) {
  if (!(await combinadosInstalados(tx))) recusar("SALOES_COMBINADOS_INDISPONIVEIS", "Esta ação ainda não está disponível.", 503);
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('kidmais:agenda-config:' || $1::text, 0))`, [ctx.empresaId]);
  const salao = (await tx.query<{ id: string; nome: string; estabelecimento_id: string | null; ativo: boolean; combinado: boolean }>(
    `SELECT id::text AS id, nome, estabelecimento_id::text AS estabelecimento_id, ativo, combinado FROM agenda_saloes
      WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [salaoId, ctx.empresaId],
  )).rows[0] ?? recusar("NAO_ENCONTRADO", "Salão não encontrado nesta empresa.", 404);
  await travarSaloesDoEscopo(tx, ctx.empresaId, salao.estabelecimento_id);
  if (!salao.ativo) return { desativado: true, id: salao.id };
  const impedimentos = await impedimentosDesativacao(tx, [salao.id]);
  if (impedimentos.length > 0) {
    throw Object.assign(new AgendaConfiguracaoError("SALAO_COM_FESTAS", mensagemImpedimentos(salao.nome, impedimentos), 409), { impedimentos });
  }
  await tx.query(`UPDATE agenda_saloes SET ativo = false WHERE id = $1::uuid`, [salao.id]);
  await auditarMutacaoComercial(tx, {
    usuarioId: ctx.usuarioId, requestId: ctx.requestId, motivo: salao.combinado ? "Desativar salão combinado" : "Desativar salão",
    acao: "AGENDA_SALAO_DESATIVADO", entidadeTipo: "AGENDA_SALAO", entidadeId: salao.id, empresaId: ctx.empresaId,
    antes: { ativo: true }, depois: { ativo: false },
  });
  return { desativado: true, id: salao.id };
}

/** Salões permitidos do pacote (vazio = todos). */
export async function definirSaloesPacote(tx: DbExecutor, empresaId: string, pacoteId: string, saloes: string[] | undefined) {
  const instalada = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.pacote_saloes') IS NOT NULL AS ok`);
  if (!instalada.rows[0]?.ok) return;
  if (saloes === undefined) {
    // Parecer do Astra (25/10/2026, P2): campo omitido preserva os salões, mas na agenda por salão o vínculo EFETIVO
    // precisa existir — duplicar ou alterar um pacote antigo sem salão não pode gerar pacote "em todos os salões".
    if (await pacoteSemSalaoNaAgendaPorSalao(tx, empresaId, pacoteId)) recusar("DADOS_INVALIDOS", AVISO_SALAO_DO_PACOTE_ORIGEM);
    return;
  }
  if (saloes.length > 0) {
    const validos = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agenda_saloes WHERE id = ANY($1::uuid[]) AND empresa_id = $2::uuid AND ativo`,
      [saloes, empresaId],
    );
    if (Number(validos.rows[0]?.n) !== new Set(saloes).size) recusar("DADOS_INVALIDOS", "Escolha salões desta empresa.");
  } else {
    // Pedido de Felipe (25/10/2026): na agenda por salão, o pacote diz em qual salão (ou quais) acontece — sem "todos".
    // Parecer do Astra (P2): só conta salão de unidade configurada por salão; com um salão, salão cadastrado não obriga.
    const ativos = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM agenda_saloes s WHERE s.empresa_id = $1::uuid AND s.ativo AND ${SALAO_DE_AGENDA_POR_SALAO}`, [empresaId]);
    if (Number(ativos.rows[0]?.n) > 0) recusar("DADOS_INVALIDOS", AVISO_SALAO_DO_PACOTE);
  }
  await tx.query(`DELETE FROM pacote_saloes WHERE pacote_id = $1::uuid`, [pacoteId]);
  for (const salao of new Set(saloes)) {
    await tx.query(`INSERT INTO pacote_saloes (pacote_id, salao_id) VALUES ($1::uuid, $2::uuid)`, [pacoteId, salao]);
  }
}

export async function saloesDaEmpresa(db: DbExecutor, empresaId: string) {
  const instalada = await db.query<{ ok: boolean }>(`SELECT to_regclass('public.agenda_saloes') IS NOT NULL AS ok`);
  if (!instalada.rows[0]?.ok) return [];
  // 098: combinados aparecem com a composição (permissão por identidade: A e B liberados não liberam AB).
  const v098 = await combinadosInstalados(db);
  const r = await db.query<{ id: string; nome: string; unidade: string | null; combinado?: boolean; membros?: string[] }>(
    `SELECT s.id::text AS id, s.nome, e.nome AS unidade${v098 ? `, s.combinado,
            ARRAY(SELECT m.nome FROM agenda_saloes m WHERE m.id = ANY (s.membros) ORDER BY m.ordem, m.nome) AS membros` : ""}
       FROM agenda_saloes s LEFT JOIN estabelecimentos e ON e.id = s.estabelecimento_id
      WHERE s.empresa_id = $1::uuid AND s.ativo AND ${SALAO_DE_AGENDA_POR_SALAO} ORDER BY e.nome NULLS FIRST, s.ordem, s.nome`,
    [empresaId],
  );
  return r.rows.map(({ combinado, membros, ...s }) => (combinado ? { ...s, combinado: true, membros: membros ?? [] } : s));
}

export async function saloesDoPacote(db: DbExecutor, pacoteId: string) {
  const instalada = await db.query<{ ok: boolean }>(`SELECT to_regclass('public.pacote_saloes') IS NOT NULL AS ok`);
  if (!instalada.rows[0]?.ok) return [];
  const r = await db.query<{ salao_id: string }>(`SELECT salao_id::text AS salao_id FROM pacote_saloes WHERE pacote_id = $1::uuid`, [pacoteId]);
  return r.rows.map((l) => l.salao_id);
}
