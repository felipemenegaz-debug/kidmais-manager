import type { DbExecutor } from "../../db/contracts.ts";
import { db } from "../../db/postgres.ts";
import { escopoDoFechamento, type EscopoAgenda } from "../escopo.ts";
import {
  listarBloqueiosAtivosPorPeriodo,
  listarConfiguracoesAgendaAtivas,
  listarFechamentosConfirmadosPorPeriodo,
} from "../repositories/disponibilidade.repository.ts";
import type { BloqueioAgendaRecord, ConfiguracaoAgendaRecord, OcupacaoConfirmadaRecord, RegraCapacidadeAgenda } from "../repositories/models.ts";
import { lerRegraCapacidadeAgenda } from "../repositories/disponibilidade.repository.ts";
import { AvailabilityServiceError } from "./errors.ts";
import { saloesCruzam } from "../../agenda/saloes-conjuntos.ts";
import {
  adicionarDiasIso,
  bloqueioConflitaComCandidato,
  dataIsoValida,
  diferencaDiasIso,
  DURACAO_MAXIMA_MINUTOS,
  DURACAO_MINIMA_MINUTOS,
  duracaoAceita,
  duracaoDoIntervalo,
  gerarHorariosCandidatos,
  horaParaMinutos,
  ocupacaoConflitaComCandidato,
} from "./horario.utils.ts";
import type {
  CapacidadeConvidadosPublica,
  DisponibilidadeDataPublica,
  MotivoCapacidade,
  PeriodoDisponibilidadePublica,
} from "./models.ts";

const MAX_DIAS_CONSULTA = 62;

/** Escopo explícito, ou o da contratação indicada (lido do banco, nunca do pedido). */
export type EscopoConsulta = EscopoAgenda | { fechamentoId: string };

async function resolverEscopo(customDb: DbExecutor | undefined, informado?: EscopoConsulta, excluirFechamentoId?: string) {
  const fechamentoId = informado && "fechamentoId" in informado ? informado.fechamentoId : informado ? null : excluirFechamentoId;
  if (fechamentoId) return escopoDoFechamento(customDb ?? db(), fechamentoId);
  return informado && !("fechamentoId" in informado) ? informado : undefined;
}

/**
 * Escopo (062): o recurso consultado (ou a contratação de onde lê-lo). Sem escopo e com contratação a excluir
 * (remarcação/edição), vale o escopo gravado nessa contratação; sem nenhum dos dois, o alcance global (conservador).
 */
export async function consultarDisponibilidadeData(
  data: string,
  customDb?: DbExecutor,
  excluirFechamentoId?: string,
  escopo?: EscopoConsulta,
  opcoes?: OpcoesDisponibilidade,
): Promise<DisponibilidadeDataPublica> {
  const [resultado] = await consultarDisponibilidadePeriodo(data, data, customDb, excluirFechamentoId, escopo, opcoes);
  return resultado;
}

/** 2c-2: duração da festa para o modo livre (o fim de cada início); sem ela, 4 horas. */
export type OpcoesDisponibilidade = {
  duracaoMinutos?: number | null;
  /** Parecer do Astra (P1): salões permitidos pelo pacote; o candidato precisa de um salão livre na interseção. */
  saloesDoPacote?: string[] | null;
  /** S-C: convidados pagantes informados pelo cliente; com capacidade por salão, só conta salão que comporta. */
  convidados?: number | null;
  /**
   * Retomada 098 (rev. 2.1): o painel inclui salões combinados como candidatos; o cliente só com combinadosPublicos
   * (E2b: SALOES_PUBLICOS + SALOES_COMBINADOS_PUBLICOS + instalação NOVA). Padrão: sem combinados.
   */
  incluirCombinados?: boolean;
};
export const DURACAO_PADRAO_MINUTOS = 240;

/** Todo caminho que confere um intervalo exato usa a duração dele (definida em horario.utils, também usada na tela). */
export { duracaoAceita, duracaoDoIntervalo };

/**
 * Modo livre (decisão de Felipe: sem janela de funcionamento): qualquer início no passo do horário técnico, com o fim
 * pela duração, dentro do mesmo dia. ajusteMinutos = minutos desde 00:00 (identifica o início na revalidação).
 */
export function gerarCandidatosLivres(passoMinutos: number, duracaoMinutos: number) {
  const passo = Math.max(5, passoMinutos || 30);
  const candidatos: Array<{ inicio: string; fim: string; inicioMinutos: number; fimMinutos: number; ajusteMinutos: number }> = [];
  for (let inicio = 0; inicio + duracaoMinutos < 24 * 60; inicio += passo) {
    const fim = inicio + duracaoMinutos;
    const hora = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    candidatos.push({ inicio: hora(inicio), fim: hora(fim), inicioMinutos: inicio, fimMinutos: fim, ajusteMinutos: inicio });
  }
  return candidatos;
}


/**
 * Intervalo EXATO sem conflito na data, sem exigir que seja um dos horários candidatos do turno: reservas confirmadas e
 * bloqueios ativos do escopo da própria contratação (062), excluída ela mesma. Uso restrito à manutenção de uma reserva
 * que já existe no mesmo destino (horário histórico preservado na revisão). Mudança de destino continua exigindo os
 * candidatos oficiais de `consultarDisponibilidadeData`.
 */
export async function intervaloSemConflito(
  data: string,
  inicio: string,
  fim: string,
  customDb: DbExecutor,
  fechamentoId: string,
  configuracaoId?: string | null,
): Promise<boolean> {
  validarPeriodo(data, data);
  const escopo = await resolverEscopo(customDb, undefined, fechamentoId);
  const bloqueios = await listarBloqueiosAtivosPorPeriodo(data, data, customDb, escopo);
  const ocupacoes = await listarFechamentosConfirmadosPorPeriodo(data, data, customDb, escopo);
  const intervalo = { inicioMinutos: horaParaMinutos(inicio), fimMinutos: horaParaMinutos(fim) };
  if (!(intervalo.fimMinutos > intervalo.inicioMinutos)) return false;
  if (bloqueios.some((b) => b.data === data && bloqueioConflitaComCandidato(b, intervalo))) return false;
  // Navegador de 22/10 (P2-N1): com a 094, a ocupação segue a MESMA regra do banco (capacidade por horário, limite do
  // dia, salão e intervalo) no horário configurado da festa; sem a 094, a regra exclusiva de antes.
  const regra = configuracaoId ? await conflitoPela094(customDb, fechamentoId, data, inicio, fim, configuracaoId) : null;
  if (regra !== null) return !regra;
  return !ocupacoes.some((o) => o.fechamentoId !== fechamentoId && o.data === data && ocupacaoConflitaComCandidato(o, intervalo));
}

/**
 * Conflito pela função da 094 (kidmais094_conflito_ocupacao) para o intervalo da festa; null sem a 094. Com capacidade
 * por salão e a festa ainda sem salão, a ocupação é decidida pela escolha do salão (escolherSalaoDestinoRevisao): aqui
 * não há conflito a declarar.
 */
async function conflitoPela094(db: DbExecutor, fechamentoId: string, data: string, inicio: string, fim: string, configuracaoId: string): Promise<boolean | null> {
  const instalada = await db.query<{ ok: boolean }>(
    `SELECT to_regprocedure('public.kidmais094_conflito_ocupacao(uuid,date,time without time zone,time without time zone,uuid,uuid,uuid,uuid)') IS NOT NULL AS ok`,
  );
  if (instalada.rows[0]?.ok !== true) return null;
  const r = await db.query<{ conflito: boolean | null }>(
    `SELECT CASE WHEN f.salao_id IS NULL AND EXISTS (SELECT 1 FROM agenda_escopo_config c WHERE c.empresa_id = f.empresa_id
                       AND c.estabelecimento_id IS NOT DISTINCT FROM f.estabelecimento_id AND c.capacidade_tipo = 'POR_SALAO')
                 THEN false
                 ELSE kidmais094_conflito_ocupacao(f.id, $2::date, $3::time, $4::time, f.empresa_id, f.estabelecimento_id, $5::uuid, f.salao_id)
            END AS conflito
       FROM fechamentos f WHERE f.id = $1::uuid`,
    [fechamentoId, data, inicio, fim, configuracaoId],
  );
  return r.rows[0]?.conflito === true;
}

export type RevalidarHorarioSelecionadoInput = {
  data: string;
  /** Horário configurado (configuracao_agenda.id); quando presente, tem precedência sobre o código. */
  configuracaoId?: string;
  /** Legado: código do período (TURNO_1/TURNO_2), usado só quando não vier configuracaoId. */
  codigoPeriodo?: string;
  inicio: string;
  fim: string;
  ajusteMinutos: number;
  /** Parecer do Astra (P1): código do pacote no banco; com capacidade por salão, exige salão livre que ele permita. */
  pacoteCodigo?: string;
  /** S-C: convidados da cotação/pedido; com capacidade por salão, exige salão livre que comporte. */
  convidados?: number | null;
  /** Retomada 098 (rev. 2.1): o painel inclui salões combinados; a cotação e o pedido do cliente só com combinadosPublicos (E2b). */
  incluirCombinados?: boolean;
};

/**
 * Duração (minutos) do pacote vigente da empresa; null sem empresa, pacote ou duração cadastrada. Horário livre: os
 * candidatos da criação (wizard administrativo, preparação da IA, revalidação) seguem a duração do pacote.
 * Parecer do Astra (P2-2): duração cadastrada fora do limite único não vira ausência (nem 4 h) — recusa explícita.
 */
export async function duracaoDoPacoteDaEmpresa(db: DbExecutor | undefined, empresaId: string | null | undefined, codigo: string | undefined) {
  if (!empresaId || !codigo) return null;
  const ex = db ?? (await import("../../db/postgres.ts")).db();
  const r = await ex.query<{ duracao_minutos: number | null }>(
    `SELECT p.duracao_minutos FROM pacotes p WHERE p.empresa_id = $1::uuid AND p.codigo = $2 AND p.vigente ORDER BY p.duracao_minutos NULLS LAST LIMIT 1`,
    [empresaId, codigo],
  );
  const cadastrada = r.rows[0]?.duracao_minutos;
  if (cadastrada == null) return null;
  const aceita = duracaoAceita(Number(cadastrada));
  if (aceita === null) {
    throw new AvailabilityServiceError(
      "PACOTE_DURACAO_INVALIDA",
      `A duração cadastrada deste pacote (${cadastrada} min) está fora do limite aceito (5 min a 23h59). Corrija o pacote em Configurações › Pacotes.`,
      409,
    );
  }
  return aceita;
}

/**
 * Parecer do Astra (P2-1): sem pacote escolhido (entrada pública, agenda do painel), o horário livre usa a duração do
 * pacote ativo mais curto da empresa — nenhuma janela de um pacote real some por causa de 4 h universais. Durações
 * fora do limite ficam de fora (o pacote recusa ao ser escolhido). null = nenhum pacote com duração.
 */
async function menorDuracaoDosPacotes(db: DbExecutor | undefined, empresaId: string | null | undefined) {
  if (!empresaId) return null;
  const ex = db ?? (await import("../../db/postgres.ts")).db();
  const r = await ex.query<{ menor: number | null }>(
    `SELECT min(p.duracao_minutos) AS menor FROM pacotes p
      WHERE p.empresa_id = $1::uuid AND p.vigente AND p.ativo AND p.duracao_minutos BETWEEN $2 AND $3`,
    [empresaId, DURACAO_MINIMA_MINUTOS, DURACAO_MAXIMA_MINUTOS],
  );
  return duracaoAceita(r.rows[0]?.menor == null ? null : Number(r.rows[0].menor));
}

/**
 * Salões permitidos pelo pacote vigente da empresa (vazio = todos; null sem a 093).
 * Revisão da integração d6ddbc6 (P2-I1): a existência da 093 é conferida em consulta SEPARADA. Na mesma consulta, o
 * PostgreSQL resolve `pacote_saloes` antes de avaliar o WHERE: sem a tabela dava 42P01, e o catch seguia com a transação
 * abortada (25P02 na consulta seguinte). Sem catch: um erro real propaga em vez de virar "sem restrição de salão".
 */
export async function saloesDoPacoteDaEmpresa(db: DbExecutor | undefined, empresaId: string | null | undefined, codigo: string | undefined) {
  if (!empresaId || !codigo) return null;
  const ex = db ?? (await import("../../db/postgres.ts")).db();
  const instalada = await ex.query<{ ok: boolean }>(`SELECT to_regclass('public.pacote_saloes') IS NOT NULL AS ok`);
  if (instalada.rows[0]?.ok !== true) return null;
  const r = await ex.query<{ salao_id: string | null }>(
    `SELECT ps.salao_id::text AS salao_id
       FROM pacotes p LEFT JOIN pacote_saloes ps ON ps.pacote_id = p.id
      WHERE p.empresa_id = $1::uuid AND p.codigo = $2 AND p.vigente`,
    [empresaId, codigo],
  );
  const ids = r.rows.map((l) => l.salao_id).filter((x): x is string => Boolean(x));
  return ids.length ? ids : null;
}

export async function revalidarHorarioSelecionado(
  input: RevalidarHorarioSelecionadoInput,
  customDb?: DbExecutor,
  escopo?: EscopoConsulta,
) {
  // Modo livre: os candidatos dependem da duração. Parecer do Astra (P2): na criação vale a do pacote vigente da
  // empresa (um intervalo de outra duração não é candidato); pacote sem duração = a do próprio intervalo escolhido.
  const empresaDoEscopo = escopo && "empresaId" in escopo ? escopo.empresaId : null;
  const duracaoMinutos = (await duracaoDoPacoteDaEmpresa(customDb, empresaDoEscopo, input.pacoteCodigo))
    ?? duracaoDoIntervalo(input.inicio, input.fim);
  const disponibilidade = await consultarDisponibilidadeData(input.data, customDb, undefined, escopo, {
    duracaoMinutos,
    saloesDoPacote: await saloesDoPacoteDaEmpresa(customDb, empresaDoEscopo, input.pacoteCodigo),
    convidados: input.convidados ?? null,
    incluirCombinados: input.incluirCombinados === true,
  });
  const periodo = disponibilidade.periodos.find(
    (item) =>
      item.configuracaoId === input.configuracaoId ||
      (!input.configuracaoId && item.codigo === input.codigoPeriodo),
  );

  if (!periodo) {
    throw new AvailabilityServiceError(
      "TURNO_NAO_CONFIGURADO",
      "O período selecionado não possui configuração ativa.",
      409,
    );
  }

  const candidato = periodo.horarios.find(
    (item) =>
      item.inicio === input.inicio &&
      item.fim === input.fim &&
      item.ajusteMinutos === input.ajusteMinutos,
  );

  // S-C: o horário existe e só falta salão que comporte: mensagem própria (sem gravar nada; o chamador ainda não gravou).
  if (candidato && candidato.status !== "DISPONIVEL" && candidato.capacidade?.motivo === "CAPACIDADE") {
    throw new AvailabilityServiceError(
      "SEM_SALAO_PARA_CONVIDADOS",
      "Nenhum salão livre neste horário comporta " + input.convidados + " convidados. Escolha outra data ou fale com o buffet.",
      409,
    );
  }

  if (!candidato || candidato.status !== "DISPONIVEL") {
    throw new AvailabilityServiceError(
      "HORARIO_NAO_DISPONIVEL",
      "Este horário não está mais disponível. Escolha uma nova data ou horário para continuar.",
      409,
    );
  }

  return { periodo, candidato };
}

/** 093: o horário existe neste dia da semana e ainda não foi desativado nesta data. */
export function horarioValeNaData(config: Pick<ConfiguracaoAgendaRecord, "diasSemana" | "desativadoAPartirDe">, data: string) {
  if (config.desativadoAPartirDe && data >= config.desativadoAPartirDe) return false;
  if (!config.diasSemana || config.diasSemana.length === 0) return true;
  const diaJs = new Date(`${data}T12:00:00Z`).getUTCDay();
  return config.diasSemana.includes(diaJs === 0 ? 7 : diaJs);
}

const minutosDe = (hora: string) => {
  const [h, m] = hora.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * 094: mesma regra de kidmais094_conflito_ocupacao para um candidato do horário `configId`: limite do dia; por salão,
 * algum salão do horário livre (com o intervalo); por horário, sem sobreposição com outro horário e abaixo da
 * capacidade no mesmo horário (com o intervalo). Sem regra: qualquer sobreposição ocupa (como antes).
 * 098: por salão, a ocupação impede o candidato quando os CONJUNTOS de salões se cruzam (kidmais098_saloes_cruzam):
 * A ocupado não impede B, mas impede o combinado AB; AB ocupado impede A, B e BC. Origem e destino de um hold são
 * ocupações separadas (não se consolida por festa). Sem salão candidato elegível, o horário é indisponível.
 */
export function ocupacaoImpedeCandidato(
  regra: RegraCapacidadeAgenda | null,
  configId: string,
  candidato: { inicioMinutos: number; fimMinutos: number },
  ocupacoes: OcupacaoConfirmadaRecord[],
  saloesDoPacote?: string[] | null,
  convidados?: number | null,
) {
  const sobrepoe = (o: OcupacaoConfirmadaRecord, folga: number) => ocupacaoSobrepoe(o, candidato, folga);
  if (!regra) return ocupacoes.some((o) => sobrepoe(o, 0));
  if (limiteDoDiaAtingido(regra, ocupacoes)) return true;
  const folga = regra.intervaloMinimoMinutos;
  if (regra.capacidadeTipo === "POR_SALAO") {
    const saloes = saloesCandidatos(regra, configId, saloesDoPacote);
    if (saloesDoPacote?.length && saloes.length === 0) return true;
    if (saloes.length === 0) return regra.conjuntos ? true : ocupacoes.some((o) => sobrepoe(o, folga));
    // S-C: com convidados, só salão que comporta é candidato; nenhum que comporte = impedido (motivo CAPACIDADE).
    const comportam = convidados ? saloes.filter((salao) => salaoComporta(regra, salao, convidados)) : saloes;
    return !comportam.some((salao) => salaoLivre(regra, salao, candidato, ocupacoes));
  }
  if (ocupacoes.some((o) => (o.configuracaoAgendaId ?? null) !== configId && sobrepoe(o, 0))) return true;
  const capacidade = regra.capacidadePorHorario[configId] ?? 1;
  // Fechamentos distintos: a remarcação em hold ocupa a origem e o destino, mas é UMA festa (parecer do Astra, P2).
  return new Set(ocupacoes.filter((o) => o.configuracaoAgendaId === configId && sobrepoe(o, folga)).map((o) => o.fechamentoId)).size >= capacidade;
}

const ocupacaoSobrepoe = (o: OcupacaoConfirmadaRecord, candidato: { inicioMinutos: number; fimMinutos: number }, folga: number) =>
  minutosDe(o.horarioInicio) < candidato.fimMinutos + folga && minutosDe(o.horarioFim) > candidato.inicioMinutos - folga;

const limiteDoDiaAtingido = (regra: RegraCapacidadeAgenda, ocupacoes: OcupacaoConfirmadaRecord[]) =>
  regra.limiteFestasDia != null && new Set(ocupacoes.map((o) => o.fechamentoId)).size >= regra.limiteFestasDia;

/** Salões candidatos do horário (098: só os elegíveis) na interseção com os do pacote. */
function saloesCandidatos(regra: RegraCapacidadeAgenda, configId: string, saloesDoPacote?: string[] | null) {
  const listados = regra.saloesPorHorario[configId]?.length ? regra.saloesPorHorario[configId]! : regra.saloesDoEscopo;
  // 098: como em salao-festa.ts, só salões elegíveis são candidatos (permissão por identidade: A e B não liberam AB).
  const doHorario = regra.conjuntos ? listados.filter((s) => regra.saloesDoEscopo.includes(s)) : listados;
  // Horário × pacote: sem salão em comum, a festa não tem onde acontecer (parecer do Astra, P1).
  return saloesDoPacote?.length ? doHorario.filter((s) => saloesDoPacote.includes(s)) : doHorario;
}

function salaoLivre(regra: RegraCapacidadeAgenda, salao: string, candidato: { inicioMinutos: number; fimMinutos: number }, ocupacoes: OcupacaoConfirmadaRecord[]) {
  return !ocupacoes.some((o) => saloesCruzam(o.salaoId, salao, regra.conjuntos) && ocupacaoSobrepoe(o, candidato, regra.intervaloMinimoMinutos));
}

/**
 * S-C: "salão comporta N" = capacidade não informada (NULL comporta) ou maior/igual a N. Combinado usa a própria.
 * S-D (R3-E5): nos dois sentidos — com a 102, também N ≥ mínimo do salão (mínimo NULL = aberto).
 */
export function salaoComporta(regra: Pick<RegraCapacidadeAgenda, "capacidadePorSalao" | "minimoPorSalao">, salao: string, convidados: number) {
  return motivoEstrutural(regra, salao, convidados) === null;
}

/** S-D: o que impede o salão para N sem depender da data — abaixo do mínimo ou acima da capacidade; null = comporta. */
export function motivoEstrutural(regra: Pick<RegraCapacidadeAgenda, "capacidadePorSalao" | "minimoPorSalao">, salao: string, convidados: number) {
  const capacidade = regra.capacidadePorSalao?.[salao];
  const minimo = regra.minimoPorSalao?.[salao];
  if (minimo != null && convidados < minimo) return "abaixo_do_minimo" as const;
  if (capacidade != null && convidados > capacidade) return "nao_comporta" as const;
  return null;
}

/** S-D (R-D4/R3-D3): situação de um salão elegível no horário pedido. Inelegível nem aparece. */
export type SituacaoSalao = "livre" | "ocupado" | "nao_comporta" | "abaixo_do_minimo";

/**
 * S-D (R3-D3): situação de cada salão ELEGÍVEL (horário × pacote; 098 só elegíveis), na ordem do escopo. Precedência:
 * motivo estrutural (abaixo do mínimo, não comporta) vence ocupado; ocupado (bloqueio da data, limite do dia ou salão
 * cruzado no intervalo) vence livre. Só no servidor; quem ocupa nunca sai. null fora da capacidade por salão.
 */
export function situacaoPorSalao(
  regra: RegraCapacidadeAgenda | null,
  configId: string,
  candidato: { inicioMinutos: number; fimMinutos: number },
  ocupacoes: OcupacaoConfirmadaRecord[],
  saloesDoPacote: string[] | null | undefined,
  convidados: number,
  bloqueado: boolean,
): Array<{ salaoId: string; situacao: SituacaoSalao }> | null {
  if (!regra || regra.capacidadeTipo !== "POR_SALAO") return null;
  const diaFechado = bloqueado || limiteDoDiaAtingido(regra, ocupacoes);
  return saloesCandidatos(regra, configId, saloesDoPacote).map((salaoId) => {
    const estrutural = motivoEstrutural(regra, salaoId, convidados);
    if (estrutural) return { salaoId, situacao: estrutural };
    if (diaFechado || !salaoLivre(regra, salaoId, candidato, ocupacoes)) return { salaoId, situacao: "ocupado" as const };
    return { salaoId, situacao: "livre" as const };
  });
}

/**
 * S-D: situação dos salões para UM horário exato (data, configuração, início/fim) do escopo, pela mesma leitura da
 * disponibilidade (bloqueios, ocupações confirmadas e regra da 093/094). null fora da capacidade por salão.
 */
export async function situacaoDosSaloesNoHorario(
  entrada: { data: string; configuracaoId: string; inicio: string; fim: string; convidados: number; saloesDoPacote?: string[] | null;
    /** E2b: só com combinadosPublicos (as três condições); senão a leitura do cliente da E2a. */
    incluirCombinados?: boolean },
  customDb: DbExecutor | undefined,
  escopo: EscopoAgenda,
) {
  validarPeriodo(entrada.data, entrada.data);
  const regra = await lerRegraCapacidadeAgenda(customDb, escopo, { incluirCombinados: entrada.incluirCombinados === true });
  if (!regra || regra.capacidadeTipo !== "POR_SALAO") return null;
  const bloqueios = await listarBloqueiosAtivosPorPeriodo(entrada.data, entrada.data, customDb, escopo);
  const ocupacoes = (await listarFechamentosConfirmadosPorPeriodo(entrada.data, entrada.data, customDb, escopo)).filter((o) => o.data === entrada.data);
  const candidato = { inicioMinutos: horaParaMinutos(entrada.inicio), fimMinutos: horaParaMinutos(entrada.fim) };
  const bloqueado = bloqueios.some((b) => b.data === entrada.data && bloqueioConflitaComCandidato(b, candidato));
  return situacaoPorSalao(regra, entrada.configuracaoId, candidato, ocupacoes, entrada.saloesDoPacote ?? null, entrada.convidados, bloqueado);
}

/**
 * S-C: opções de salão de um candidato (só contagens, nunca ids): salões do horário × pacote que comportam N, os livres
 * e os livres que comportam. null fora da capacidade por salão ou sem salão candidato (os convidados não mudam nada).
 */
export function opcoesDeSalao(
  regra: RegraCapacidadeAgenda | null,
  configId: string,
  candidato: { inicioMinutos: number; fimMinutos: number },
  ocupacoes: OcupacaoConfirmadaRecord[],
  saloesDoPacote: string[] | null | undefined,
  convidados: number,
) {
  if (!regra || regra.capacidadeTipo !== "POR_SALAO") return null;
  const saloes = saloesCandidatos(regra, configId, saloesDoPacote);
  if (saloes.length === 0) return null;
  const livres = saloes.filter((salao) => salaoLivre(regra, salao, candidato, ocupacoes));
  return {
    comportam: saloes.filter((salao) => salaoComporta(regra, salao, convidados)).length,
    livres: livres.length,
    livresQueComportam: livres.filter((salao) => salaoComporta(regra, salao, convidados)).length,
  };
}

/**
 * S-C: motivo para a tela. CAPACIDADE quando nenhum salão do horário comporta N, ou quando há salão livre mas nenhum
 * livre comporta; OCUPADO quando bloqueado, no limite do dia ou sem salão livre. null = sem capacidade por salão.
 */
export function capacidadeDoCandidato(
  regra: RegraCapacidadeAgenda | null,
  configId: string,
  candidato: { inicioMinutos: number; fimMinutos: number },
  ocupacoes: OcupacaoConfirmadaRecord[],
  saloesDoPacote: string[] | null | undefined,
  convidados: number,
  bloqueado: boolean,
): CapacidadeConvidadosPublica | null {
  const opcoes = opcoesDeSalao(regra, configId, candidato, ocupacoes, saloesDoPacote, convidados);
  if (!opcoes || !regra) return null;
  if (opcoes.comportam === 0) return { opcoes: 0, motivo: "CAPACIDADE" };
  if (bloqueado || limiteDoDiaAtingido(regra, ocupacoes) || opcoes.livres === 0) return { opcoes: 0, motivo: "OCUPADO" };
  if (opcoes.livresQueComportam === 0) return { opcoes: 0, motivo: "CAPACIDADE" };
  return { opcoes: opcoes.livresQueComportam, motivo: "OK" };
}

/** S-C: soma dos motivos (período ou dia): alguma opção = OK; senão algum por capacidade = CAPACIDADE; senão OCUPADO. */
export function motivoAgregado(itens: Array<CapacidadeConvidadosPublica | null | undefined>): CapacidadeConvidadosPublica | null {
  const presentes = itens.filter((i): i is CapacidadeConvidadosPublica => Boolean(i));
  if (presentes.length === 0) return null;
  const ok = presentes.filter((i) => i.motivo === "OK");
  if (ok.length) return { opcoes: Math.max(...ok.map((i) => i.opcoes)), motivo: "OK" };
  const motivo: MotivoCapacidade = presentes.some((i) => i.motivo === "CAPACIDADE") ? "CAPACIDADE" : "OCUPADO";
  return { opcoes: 0, motivo };
}

export async function consultarDisponibilidadePeriodo(
  inicio: string,
  fim: string,
  customDb?: DbExecutor,
  excluirFechamentoId?: string,
  escopoInformado?: EscopoConsulta,
  opcoes?: OpcoesDisponibilidade,
): Promise<DisponibilidadeDataPublica[]> {
  validarPeriodo(inicio, fim);

  const escopo = await resolverEscopo(customDb, escopoInformado, excluirFechamentoId);
  const [configuracoes, bloqueios, ocupacoesConfirmadas] = customDb
    ? [
        await listarConfiguracoesAgendaAtivas(customDb, escopo),
        await listarBloqueiosAtivosPorPeriodo(inicio, fim, customDb, escopo),
        await listarFechamentosConfirmadosPorPeriodo(inicio, fim, customDb, escopo),
      ]
    : await Promise.all([
        listarConfiguracoesAgendaAtivas(undefined, escopo),
        listarBloqueiosAtivosPorPeriodo(inicio, fim, undefined, escopo),
        listarFechamentosConfirmadosPorPeriodo(inicio, fim, undefined, escopo),
      ]);

  const regra = await lerRegraCapacidadeAgenda(customDb, escopo, { incluirCombinados: opcoes?.incluirCombinados === true });

  const livre = regra?.modo === "LIVRE" ? regra.horarioLivre ?? null : null;
  // Parecer do Astra (P3): a duração aceita é usada como veio, sem teto; a que não cabe no dia não gera candidatos.
  // Sem duração informada (P2-1): a do pacote mais curto da empresa; sem nenhum, 4 horas. Só consulta no modo livre.
  const duracao = opcoes?.duracaoMinutos && opcoes.duracaoMinutos > 0 ? opcoes.duracaoMinutos
    : (livre ? await menorDuracaoDosPacotes(customDb, escopo?.empresaId) : null) ?? DURACAO_PADRAO_MINUTOS;

  if (configuracoes.length === 0 && !livre) {
    throw new AvailabilityServiceError(
      "AGENDA_NAO_CONFIGURADA",
      "A agenda ainda não possui horários ativos configurados.",
      503,
    );
  }

  const porData = new Map<string, BloqueioAgendaRecord[]>();
  for (const bloqueio of bloqueios) {
    const lista = porData.get(bloqueio.data) ?? [];
    lista.push(bloqueio);
    porData.set(bloqueio.data, lista);
  }

  const ocupacoesPorData = new Map<string, OcupacaoConfirmadaRecord[]>();
  for (const ocupacao of ocupacoesConfirmadas) {
    if (ocupacao.fechamentoId === excluirFechamentoId) continue;
    const lista = ocupacoesPorData.get(ocupacao.data) ?? [];
    lista.push(ocupacao);
    ocupacoesPorData.set(ocupacao.data, lista);
  }

  const dias = diferencaDiasIso(inicio, fim);
  return Array.from({ length: dias + 1 }, (_, index) => {
    const data = adicionarDiasIso(inicio, index);
    const bloqueiosDoDia = porData.get(data) ?? [];
    const ocupacoesDoDia = ocupacoesPorData.get(data) ?? [];

    const convidados = opcoes?.convidados ?? null;
    const periodos = livre
      ? [calcularPeriodoPublico(livre, bloqueiosDoDia, ocupacoesDoDia, regra, gerarCandidatosLivres(livre.passoInicioMinutos, duracao), opcoes?.saloesDoPacote ?? null, convidados)]
      : configuracoes
        .filter((config) => horarioValeNaData(config, data))
        .map((config) => calcularPeriodoPublico(config, bloqueiosDoDia, ocupacoesDoDia, regra, undefined, opcoes?.saloesDoPacote ?? null, convidados));
    // S-C: o motivo do dia só existe com convidados e capacidade por salão; sem eles, a resposta é a de antes.
    const motivoDia = convidados ? motivoAgregado(periodos.map((p) => p.capacidade)) : null;
    return motivoDia ? { data, periodos, motivoDia } : { data, periodos };
  });
}

function calcularPeriodoPublico(
  config: Awaited<ReturnType<typeof listarConfiguracoesAgendaAtivas>>[number],
  bloqueios: BloqueioAgendaRecord[],
  ocupacoesConfirmadas: OcupacaoConfirmadaRecord[],
  regra: RegraCapacidadeAgenda | null = null,
  candidatos: ReturnType<typeof gerarHorariosCandidatos> = gerarHorariosCandidatos(config),
  saloesDoPacote: string[] | null = null,
  convidados: number | null = null,
): PeriodoDisponibilidadePublica {
  const horarios = candidatos.map((candidato) => {
    const bloqueado = bloqueios.some((bloqueio) =>
      bloqueioConflitaComCandidato(bloqueio, candidato),
    );
    const indisponivel =
      bloqueado ||
      ocupacaoImpedeCandidato(regra, config.id, candidato, ocupacoesConfirmadas, saloesDoPacote, convidados);
    const capacidade = convidados
      ? capacidadeDoCandidato(regra, config.id, candidato, ocupacoesConfirmadas, saloesDoPacote, convidados, bloqueado)
      : null;

    return {
      inicio: candidato.inicio,
      fim: candidato.fim,
      ajusteMinutos: candidato.ajusteMinutos,
      status: indisponivel ? ("INDISPONIVEL" as const) : ("DISPONIVEL" as const),
      ...(capacidade ? { capacidade } : {}),
    };
  });
  const capacidade = convidados ? motivoAgregado(horarios.map((h) => h.capacidade)) : null;

  return {
    ...(capacidade ? { capacidade } : {}),
    configuracaoId: config.id,
    codigo: config.codigo,
    nome: config.nome,
    horarioInicioPadrao: config.horarioInicioPadrao.slice(0, 5),
    horarioFimPadrao: config.horarioFimPadrao.slice(0, 5),
    status: horarios.some((item) => item.status === "DISPONIVEL")
      ? "DISPONIVEL"
      : "INDISPONIVEL",
    horarios,
  };
}

function validarPeriodo(inicio: string, fim: string) {
  if (!dataIsoValida(inicio) || !dataIsoValida(fim)) {
    throw new AvailabilityServiceError(
      "DATA_INVALIDA",
      "Informe datas válidas no formato YYYY-MM-DD.",
      400,
    );
  }

  const dias = diferencaDiasIso(inicio, fim);
  if (dias < 0) {
    throw new AvailabilityServiceError(
      "PERIODO_INVALIDO",
      "A data final deve ser igual ou posterior à data inicial.",
      400,
    );
  }

  if (dias + 1 > MAX_DIAS_CONSULTA) {
    throw new AvailabilityServiceError(
      "PERIODO_MUITO_LONGO",
      `Consulte no máximo ${MAX_DIAS_CONSULTA} dias por requisição.`,
      400,
    );
  }
}
