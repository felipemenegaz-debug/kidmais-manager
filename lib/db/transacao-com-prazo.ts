import type { DbExecutor, DbQueryResult } from "./contracts";

/**
 * Transação com PRAZO DO LADO DA APLICAÇÃO, para caminhos curtos que não podem ficar pendurados (o marcador de exclusão
 * de assinatura e o resultado do DELETE, lib/assinatura/reconciliacao-contratacao.ts). `statement_timeout` e
 * `lock_timeout` agem no servidor; se a conexão TCP parar sem erro, a resposta nunca chega e a espera seria infinita.
 *
 * Regras:
 *   - um prazo único cobre obter a conexão, BEGIN, as consultas, COMMIT e o ROLLBACK de uma falha conhecida;
 *   - prazo vencido → a conexão é DESCARTADA (soquete destruído; nunca volta ao pool) e a transação falha com
 *     PrazoDaTransacaoVencido; o servidor desfaz o que estava aberto quando percebe a desconexão;
 *   - depois do prazo, nenhuma consulta nova é enviada; a resposta pendente, se vier, é ignorada;
 *   - COMMIT sem resposta é resultado DESCONHECIDO (pode ter sido aplicado): quem chama trata como falha;
 *   - conexão que chega depois do prazo é descartada, não fica presa.
 * Não altera o pool nem as outras transações da aplicação.
 */
export type ConexaoDescartavel = {
  query: DbExecutor["query"];
  /** Estado conhecido (COMMIT ou ROLLBACK respondidos): devolve/fecha normalmente. */
  liberar: () => void;
  /** Estado incerto: destrói a conexão sem devolvê-la. */
  descartar: (motivo: Error) => void;
};

export class PrazoDaTransacaoVencido extends Error {
  readonly etapa: string;
  readonly prazoMs: number;
  constructor(etapa: string, prazoMs: number) {
    super(`Transação sem resposta em ${prazoMs} ms (${etapa}): conexão descartada; resultado desconhecido.`);
    this.name = "PrazoDaTransacaoVencido";
    this.etapa = etapa;
    this.prazoMs = prazoMs;
  }
}

export type TransacaoComPrazo = <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;

const nomeDaEtapa = (sql: string) => sql.trim().split(/\s+/, 1)[0]?.toUpperCase() || "CONSULTA";

export function transacaoComPrazo(abrir: () => Promise<ConexaoDescartavel>, prazoMs: number): TransacaoComPrazo {
  return async <T>(trabalho: (tx: DbExecutor) => Promise<T>): Promise<T> => {
    let conexao: ConexaoDescartavel | null = null;
    let encerrada = false;
    let vencido: PrazoDaTransacaoVencido | null = null;
    let etapa = "OBTER_CONEXAO";
    let avisar: (erro: PrazoDaTransacaoVencido) => void = () => undefined;
    const prazo = new Promise<never>((_ok, falha) => { avisar = falha; });
    prazo.catch(() => undefined);
    const descartar = (motivo: Error) => {
      if (!conexao || encerrada) return;
      encerrada = true;
      try { conexao.descartar(motivo); } catch { /* já estava fechada */ }
    };
    const timer = setTimeout(() => {
      vencido = new PrazoDaTransacaoVencido(etapa, prazoMs);
      descartar(vencido);
      avisar(vencido);
    }, prazoMs);
    /** Espera no máximo até o prazo; a promessa abandonada nunca vira rejeição sem tratamento. */
    const ate = <R>(p: Promise<R>) => { p.catch(() => undefined); return Promise.race([p, prazo]); };
    try {
      const aberta = abrir();
      // Conexão que chega depois do prazo: descarta, não deixa presa.
      aberta.then((c) => { if (vencido) { try { c.descartar(vencido); } catch { /* ignorado */ } } }, () => undefined);
      conexao = await ate(aberta);
      if (vencido) throw vencido;
      const tx: DbExecutor = {
        query: (<Row extends object = Record<string, unknown>>(sql: string, valores: readonly unknown[] = []) => {
          if (vencido) return Promise.reject(vencido);
          if (encerrada) return Promise.reject(new Error("Transação já encerrada."));
          etapa = nomeDaEtapa(sql);
          return ate(conexao!.query<Row>(sql, valores)) as Promise<DbQueryResult<Row>>;
        }) as DbExecutor["query"],
      };
      await tx.query("BEGIN");
      const resultado = await trabalho(tx);
      await tx.query("COMMIT");
      encerrada = true;
      conexao.liberar();
      return resultado;
    }
    catch (erro) {
      if (!vencido && conexao && !encerrada) {
        // Falha conhecida no meio: ROLLBACK ainda dentro do prazo; sem resposta ou com erro → descarta.
        try {
          etapa = "ROLLBACK";
          await ate(conexao.query("ROLLBACK"));
          encerrada = true;
          conexao.liberar();
        }
        catch {
          descartar(erro instanceof Error ? erro : new Error(String(erro)));
        }
      }
      throw erro;
    }
    finally {
      clearTimeout(timer);
    }
  };
}

type ClientePg = {
  query: (texto: string, valores: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  /** Interno do `pg`: o soquete da conexão. Destruí-lo faz a resposta pendente falhar e fecha a conexão já. */
  connection?: { stream?: { destroy?: (erro?: Error) => void } };
};

/** Adapta um cliente `pg`. `fechar` decide o que liberar/descartar significa (pool: release; cliente avulso: end). */
export function conexaoDeClientePg(cliente: ClientePg, fechar: { liberar: () => void; descartar: (motivo: Error) => void }): ConexaoDescartavel {
  return {
    query: (async (texto: string, valores: readonly unknown[] = []) => {
      const r = await cliente.query(texto, [...valores]);
      return { rows: r.rows, rowCount: r.rowCount };
    }) as DbExecutor["query"],
    liberar: fechar.liberar,
    descartar: (motivo) => {
      try { cliente.connection?.stream?.destroy?.(); } catch { /* já destruído */ }
      fechar.descartar(motivo);
    },
  };
}

type PoolPg = { connect: () => Promise<ClientePg & { release: (erro?: Error | boolean) => void }> };

/** Conexão de um pool `pg`: liberar devolve; descartar destrói o soquete e remove do pool (`release(erro)`). */
export async function conexaoDescartavelDoPoolPg(pool: PoolPg): Promise<ConexaoDescartavel> {
  const cliente = await pool.connect();
  return conexaoDeClientePg(cliente, { liberar: () => cliente.release(), descartar: (motivo) => cliente.release(motivo) });
}
