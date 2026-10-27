/**
 * Leitura LIMITADA do corpo de um pedido HTTP, comum às bordas do canal (token OAuth e /api/mcp).
 * - teto de bytes conferido no content-length declarado e DURANTE a leitura (nunca `text()` inteiro antes de medir);
 * - prazo TOTAL (não por bloco); vencido ou acima do teto, o fluxo é cancelado SEM esperar o cancelamento terminar;
 * - erro do fluxo (aborto do cliente, conexão caída) vira recusa `ERRO`, nunca exceção para quem chama.
 * Concorrência (quantas leituras ao mesmo tempo) é decidida por quem chama, antes de começar a ler.
 */
import { Vagas } from "./admissao.ts";

export type LeituraCorpo = { ok: true; texto: string } | { ok: false; motivo: "GRANDE" | "PRAZO" | "ERRO" };

export async function lerCorpoLimitado(request: Request, max: number, prazoMs: number): Promise<LeituraCorpo> {
  const declarado = request.headers.get("content-length");
  if (declarado !== null && (!/^\d+$/.test(declarado) || Number(declarado) > max)) return { ok: false, motivo: "GRANDE" };
  if (!request.body) return { ok: true, texto: "" };
  let leitor: ReadableStreamDefaultReader<Uint8Array>;
  try {
    leitor = request.body.getReader();
  } catch {
    return { ok: false, motivo: "ERRO" };
  }
  const abandonar = () => void leitor.cancel().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<"PRAZO">((ok) => { timer = setTimeout(() => ok("PRAZO"), prazoMs); });
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const r = await Promise.race([leitor.read(), prazo]);
      if (r === "PRAZO") {
        abandonar();
        return { ok: false, motivo: "PRAZO" };
      }
      if (r.done) break;
      total += r.value.byteLength;
      if (total > max) {
        abandonar();
        return { ok: false, motivo: "GRANDE" };
      }
      partes.push(r.value);
    }
  } catch {
    abandonar();
    return { ok: false, motivo: "ERRO" };
  } finally {
    clearTimeout(timer);
  }
  return { ok: true, texto: Buffer.concat(partes).toString("utf8") };
}

/** Teto de leituras simultâneas por instância (o prazo garante que cada vaga volta). */
export class LeiturasSimultaneas extends Vagas {}

/**
 * JSON de rota administrativa do canal com teto de bytes e prazo (rodada 4, achado 5): nunca `request.json()` sem limite.
 * Recusa devolve o status HTTP sugerido; o conteúdo do erro nunca sai.
 */
export async function lerJsonLimitado(request: Request, max: number, prazoMs: number): Promise<{ ok: true; valor: unknown } | { ok: false; status: number }> {
  const lido = await lerCorpoLimitado(request, max, prazoMs);
  if (!lido.ok) return { ok: false, status: lido.motivo === "GRANDE" ? 413 : lido.motivo === "PRAZO" ? 408 : 400 };
  try {
    return { ok: true, valor: JSON.parse(lido.texto) };
  } catch {
    return { ok: false, status: 400 };
  }
}
