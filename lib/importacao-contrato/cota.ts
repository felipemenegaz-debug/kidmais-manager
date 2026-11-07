import type { DbExecutor } from "../db/contracts.ts";
import { planoConfirmado } from "../assinatura/limites-usuarios.ts";

/**
 * Cota de leitura de documentos da importação de contratos (L2; plano rev. 5.1 R1-1/R2-1/R3-1 e delta D-LOTE-8 rev. 6.1,
 * aprovados pelo Astra em 31/10/2026). Tabelas da migration 118. Vale para o envio único e para o lote.
 *
 * - Identidade: empresa + sha256 do arquivo, para a vida toda. Releitura, reenvio e reimportação não contam de novo.
 * - Reserva antes de ler, sob a trava da empresa (`ia_importacao_cotas … FOR UPDATE`), com o instante T lido por
 *   `clock_timestamp()` DEPOIS da trava; o mesmo T decide vigência, saldo, período, janela e prazo daquela transação.
 * - Cada reserva tem dono (`operacao_id`): concluir e liberar exigem posse, estado e prazo; uma execução que perdeu a posse
 *   recebe LEITURA_EXPIRADA e a transação inteira (inclusive a extração) volta atrás.
 * - Franquia (D-LOTE-6): Essencial 5 na implantação, Profissional 10/mês, Premium 30/mês (mês civil de São Paulo).
 * - Extra de migração (D-LOTE-8): +50/+100/+200, só com plano confirmado, consumido antes da franquia, numa janela de 30
 *   dias que começa na primeira leitura COM DADOS e plano confirmado (gravada na conclusão, nunca na reserva).
 * - Sem plano confirmado (teste, legado, isenta): mede sem recusar (o uso é gravado no mês, sem extra nem marco).
 */
export const FRANQUIA_IMPORTACAO = Object.freeze({
  essencial: Object.freeze({ quantidade: 5, periodo: "IMPLANTACAO" as const }),
  profissional: Object.freeze({ quantidade: 10, periodo: "MENSAL" as const }),
  premium: Object.freeze({ quantidade: 30, periodo: "MENSAL" as const }),
});
export const EXTRA_MIGRACAO = Object.freeze({ essencial: 50, profissional: 100, premium: 200 });
export const PRAZO_RESERVA_MINUTOS = 15;
export const JANELA_MIGRACAO_DIAS = 30;

export type PlanoCota = keyof typeof FRANQUIA_IMPORTACAO;
export type CodigoCota = "COTA_IMPORTACAO_ESGOTADA" | "COTA_INDISPONIVEL" | "LEITURA_EM_ANDAMENTO" | "LEITURA_EXPIRADA";

export class ErroCota extends Error {
  readonly codigo: CodigoCota;
  readonly status: number;
  constructor(codigo: CodigoCota, mensagem: string, status: number) {
    super(mensagem);
    this.name = "ErroCota";
    this.codigo = codigo;
    this.status = status;
  }
}

const esgotada = (plano: PlanoCota) => new ErroCota("COTA_IMPORTACAO_ESGOTADA", plano === "essencial"
  ? "A cota de leitura de documentos do plano Essencial (5 na implantação) foi usada. Nenhum arquivo foi lido."
  : `A cota de leitura de documentos do mês (${FRANQUIA_IMPORTACAO[plano].quantidade}) foi usada. Nenhum arquivo foi lido.`, 409);
const indisponivel = () => new ErroCota("COTA_INDISPONIVEL", "Não foi possível conferir a cota de leitura de documentos agora. Nenhum arquivo foi lido.", 503);
const emAndamento = () => new ErroCota("LEITURA_EM_ANDAMENTO", "Este arquivo já está sendo lido em outro envio. Aguarde alguns minutos.", 409);
const expirada = () => new ErroCota("LEITURA_EXPIRADA", "A leitura demorou demais e não foi salva. Envie o arquivo de novo.", 409);

export type Posse = { usoId: string; operacaoId: string; periodo: string };
export type ResultadoReserva = { tipo: "RESERVADA"; posse: Posse } | { tipo: "JA_CONTADO" };

/** Decisão pura do período de uma reserva nova (depois da deduplicação por sha256). */
export type EntradaPeriodo = {
  plano: PlanoCota | null;
  /** kidmais_118_janela_migracao(migracao_inicio, T): aberta antes do marco e em [inicio, inicio + 30 dias). */
  janelaAberta: boolean;
  /** Usos válidos MIGRACAO da empresa (CONSUMIDA + RESERVADA com expira_em > T), por toda a janela. */
  usadosMigracao: number;
  /** Usos válidos do período normal (IMPLANTACAO no Essencial; mês civil de São Paulo nos demais). */
  usadosPeriodo: number;
  /** Mês civil de São Paulo de T (YYYY-MM). */
  mes: string;
};
export type DecisaoPeriodo = { periodo: string; limite: number | null } | { esgotada: true; plano: PlanoCota };

export function periodoNormal(plano: PlanoCota | null, mes: string) {
  return plano && FRANQUIA_IMPORTACAO[plano].periodo === "IMPLANTACAO" ? "IMPLANTACAO" : mes;
}

export function decidirPeriodo(e: EntradaPeriodo): DecisaoPeriodo {
  if (e.plano && e.janelaAberta && e.usadosMigracao < EXTRA_MIGRACAO[e.plano]) return { periodo: "MIGRACAO", limite: EXTRA_MIGRACAO[e.plano] };
  const periodo = periodoNormal(e.plano, e.mes);
  if (!e.plano) return { periodo, limite: null };
  const limite = FRANQUIA_IMPORTACAO[e.plano].quantidade;
  return e.usadosPeriodo >= limite ? { esgotada: true, plano: e.plano } : { periodo, limite };
}

/** Plano confirmado (lib/assinatura). Falha de leitura ou plano fora da tabela ⇒ COTA_INDISPONIVEL (falha fechada). */
async function planoDaCota(tx: DbExecutor, empresaId: string): Promise<PlanoCota | null> {
  let p: string | null;
  try { p = await planoConfirmado(tx, empresaId, "Não foi possível conferir o plano contratado."); } catch { throw indisponivel(); }
  if (p === null) return null;
  if (!Object.hasOwn(FRANQUIA_IMPORTACAO, p)) throw indisponivel();
  return p as PlanoCota;
}

/** Tabelas e funções da 118 presentes. */
export async function cotaInstalada(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT to_regclass('public.ia_importacao_cotas') IS NOT NULL AND to_regclass('public.ia_importacao_usos') IS NOT NULL
        AND to_regprocedure('public.kidmais_118_janela_migracao(timestamptz,timestamptz)') IS NOT NULL
        AND to_regprocedure('public.kidmais_118_periodo_mensal(timestamptz)') IS NOT NULL AS ok`,
  );
  return r.rows[0]?.ok === true;
}

/**
 * Trava a linha da empresa (criada sob demanda) e SÓ DEPOIS lê T. O texto de T preserva os microssegundos e é usado como
 * `$T::timestamptz` em todas as regras da transação (nenhum instante anterior à trava é reaproveitado).
 */
async function travar(tx: DbExecutor, empresaId: string) {
  await tx.query(`INSERT INTO ia_importacao_cotas (empresa_id) VALUES ($1::uuid) ON CONFLICT (empresa_id) DO NOTHING`, [empresaId]);
  const trava = await tx.query<{ migracao_inicio: string | null }>(
    `SELECT migracao_inicio::text FROM ia_importacao_cotas WHERE empresa_id = $1::uuid FOR UPDATE`, [empresaId]);
  if (!trava.rows[0]) throw indisponivel();
  const t = (await tx.query<{ t: string }>(`SELECT clock_timestamp()::text AS t`)).rows[0]?.t;
  if (!t) throw indisponivel();
  return { T: t, migracaoInicio: trava.rows[0].migracao_inicio };
}

/** Usos válidos em T: CONSUMIDA ou RESERVADA ainda no prazo. */
const VALIDO = `(estado = 'CONSUMIDA' OR (estado = 'RESERVADA' AND expira_em > $2::timestamptz))`;

async function contar(tx: DbExecutor, empresaId: string, T: string, periodo: string) {
  const r = await tx.query<{ migracao: number; periodo: number; janela: boolean; mes: string }>(
    `SELECT (SELECT count(*)::int FROM ia_importacao_usos WHERE empresa_id = $1::uuid AND periodo = 'MIGRACAO' AND ${VALIDO}) AS migracao,
            (SELECT count(*)::int FROM ia_importacao_usos WHERE empresa_id = $1::uuid AND periodo = $3 AND ${VALIDO}) AS periodo,
            kidmais_118_janela_migracao(c.migracao_inicio, $2::timestamptz) AS janela,
            kidmais_118_periodo_mensal($2::timestamptz) AS mes
       FROM ia_importacao_cotas c WHERE c.empresa_id = $1::uuid`,
    [empresaId, T, periodo],
  );
  const l = r.rows[0];
  if (!l || !Number.isSafeInteger(l.migracao) || !Number.isSafeInteger(l.periodo) || typeof l.janela !== "boolean" || !/^\d{4}-\d{2}$/.test(l.mes)) throw indisponivel();
  return l;
}

async function mesDe(tx: DbExecutor, T: string) {
  const mes = (await tx.query<{ mes: string }>(`SELECT kidmais_118_periodo_mensal($1::timestamptz) AS mes`, [T])).rows[0]?.mes;
  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) throw indisponivel();
  return mes;
}

/**
 * Reserva antes da leitura (transação de recepção). Ordem: trava → T → identidade do arquivo → plano → saldo → reserva.
 * - CONSUMIDA do mesmo arquivo: lê sem débito (já contou uma vez);
 * - RESERVADA vigente: LEITURA_EM_ANDAMENTO, sem ler (não há reserva compartilhada);
 * - RESERVADA vencida: liberada com posse e prazo conferidos e decidida de novo como arquivo novo;
 * - sem linha viva: MIGRACAO (extra da janela) antes da franquia; sem saldo, COTA_IMPORTACAO_ESGOTADA antes de ler.
 */
export async function reservarCota(tx: DbExecutor, e: { empresaId: string; documentoId: string; sha256: string }): Promise<ResultadoReserva> {
  const { T } = await travar(tx, e.empresaId);
  const viva = (await tx.query<{ id: string; operacao_id: string; estado: string; vigente: boolean }>(
    `SELECT id::text, operacao_id::text, estado, expira_em > $3::timestamptz AS vigente FROM ia_importacao_usos
      WHERE empresa_id = $1::uuid AND sha256 = $2 AND estado IN ('RESERVADA', 'CONSUMIDA')`,
    [e.empresaId, e.sha256, T],
  )).rows[0];
  if (viva?.estado === "CONSUMIDA") return { tipo: "JA_CONTADO" };
  if (viva?.estado === "RESERVADA" && viva.vigente) throw emAndamento();
  if (viva) {
    const liberada = await tx.query(
      `UPDATE ia_importacao_usos SET estado = 'LIBERADA', atualizado_em = $4::timestamptz
        WHERE id = $1::uuid AND empresa_id = $2::uuid AND operacao_id = $3::uuid AND estado = 'RESERVADA' AND expira_em <= $4::timestamptz`,
      [viva.id, e.empresaId, viva.operacao_id, T],
    );
    if (liberada.rowCount !== 1) throw indisponivel();
  }
  const p = await planoDaCota(tx, e.empresaId);
  const normal = periodoNormal(p, await mesDe(tx, T));
  const c = await contar(tx, e.empresaId, T, normal);
  const decisao = decidirPeriodo({ plano: p, janelaAberta: c.janela, usadosMigracao: c.migracao, usadosPeriodo: c.periodo, mes: c.mes });
  if ("esgotada" in decisao) throw esgotada(decisao.plano);
  const r = await tx.query<{ id: string; operacao_id: string }>(
    `INSERT INTO ia_importacao_usos (empresa_id, sha256, documento_id, operacao_id, periodo, estado, expira_em, criado_em, atualizado_em)
     VALUES ($1::uuid, $2, $3::uuid, gen_random_uuid(), $4, 'RESERVADA', $5::timestamptz + make_interval(mins => $6), $5::timestamptz, $5::timestamptz)
     RETURNING id::text, operacao_id::text`,
    [e.empresaId, e.sha256, e.documentoId, decisao.periodo, T, PRAZO_RESERVA_MINUTOS],
  );
  const l = r.rows[0];
  if (!l) throw indisponivel();
  return { tipo: "RESERVADA", posse: { usoId: l.id, operacaoId: l.operacao_id, periodo: decisao.periodo } };
}

/**
 * Conclusão na MESMA transação que grava a extração, antes dela. Com dados ⇒ CONSUMIDA; sem dados ⇒ LIBERADA. As duas
 * exigem posse, estado RESERVADA e prazo (`expira_em > T`, T lido depois da trava). 0 linhas ⇒ LEITURA_EXPIRADA, e a
 * transação inteira volta atrás. O período reservado não muda. O marco da janela de migração nasce aqui: primeira transição
 * RESERVADA → CONSUMIDA com plano confirmado em T, só se ainda nulo (no mesmo commit do consumo).
 */
export async function concluirCota(tx: DbExecutor, e: { empresaId: string; posse: Posse; comDados: boolean }) {
  const { T } = await travar(tx, e.empresaId);
  const r = await tx.query(
    `UPDATE ia_importacao_usos SET estado = $4, atualizado_em = $5::timestamptz
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND operacao_id = $3::uuid AND estado = 'RESERVADA' AND expira_em > $5::timestamptz`,
    [e.posse.usoId, e.empresaId, e.posse.operacaoId, e.comDados ? "CONSUMIDA" : "LIBERADA", T],
  );
  if (r.rowCount !== 1) throw expirada();
  if (!e.comDados) return;
  if (await planoDaCota(tx, e.empresaId)) {
    await tx.query(`UPDATE ia_importacao_cotas SET migracao_inicio = $2::timestamptz WHERE empresa_id = $1::uuid AND migracao_inicio IS NULL`, [e.empresaId, T]);
  }
}

/** Falha entre reservar e concluir: libera só a PRÓPRIA reserva ainda aberta. Nunca reverte CONSUMIDA nem toca sucessor. */
export async function liberarCota(tx: DbExecutor, e: { empresaId: string; posse: Posse }) {
  const { T } = await travar(tx, e.empresaId);
  const r = await tx.query(
    `UPDATE ia_importacao_usos SET estado = 'LIBERADA', atualizado_em = $4::timestamptz
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND operacao_id = $3::uuid AND estado = 'RESERVADA'`,
    [e.posse.usoId, e.empresaId, e.posse.operacaoId, T],
  );
  return r.rowCount === 1;
}

export type ResumoCota = {
  plano: PlanoCota | null;
  /** Franquia normal: período (YYYY-MM ou IMPLANTACAO), usados válidos e limite (null = sem limite, só medição). */
  franquia: { periodo: string; usados: number; limite: number | null };
  /** Extra de migração enquanto a janela está aberta e há plano confirmado; `ate` nulo = a janela ainda não começou. */
  migracao: { usados: number; extra: number; ate: string | null } | null;
};

/** Leitura para a tela (sem trava e sem escrita): o mesmo critério de "válido" da reserva, no instante atual. */
export async function resumoCota(tx: DbExecutor, empresaId: string): Promise<ResumoCota> {
  const T = (await tx.query<{ t: string }>(`SELECT clock_timestamp()::text AS t`)).rows[0]?.t;
  if (!T) throw indisponivel();
  const p = await planoDaCota(tx, empresaId);
  const normal = periodoNormal(p, await mesDe(tx, T));
  const linha = (await tx.query<{ migracao: number; periodo: number; janela: boolean; ate: string | null }>(
    `SELECT (SELECT count(*)::int FROM ia_importacao_usos WHERE empresa_id = $1::uuid AND periodo = 'MIGRACAO' AND ${VALIDO}) AS migracao,
            (SELECT count(*)::int FROM ia_importacao_usos WHERE empresa_id = $1::uuid AND periodo = $3 AND ${VALIDO}) AS periodo,
            kidmais_118_janela_migracao((SELECT migracao_inicio FROM ia_importacao_cotas WHERE empresa_id = $1::uuid), $2::timestamptz) AS janela,
            to_char(((SELECT migracao_inicio FROM ia_importacao_cotas WHERE empresa_id = $1::uuid) + interval '720 hours') AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS ate`,
    [empresaId, T, normal],
  )).rows[0];
  if (!linha || !Number.isSafeInteger(linha.migracao) || !Number.isSafeInteger(linha.periodo)) throw indisponivel();
  return {
    plano: p,
    franquia: { periodo: normal, usados: linha.periodo, limite: p ? FRANQUIA_IMPORTACAO[p].quantidade : null },
    migracao: p && linha.janela ? { usados: linha.migracao, extra: EXTRA_MIGRACAO[p], ate: linha.ate } : null,
  };
}

/**
 * Resumo para a tela de revisão (só exibição): sem as tabelas ou com qualquer falha, null, e a revisão segue sem a linha.
 * O savepoint impede que uma falha de SQL aqui aborte a transação de quem chama.
 */
export async function resumoCotaParaTela(tx: DbExecutor, empresaId: string, ler: typeof resumoCota = resumoCota): Promise<ResumoCota | null> {
  await tx.query("SAVEPOINT kidmais_118_resumo_tela");
  try {
    const resumo = await cotaInstalada(tx) ? await ler(tx, empresaId) : null;
    await tx.query("RELEASE SAVEPOINT kidmais_118_resumo_tela");
    return resumo;
  } catch {
    await tx.query("ROLLBACK TO SAVEPOINT kidmais_118_resumo_tela");
    await tx.query("RELEASE SAVEPOINT kidmais_118_resumo_tela");
    return null;
  }
}
