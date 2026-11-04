import type { DbExecutor } from '../../db/contracts.ts';

/**
 * Procedimento de rollback MULTI → PILOTO (§6 do plano r6.1), SOMENTE LEITURA. Nada aqui altera o banco: as consultas
 * medem e relatam. Quem executa o rollback (remover a chave + deploy) é a operação autorizada; este módulo dá:
 *  1. capturarPrevia  — antes do deploy: contagem por empresa e estado + os ids das saídas NÃO piloto em ENVIANDO (qualquer
 *                       idade). É só uma prévia (pode ficar incompleta durante a sobreposição de instâncias);
 *  2. corteT          — logo depois de o deploy ficar LIVE e a instância anterior sair: clock_timestamp() do BANCO (o mesmo
 *                       relógio que grava iniciada_em);
 *  3. listaEmVoo      — a lista OFICIAL, montada depois de T: (i) os ENVIANDO da prévia ∪ (ii) as saídas não piloto com
 *                       iniciada_em ≤ T em ENVIANDO/SUBMETIDA/ENTREGUE/INCERTO/FALHOU desde (início da prévia − 10 min);
 *                       cada id com o estado lido agora; FALHOU marcada "não enviada ou recusada";
 *  4. criteriosRollback — nenhuma PROCESSANDO/ENVIANDO não piloto com mais de 10 min; nenhuma mensagem não piloto com
 *                       iniciada_em > T exceto saídas CANCELADA; toda a lista em voo terminada (SUBMETIDA, ENTREGUE,
 *                       FALHOU ou INCERTO), relatada à parte.
 * Sem piloto configurada (`piloto` null), "não piloto" = todas as empresas do ambiente.
 */
export const ESTADOS_PREVIA = ['PENDENTE', 'PROCESSANDO', 'ENVIANDO', 'SUBMETIDA', 'INCERTO'] as const;
export const ESTADOS_RECONSTRUCAO = ['ENVIANDO', 'SUBMETIDA', 'ENTREGUE', 'INCERTO', 'FALHOU'] as const;
export const ESTADOS_TERMINADOS = ['SUBMETIDA', 'ENTREGUE', 'FALHOU', 'INCERTO'] as const;
export const PRAZO_RECUPERACAO_MIN = 10;

export type Previa = {
  inicio: Date;
  contagens: { empresa_id: string; estado: string; n: number }[];
  enviando: string[];
};
export type ItemEmVoo = { id: string; empresa_id: string; estado: string; iniciada_em: Date | null; origem: 'PREVIA' | 'RECONSTRUCAO' | 'AMBAS'; naoEnviadaOuRecusada: boolean };
export type Criterios = { ok: boolean; presasMaisDe10Min: string[]; depoisDeT: string[]; emVooNaoTerminadas: string[] };

const naoPiloto = (coluna: string, parametro: string) => `(${parametro}::uuid IS NULL OR ${coluna} <> ${parametro}::uuid)`;

export async function capturarPrevia(tx: DbExecutor, alvo: { ambiente: string; piloto: string | null }): Promise<Previa> {
  const inicio = (await tx.query<{ agora: Date }>('SELECT clock_timestamp() AS agora')).rows[0].agora;
  const contagens = (await tx.query<{ empresa_id: string; estado: string; n: string }>(`SELECT empresa_id, estado, count(*) AS n FROM whatsapp_atendimento_mensagens
    WHERE ambiente=$1 AND estado = ANY($2::text[]) GROUP BY empresa_id, estado ORDER BY empresa_id, estado`, [alvo.ambiente, [...ESTADOS_PREVIA]])).rows
    .map((l) => ({ empresa_id: l.empresa_id, estado: l.estado, n: Number(l.n) }));
  const enviando = (await tx.query<{ id: string }>(`SELECT id FROM whatsapp_atendimento_mensagens
    WHERE ambiente=$1 AND direcao='SAIDA' AND estado='ENVIANDO' AND ${naoPiloto('empresa_id', '$2')} ORDER BY id`, [alvo.ambiente, alvo.piloto])).rows.map((l) => l.id);
  return { inicio, contagens, enviando };
}

export async function corteT(tx: DbExecutor): Promise<Date> {
  return (await tx.query<{ agora: Date }>('SELECT clock_timestamp() AS agora')).rows[0].agora;
}

export async function listaEmVoo(tx: DbExecutor, alvo: { ambiente: string; piloto: string | null; previa: Previa; T: Date }): Promise<ItemEmVoo[]> {
  const reconstruidas = (await tx.query<{ id: string }>(`SELECT id FROM whatsapp_atendimento_mensagens
    WHERE ambiente=$1 AND direcao='SAIDA' AND ${naoPiloto('empresa_id', '$2')} AND estado = ANY($3::text[])
      AND iniciada_em <= $4::timestamptz AND iniciada_em >= $5::timestamptz - make_interval(mins => $6)`,
  [alvo.ambiente, alvo.piloto, [...ESTADOS_RECONSTRUCAO], alvo.T, alvo.previa.inicio, PRAZO_RECUPERACAO_MIN])).rows.map((l) => l.id);
  const daPrevia = new Set(alvo.previa.enviando), daReconstrucao = new Set(reconstruidas);
  const ids = [...new Set([...daPrevia, ...daReconstrucao])];
  if (!ids.length) return [];
  const linhas = (await tx.query<{ id: string; empresa_id: string; estado: string; iniciada_em: Date | null }>(
    'SELECT id, empresa_id, estado, iniciada_em FROM whatsapp_atendimento_mensagens WHERE ambiente=$1 AND id = ANY($2::uuid[]) ORDER BY iniciada_em NULLS FIRST, id', [alvo.ambiente, ids])).rows;
  return linhas.map((l) => ({
    ...l,
    origem: daPrevia.has(l.id) && daReconstrucao.has(l.id) ? 'AMBAS' : daPrevia.has(l.id) ? 'PREVIA' : 'RECONSTRUCAO',
    naoEnviadaOuRecusada: l.estado === 'FALHOU',
  }));
}

export async function criteriosRollback(tx: DbExecutor, alvo: { ambiente: string; piloto: string | null; T: Date; emVoo: ItemEmVoo[] }): Promise<Criterios> {
  const presasMaisDe10Min = (await tx.query<{ id: string }>(`SELECT id FROM whatsapp_atendimento_mensagens
    WHERE ambiente=$1 AND ${naoPiloto('empresa_id', '$2')} AND estado IN ('PROCESSANDO','ENVIANDO')
      AND iniciada_em < clock_timestamp() - make_interval(mins => $3) ORDER BY id`, [alvo.ambiente, alvo.piloto, PRAZO_RECUPERACAO_MIN])).rows.map((l) => l.id);
  const depoisDeT = (await tx.query<{ id: string }>(`SELECT id FROM whatsapp_atendimento_mensagens
    WHERE ambiente=$1 AND ${naoPiloto('empresa_id', '$2')} AND iniciada_em > $3::timestamptz
      AND NOT (direcao='SAIDA' AND estado='CANCELADA') ORDER BY id`, [alvo.ambiente, alvo.piloto, alvo.T])).rows.map((l) => l.id);
  const terminados: readonly string[] = ESTADOS_TERMINADOS;
  const emVooNaoTerminadas = alvo.emVoo.filter((i) => !terminados.includes(i.estado)).map((i) => i.id);
  return { ok: !presasMaisDe10Min.length && !depoisDeT.length && !emVooNaoTerminadas.length, presasMaisDe10Min, depoisDeT, emVooNaoTerminadas };
}
