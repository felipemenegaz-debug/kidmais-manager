import { appendFileSync } from "node:fs";

/**
 * Limpeza da conexão descartável com a falha VISÍVEL (parecer do Astra sobre o ROLLBACK cancelado na creditos-095, 08/11/2026).
 *
 * Antes, `encerrarDescartavel` engolia qualquer erro do ROLLBACK e do unlock (`catch {}`), inclusive o 57014: o cancelamento
 * ficava fora do resultado da suíte. Agora cada falha é registrada (fase e SQLSTATE) no stderr e, quando o executor informa
 * `KIDMAIS_LIMPEZA_REGISTRO`, num JSONL que ele resume no fim. Nada é relançado: o unlock e o fechamento sempre acontecem,
 * a falha original do teste é preservada e a suíte não passa a reprovar pela limpeza (decisão posterior, após validação).
 *
 * O ROLLBACK sem transação aberta só gera o aviso "there is no transaction in progress", que não rejeita a consulta:
 * toda rejeição aqui é uma falha real.
 *
 * Módulo sem driver, para o teste simular um cliente que falha.
 */
export type ClienteEncerravel = {
  query(sql: string, valores?: unknown[]): Promise<unknown>;
  end(): Promise<unknown>;
};
export type FaseLimpeza = "rollback" | "unlock";
export type FalhaLimpeza = { fase: FaseLimpeza; sqlstate: string | null; mensagem: string };
export type RegistrarFalhaLimpeza = (falha: FalhaLimpeza) => void;

export const ROTULO_FALHA_LIMPEZA = "LIMPEZA_DESCARTAVEL_FALHOU";

export function descreverFalha(fase: FaseLimpeza, erro: unknown): FalhaLimpeza {
  const e = erro as { code?: unknown; message?: unknown } | null | undefined;
  const sqlstate = typeof e?.code === "string" ? e.code : null;
  const mensagem = String(e?.message ?? erro).slice(0, 200);
  return { fase, sqlstate, mensagem };
}

/** Registro padrão: linha no stderr e, se houver, JSONL do executor. Nunca lança. */
export function registrarFalhaPadrao(falha: FalhaLimpeza, destino = process.env.KIDMAIS_LIMPEZA_REGISTRO) {
  try {
    console.error(ROTULO_FALHA_LIMPEZA, JSON.stringify(falha));
  } catch {
    /* stderr indisponível */
  }
  if (!destino) return;
  try {
    appendFileSync(destino, `${JSON.stringify({ iso: new Date().toISOString(), ...falha })}\n`);
  } catch {
    /* registro indisponível: a linha no stderr permanece */
  }
}

function registrarSemLancar(registrar: RegistrarFalhaLimpeza, fase: FaseLimpeza, erro: unknown) {
  try {
    registrar(descreverFalha(fase, erro));
  } catch {
    /* o registro nunca impede o unlock nem o fechamento */
  }
}

/**
 * ROLLBACK → (unlock da trava, se houver) → end. Falhas do ROLLBACK e do unlock são registradas e não interrompem os
 * passos seguintes. O `end()` mantém o comportamento anterior: uma falha nele continua chegando ao chamador.
 */
export async function encerrarRegistrando(client: ClienteEncerravel, trava: number | null, registrar: RegistrarFalhaLimpeza = registrarFalhaPadrao) {
  try {
    await client.query("ROLLBACK");
  } catch (erro) {
    registrarSemLancar(registrar, "rollback", erro);
  }
  if (trava !== null) {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [trava]);
    } catch (erro) {
      registrarSemLancar(registrar, "unlock", erro);
    }
  }
  await client.end();
}
