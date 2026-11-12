/**
 * B-14 (revisões do HB-3 r4 e r5, P3): diagnóstico OPCIONAL (KIDMAIS_DIAGNOSTICO_PG=1) do statement timeout
 * intermitente do cluster descartável. Na consulta cancelada por timeout (SQLSTATE 57014), registra o SQL e, por uma
 * segunda conexão curta, as sessões e as travas NÃO concedidas. A fotografia é posterior ao cancelamento: ajuda a
 * descartar trava pendente, mas não determina sozinha a causa.
 *
 * Módulo puro (sem driver), para o teste simular um cliente que trava. Garantias:
 *   - a coleta tem prazo total (`prazoMs`) e o encerramento da segunda conexão outro (`encerrarMs`); esgotado o
 *     encerramento, a conexão é destruída;
 *   - o erro ORIGINAL é sempre relançado, no máximo `prazoMs + encerrarMs` depois, com ou sem fotografia (orçamento de
 *     espera, não limite absoluto sob event loop bloqueado);
 *   - o evento `error` da segunda conexão é tratado antes do connect e durante toda a vida dela (inclusive depois do
 *     encerramento): no `pg`, uma queda do socket emite `error` além de rejeitar a consulta, e sem ouvinte viraria
 *     exceção fora dos try/catch (revisão do HB-3 r5, P3).
 */
export type ClienteDiagnostico = {
  connect(): Promise<unknown>;
  query(sql: string): Promise<{ rows: unknown[] }>;
  end(): Promise<unknown>;
  on(evento: "error", ouvinte: (erro: Error) => void): unknown;
};
export type AbrirDiagnostico = () => { cliente: ClienteDiagnostico; destruir?: () => void };
export type OpcoesDiagnostico = { prazoMs?: number; encerrarMs?: number; registrar?: (rotulo: string, detalhe: string) => void };

export const PRAZO_DIAGNOSTICO_MS = 5000;
export const ENCERRAR_DIAGNOSTICO_MS = 1000;
const ESGOTADO = Symbol("esgotado");

const SQL_SESSOES =
  "SELECT pid, application_name AS app, state, wait_event_type AS tipo, wait_event AS evento, (now() - xact_start)::text AS em_transacao, " +
  "(now() - query_start)::text AS na_consulta, left(query, 160) AS consulta FROM pg_stat_activity " +
  "WHERE datname = current_database() AND pid <> pg_backend_pid() ORDER BY xact_start NULLS LAST";
const SQL_TRAVAS = "SELECT pid, locktype, mode, relation::regclass::text AS relacao FROM pg_locks WHERE NOT granted";

function comPrazo<T>(promessa: Promise<T>, ms: number): Promise<T | typeof ESGOTADO> {
  return new Promise((resolver, rejeitar) => {
    // HB-5 (Node 22.23.2): o relógio NÃO é unref. Ele mantém o event loop vivo até o fim da espera limitada; com unref,
    // uma conexão travada sem handle próprio deixava o loop esvaziar antes de o erro original ser relançado.
    const relogio = setTimeout(() => resolver(ESGOTADO), ms);
    promessa.then(
      (valor) => {
        clearTimeout(relogio);
        resolver(valor);
      },
      (erro) => {
        clearTimeout(relogio);
        rejeitar(erro);
      },
    );
  });
}

async function fotografar(sql: string, abrir: AbrirDiagnostico, prazoMs: number, encerrarMs: number, registrar: (r: string, d: string) => void) {
  let aberto: ReturnType<AbrirDiagnostico> | undefined;
  try {
    aberto = abrir();
    const cliente = aberto.cliente;
    // Nunca removido: cobre a coleta, o encerramento e o que o socket emitir depois.
    cliente.on("error", (erro) => registrar("DIAGNOSTICO_PG_CONEXAO_ERRO", String(erro?.message ?? erro).slice(0, 200)));
    const coleta = await comPrazo(
      (async () => {
        await cliente.connect();
        const sessoes = (await cliente.query(SQL_SESSOES)).rows;
        const travas = (await cliente.query(SQL_TRAVAS)).rows;
        return { sessoes, travas };
      })(),
      prazoMs,
    );
    if (coleta === ESGOTADO) registrar("DIAGNOSTICO_PG_TIMEOUT_SEM_FOTOGRAFIA", `prazo de ${prazoMs} ms esgotado; sql: ${sql.slice(0, 300)}`);
    else registrar("DIAGNOSTICO_PG_TIMEOUT", JSON.stringify({ sql: sql.slice(0, 300), ...coleta }));
  } catch (falha) {
    registrar("DIAGNOSTICO_PG_TIMEOUT_SEM_FOTOGRAFIA", String((falha as Error)?.message ?? falha).slice(0, 200));
  } finally {
    if (aberto) {
      const cliente = aberto.cliente;
      const fim = await comPrazo(Promise.resolve().then(() => cliente.end()), encerrarMs).catch(() => undefined);
      if (fim === ESGOTADO) {
        try {
          aberto.destruir?.();
        } catch {
          /* a conexão já caiu */
        }
        registrar("DIAGNOSTICO_PG_ENCERRAMENTO_ESGOTADO", `${encerrarMs} ms; conexão destruída`);
      }
    }
  }
}

/** Envolve `client.query`: nada muda fora do 57014; no 57014, fotografa com prazo e relança o erro original. */
export function instrumentarTimeout(client: object, abrir: AbrirDiagnostico, opcoes: OpcoesDiagnostico = {}) {
  const prazoMs = opcoes.prazoMs ?? PRAZO_DIAGNOSTICO_MS;
  const encerrarMs = opcoes.encerrarMs ?? ENCERRAR_DIAGNOSTICO_MS;
  const registrar = opcoes.registrar ?? ((rotulo: string, detalhe: string) => console.error(rotulo, detalhe));
  const alvo = client as { query: (...args: unknown[]) => Promise<unknown> };
  const original = alvo.query.bind(client);
  alvo.query = async (...args: unknown[]) => {
    try {
      return await original(...args);
    } catch (error) {
      if ((error as { code?: string })?.code === "57014") {
        try {
          const sql = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string })?.text ?? "");
          await fotografar(sql, abrir, prazoMs, encerrarMs, registrar);
        } catch {
          /* o diagnóstico nunca substitui o erro original */
        }
      }
      throw error;
    }
  };
}
