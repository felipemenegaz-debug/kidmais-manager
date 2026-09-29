import { Worker, type WorkerOptions } from "node:worker_threads";
import { LIMITES, type OpcoesExtracao, type TextoPdf } from "./pdf-texto.ts";

/**
 * Extração de PDF em Worker isolado (B1): o parser roda fora do event loop do servidor, com teto de
 * memória. O prazo e o cancelamento do fluxo real (`AbortSignal` do pedido) encerram o Worker à força
 * (`terminate`), mesmo que o parser não chegue a conferir o relógio — o processo principal nunca fica
 * bloqueado pelo documento. No build de produção o bundler compila `pdf-worker.ts` num chunk próprio.
 */
export const FOLGA_PRAZO_MS = 1_000;
export const MEMORIA_WORKER_MB = 256;

type Opcoes = Pick<OpcoesExtracao, "limiteTrabalho" | "prazoMs" | "sinal">;

/** Executa um Worker de extração com prazo duro e cancelamento. Exportado para testar o `terminate`. */
export function rodarEmWorker(criar: (opcoes: WorkerOptions) => Worker, bytes: Uint8Array, opcoes: Opcoes = {}): Promise<TextoPdf> {
  const prazoMs = opcoes.prazoMs ?? LIMITES.prazoPadraoMs;
  const interrompido = (motivo: "PRAZO" | "CANCELADO"): TextoPdf => ({ paginas: [], avisos: [motivo, "WORKER_ENCERRADO"], interrompido: motivo });
  if (opcoes.sinal?.aborted) return Promise.resolve(interrompido("CANCELADO"));
  return new Promise((resolve) => {
    let terminou = false;
    const worker = criar({
      workerData: { bytes, opcoes: { limiteTrabalho: opcoes.limiteTrabalho, prazoMs } },
      resourceLimits: { maxOldGenerationSizeMb: MEMORIA_WORKER_MB },
    });
    const encerrar = (resultado: TextoPdf, matar: boolean) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(timer);
      opcoes.sinal?.removeEventListener("abort", aoCancelar);
      if (matar) void worker.terminate();
      resolve(resultado);
    };
    const aoCancelar = () => encerrar(interrompido("CANCELADO"), true);
    const timer = setTimeout(() => encerrar(interrompido("PRAZO"), true), prazoMs + FOLGA_PRAZO_MS);
    opcoes.sinal?.addEventListener("abort", aoCancelar, { once: true });
    worker.once("message", (r: TextoPdf) => encerrar(r, true));
    worker.once("error", () => encerrar({ paginas: [], avisos: ["PDF_INVALIDO", "WORKER_FALHOU"], interrompido: null }, true));
    worker.once("exit", () => encerrar({ paginas: [], avisos: ["WORKER_FALHOU"], interrompido: null }, false));
  });
}

export function extrairTextoPdfIsolado(bytes: Uint8Array, opcoes: Opcoes = {}): Promise<TextoPdf> {
  // O literal `new Worker(new URL(...), ...)` é o que o bundler reconhece para gerar o chunk do Worker.
  return rodarEmWorker((o) => new Worker(new URL("./pdf-worker.ts", import.meta.url), o), bytes, opcoes);
}
