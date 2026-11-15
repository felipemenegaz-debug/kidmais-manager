import { createHmac } from "node:crypto";
import type { DbExecutor } from "../db/contracts.ts";
import { isPostgresError } from "../db/errors.ts";
import { criarLimitador, SEM_ORIGEM_FATOR } from "../http/limite-publico.ts";

/**
 * Limites no banco (123, tabela limites_contadores): contam entre réplicas e sobrevivem a reinício. Janela fixa.
 * A chave é um HMAC (pepper da identidade) de "regra|sujeito": o banco nunca vê IP, documento nem id em claro.
 *
 * Sem a 123 (42P01: tabela ausente), cai no limitador em memória de lib/http/limite-publico.ts (grupo IDENTIDADE),
 * como antes. Outro erro de banco recusa (fail-closed).
 *
 * Gravar o contador SEMPRE fora da transação do pedido: uma recusa (rollback) não pode devolver a tentativa.
 */
export type RegraLimite = { nome: string; limite: number; janelaSegundos: number };

export const LIMITES = {
  /** Pedido de código na área: por origem. */
  AREA_INICIAR_ORIGEM: { nome: "area:iniciar:origem", limite: 10, janelaSegundos: 3600 },
  /** Confirmação de código na área: por origem. */
  AREA_CONFIRMAR_ORIGEM: { nome: "area:confirmar:origem", limite: 30, janelaSegundos: 3600 },
  /** Confirmação de código do fechamento e do contrato (/api/identidade/confirmar-codigo). */
  IDENTIDADE_CONFIRMAR_ORIGEM: { nome: "identidade:confirmar:origem", limite: 30, janelaSegundos: 3600 },
  /** Rotas públicas do contrato (consulta, desafio, recuperação, envio por e-mail): por origem. */
  CONTRATO_PUBLICO_ORIGEM: { nome: "contrato:publico:origem", limite: 40, janelaSegundos: 3600 },
  /** Reserva por e-mail do código: por origem. */
  RESERVA_EMAIL_ORIGEM: { nome: "identidade:reserva-email:origem", limite: 6, janelaSegundos: 3600 },
  /** Leituras pesadas da área (PDF e Pix): por SESSÃO, não por origem (o sujeito é o id da sessão). */
  AREA_LEITURA_SESSAO: { nome: "area:leitura:sessao", limite: 120, janelaSegundos: 3600 },
} as const satisfies Record<string, RegraLimite>;

const memoria = criarLimitador();

function chave(regra: RegraLimite, sujeito: string, pepper: string) {
  return createHmac("sha256", pepper).update("limite|").update(regra.nome).update("|").update(sujeito).digest("hex");
}

/**
 * Conta uma leitura da sessão (sujeito "sessao:<id>", sempre presente; sem o multiplicador de "sem origem").
 * Mesma chave HMAC e mesma janela fixa de consumirLimite. Sem a 123 não há sessão, então não há fallback aqui.
 */
export async function consumirLimiteDaSessao(conexao: DbExecutor, regra: RegraLimite, sessaoId: string, pepper: string): Promise<number | null> {
  const { rows } = await conexao.query<{ usados: number; espera: number }>(
    `WITH j AS (SELECT to_timestamp(floor(extract(epoch FROM clock_timestamp()) / $2::int) * $2::int) AS inicio)
     INSERT INTO limites_contadores (chave, janela_inicio, usados, expira_em)
     SELECT $1, j.inicio, 1, j.inicio + make_interval(secs => $2::int) FROM j
     ON CONFLICT (chave, janela_inicio) DO UPDATE SET usados = limites_contadores.usados + 1
     RETURNING usados, greatest(1, ceil(extract(epoch FROM expira_em - clock_timestamp())))::int AS espera`,
    [chave(regra, `sessao:${sessaoId}`, pepper), regra.janelaSegundos],
  );
  return rows[0].usados > regra.limite ? rows[0].espera : null;
}

/**
 * Conta uma tentativa. Devolve null (segue) ou os segundos até liberar. Sem origem confiável, conta pelo `escopo`
 * (empresa ou rota) com teto SEM_ORIGEM_FATOR vezes maior, como o limitador público: nunca o limite de um IP para todos.
 */
export async function consumirLimite(
  conexao: DbExecutor,
  regra: RegraLimite,
  origem: string | null,
  escopo: string,
  pepper: string,
): Promise<number | null> {
  const sujeito = origem ? `ip:${origem}` : `sem-origem:${escopo}`;
  const limite = origem ? regra.limite : regra.limite * SEM_ORIGEM_FATOR;
  try {
    const { rows } = await conexao.query<{ usados: number; espera: number }>(
      `WITH j AS (SELECT to_timestamp(floor(extract(epoch FROM clock_timestamp()) / $2::int) * $2::int) AS inicio)
       INSERT INTO limites_contadores (chave, janela_inicio, usados, expira_em)
       SELECT $1, j.inicio, 1, j.inicio + make_interval(secs => $2::int) FROM j
       ON CONFLICT (chave, janela_inicio) DO UPDATE SET usados = limites_contadores.usados + 1
       RETURNING usados, greatest(1, ceil(extract(epoch FROM expira_em - clock_timestamp())))::int AS espera`,
      [chave(regra, sujeito, pepper), regra.janelaSegundos],
    );
    // Limpeza oportunista dos vencidos (1 em 50 pedidos), sem custo no caminho comum.
    if (Math.random() < 0.02) await conexao.query("DELETE FROM limites_contadores WHERE expira_em < clock_timestamp() - interval '1 hour'");
    const linha = rows[0];
    return linha.usados > limite ? linha.espera : null;
  } catch (error) {
    if (isPostgresError(error) && error.code === "42P01") return memoria.verificar(origem, "IDENTIDADE", `limite:${escopo}`);
    throw error;
  }
}
