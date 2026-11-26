import type { DbExecutor } from '../../db/contracts.ts';

/**
 * D-LAN-3 / melhoria 3b (23/11/2026, r2): teto mensal de mensagens pela Cloud API, por empresa e ambiente (um número por
 * empresa em cada ambiente). Desde 01/10/2026 a Meta cobra a resposta de serviço acima de 1.000 por mês por número, na
 * conta de mensagens (WABA) do buffet.
 *
 * Duas coisas separadas (Astra r1, P1):
 *  - FRANQUIA_META: as 1.000 respostas do mês que a Meta não cobra. Fixa, definida pela Meta; não é configurável aqui.
 *  - limite do Wall-e (WHATSAPP_TETO_MENSAL_RESPOSTAS, padrão e MÁXIMO 1.000, Termos 2026-11-25): ao atingi-lo o Wall-e
 *    para e passa em silêncio para a equipe. Nunca passa da franquia: os Termos prometem parar em até 1.000. A equipe continua respondendo; o que passar da franquia é cobrado pela Meta no cartão do buffet.
 *
 * Consumo (135, whatsapp_atendimento_consumo_mensal): cada saída do atendimento pela Meta soma 1 na criação (equipe e
 * Wall-e; texto + PDF = 2). O Wall-e RESERVA o grupo inteiro na mesma transação que grava as saídas, só se couber no
 * limite; a trava da linha serializa conversas simultâneas. O agregado não tem dado pessoal nem ligação com conversas:
 * excluir uma conversa não devolve cota. Falha ou cancelamento depois da reserva também não devolve: é ESTIMATIVA
 * conservadora (acima da fatura da Meta, nunca abaixo). Sem a 135 no banco (Termos 2026-11-25, Astra r1 P1): o consumo não
 * pode ser apurado, então o Wall-e NÃO responde (a conversa vai à equipe em silêncio); a equipe envia sem registro.
 *
 * A piloto (número da própria Demerzel) fica FORA do teto e do consumo em qualquer canal (recorte de Felipe, 23/11, depois
 * da Astra r2 P1): sem depender do canal lido no envio, a troca Gupshup→Meta dela não cria envio pela Meta sem reserva.
 * Todas as outras empresas enviam só pela Meta e contam.
 */
export const FRANQUIA_META = 1000;
export const TETO_MENSAL_PADRAO = 1000;
const TETO_MAXIMO = FRANQUIA_META;
export const FRACAO_AVISO = 0.8;
const MES_SP = "to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM')";

/** WHATSAPP_TETO_MENSAL_RESPOSTAS: inteiro de 1 a 1.000; ausente, inválido ou acima de 1.000 = 1.000 (nunca desliga o teto
 *  nem passa da franquia da Meta). */
export function tetoMensal(env: Record<string, string | undefined> = process.env) {
  const bruto = env.WHATSAPP_TETO_MENSAL_RESPOSTAS?.trim();
  if (!bruto || !/^\d+$/.test(bruto)) return TETO_MENSAL_PADRAO;
  const n = Number(bruto);
  return n >= 1 && n <= TETO_MAXIMO ? n : TETO_MENSAL_PADRAO;
}

/** A empresa conta no teto? Toda empresa que não é a piloto; a piloto nunca, em qualquer canal (recorte de 23/11). */
export function contaNoTeto(empresa: string, piloto: string | null) {
  return !piloto || empresa.toLowerCase() !== piloto.toLowerCase();
}

export type SituacaoTeto = {
  mes: string; usadas: number; franquiaMeta: number; limite: number; aviso: number;
  estado: 'NORMAL' | 'AVISO' | 'ATINGIDO'; acimaDaFranquia: boolean;
};

/** Aviso em 80% do limite do Wall-e, arredondado para CIMA (1.000 ⇒ 800; 5 ⇒ 4). */
export function situacaoTeto(usadas: number, limite: number, mes: string): SituacaoTeto {
  const aviso = Math.ceil(limite * FRACAO_AVISO);
  return { mes, usadas, franquiaMeta: FRANQUIA_META, limite, aviso,
    estado: usadas >= limite ? 'ATINGIDO' : usadas >= aviso ? 'AVISO' : 'NORMAL', acimaDaFranquia: usadas > FRANQUIA_META };
}

export async function tem135(tx: DbExecutor) {
  return (await tx.query<{ e: boolean }>("SELECT to_regclass('public.whatsapp_atendimento_consumo_mensal') IS NOT NULL AS e")).rows[0]?.e === true;
}

/** Consumo do mês corrente (São Paulo, relógio do banco). Sem a 135: null. */
export async function consumoDoMes(tx: DbExecutor, empresa: string, ambiente: string) {
  if (!(await tem135(tx))) return null;
  // Astra r4 (P3): o mês é calculado UMA vez (CTE); a virada em São Paulo não junta o mês de um instante ao saldo de outro.
  const r = (await tx.query<{ mes: string; usadas: number | null }>(`WITH m AS (SELECT ${MES_SP} AS mes)
    SELECT m.mes, (SELECT usadas FROM whatsapp_atendimento_consumo_mensal WHERE empresa_id=$1 AND ambiente=$2 AND mes=m.mes) AS usadas FROM m`, [empresa, ambiente])).rows[0];
  return { mes: r.mes, usadas: Number(r.usadas ?? 0) };
}

export async function tetoDoMes(tx: DbExecutor, empresa: string, ambiente: string, env: Record<string, string | undefined> = process.env) {
  const c = await consumoDoMes(tx, empresa, ambiente);
  return c ? situacaoTeto(c.usadas, tetoMensal(env), c.mes) : null;
}

/**
 * Soma `k` mensagens ao consumo do mês. Com `limite`, ATÔMICO: só soma se usadas + k <= limite (o grupo inteiro ou
 * nada); devolve false se não coube. Sem limite (equipe), soma sempre. Sem a 135 nada é gravado: a equipe (sem limite)
 * recebe true; o Wall-e (com limite) recebe false, porque o consumo não pode ser apurado (Termos 2026-11-25).
 * Chamar na MESMA transação que grava as saídas: rollback desfaz a reserva.
 */
export async function reservarConsumo(tx: DbExecutor, empresa: string, ambiente: string, k: number, limite: number | null) {
  if (k <= 0) return true;
  if (!(await tem135(tx))) return limite === null;
  const r = await tx.query(`INSERT INTO whatsapp_atendimento_consumo_mensal AS c (empresa_id,ambiente,mes,usadas)
      SELECT $1::uuid,$2,${MES_SP},$3::int WHERE $4::int IS NULL OR $3::int <= $4::int
    ON CONFLICT (empresa_id,ambiente,mes) DO UPDATE SET usadas=c.usadas+EXCLUDED.usadas,atualizado_em=clock_timestamp()
      WHERE $4::int IS NULL OR c.usadas+EXCLUDED.usadas <= $4::int
    RETURNING c.usadas`, [empresa, ambiente, k, limite]);
  return r.rows.length === 1;
}
