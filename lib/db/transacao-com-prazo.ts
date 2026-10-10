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
 *   - a conexão é registrada assim que existe (antes de conectar e de conferir o banco): o prazo a descarta em qualquer
 *     ponto da abertura; conexão que chega depois do prazo também é descartada; cada conexão fecha uma só vez.
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

/**
 * Abre a conexão. `registrar` deve ser chamado ASSIM QUE a conexão existir (antes de conectar ou de qualquer conferência
 * que possa ficar sem resposta): a partir daí o prazo consegue descartá-la mesmo que a abertura nunca termine.
 * Registrar depois do prazo descarta na hora. Quem não registra é coberto quando a abertura resolve (descartada se tarde).
 */
export type AbrirConexao = (registrar: (conexao: ConexaoDescartavel) => void) => Promise<ConexaoDescartavel>;

const nomeDaEtapa = (sql: string) => sql.trim().split(/\s+/, 1)[0]?.toUpperCase() || "CONSULTA";

export function transacaoComPrazo(abrir: AbrirConexao, prazoMs: number): TransacaoComPrazo {
  return async <T>(trabalho: (tx: DbExecutor) => Promise<T>): Promise<T> => {
    let conexao: ConexaoDescartavel | null = null;
    let aberturaConcluida = false;
    let vencido: PrazoDaTransacaoVencido | null = null;
    let etapa = "OBTER_CONEXAO";
    let avisar: (erro: PrazoDaTransacaoVencido) => void = () => undefined;
    const prazo = new Promise<never>((_ok, falha) => { avisar = falha; });
    prazo.catch(() => undefined);
    /** Conexões conhecidas desta transação (registradas na abertura ou entregues por ela); cada uma fecha uma só vez. */
    const conhecidas = new Set<ConexaoDescartavel>();
    const fechadas = new Set<ConexaoDescartavel>();
    const descartarUma = (c: ConexaoDescartavel, motivo: Error) => {
      if (fechadas.has(c)) return;
      fechadas.add(c);
      try { c.descartar(motivo); } catch { /* já estava fechada */ }
    };
    const liberarUma = (c: ConexaoDescartavel) => {
      if (fechadas.has(c)) return;
      fechadas.add(c);
      c.liberar();
    };
    const descartarTodas = (motivo: Error) => { for (const c of conhecidas) descartarUma(c, motivo); };
    const registrar = (c: ConexaoDescartavel) => {
      conhecidas.add(c);
      if (vencido) descartarUma(c, vencido);
    };
    const timer = setTimeout(() => {
      vencido = new PrazoDaTransacaoVencido(etapa, prazoMs);
      descartarTodas(vencido);
      avisar(vencido);
    }, prazoMs);
    /** Espera no máximo até o prazo; a promessa abandonada nunca vira rejeição sem tratamento. */
    const ate = <R>(p: Promise<R>) => { p.catch(() => undefined); return Promise.race([p, prazo]); };
    try {
      const aberta = abrir(registrar);
      // Conexão entregue depois do prazo (ou não registrada a tempo): descarta, não deixa presa.
      aberta.then((c) => registrar(c), () => undefined);
      conexao = await ate(aberta);
      registrar(conexao);
      if (vencido) throw vencido;
      aberturaConcluida = true;
      const tx: DbExecutor = {
        query: (<Row extends object = Record<string, unknown>>(sql: string, valores: readonly unknown[] = []) => {
          if (vencido) return Promise.reject(vencido);
          if (fechadas.has(conexao!)) return Promise.reject(new Error("Transação já encerrada."));
          etapa = nomeDaEtapa(sql);
          return ate(conexao!.query<Row>(sql, valores)) as Promise<DbQueryResult<Row>>;
        }) as DbExecutor["query"],
      };
      await tx.query("BEGIN");
      const resultado = await trabalho(tx);
      await tx.query("COMMIT");
      liberarUma(conexao);
      return resultado;
    }
    catch (erro) {
      const motivo = erro instanceof Error ? erro : new Error(String(erro));
      if (!aberturaConcluida) {
        // Abertura falhou ou não terminou (conferência sem resposta, banco recusado): nada de negócio foi enviado; descarta.
        descartarTodas(motivo);
      }
      else if (!vencido && conexao && !fechadas.has(conexao)) {
        // Falha conhecida no meio: ROLLBACK ainda dentro do prazo; sem resposta ou com erro → descarta.
        try {
          etapa = "ROLLBACK";
          await ate(conexao.query("ROLLBACK"));
          liberarUma(conexao);
        }
        catch {
          descartarUma(conexao, motivo);
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
  let fechada = false;
  return {
    query: (async (texto: string, valores: readonly unknown[] = []) => {
      const r = await cliente.query(texto, [...valores]);
      return { rows: r.rows, rowCount: r.rowCount };
    }) as DbExecutor["query"],
    // Idempotentes: a conexão fecha uma só vez, mesmo se dois caminhos (prazo e abertura recusada) tentarem.
    liberar: () => {
      if (fechada) return;
      fechada = true;
      fechar.liberar();
    },
    descartar: (motivo) => {
      if (fechada) return;
      fechada = true;
      try { cliente.connection?.stream?.destroy?.(); } catch { /* já destruído */ }
      fechar.descartar(motivo);
    },
  };
}

type PoolPg = { connect: () => Promise<ClientePg & { release: (erro?: Error | boolean) => void }> };

/** Conexão de um pool `pg`: liberar devolve; descartar destrói o soquete e remove do pool (`release(erro)`). */
export async function conexaoDescartavelDoPoolPg(pool: PoolPg, registrar?: (conexao: ConexaoDescartavel) => void): Promise<ConexaoDescartavel> {
  // pool.connect tem o próprio tempo-limite de obtenção; entregue tarde, é descartada por transacaoComPrazo.
  const cliente = await pool.connect();
  const conexao = conexaoDeClientePg(cliente, { liberar: () => cliente.release(), descartar: (motivo) => cliente.release(motivo) });
  registrar?.(conexao);
  return conexao;
}
