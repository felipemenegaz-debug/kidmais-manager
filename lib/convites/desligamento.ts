// Geração sobrevive ao deploy (vault: "Convites geracao sobrevive ao deploy 20261120").
// No deploy, o Render manda SIGTERM à instância antiga. O `next start` saía na hora (process.exit) e cortava a chamada
// à IA aberta: a resposta se perdia e a geração virava INCERTA até um operador decidir. Com NEXT_MANUAL_SIG_HANDLE, o
// Next não instala o próprio handler e este módulo decide a saída: recusa gerações novas (antes de reservar crédito),
// espera as abertas neste processo e só então sai. O prazo cobre o timeout do provedor e a gravação da arte; se vencer,
// o comportamento antigo continua valendo (a reconciliação marca INCERTA), então nunca fica pior que antes.
import { LIMITE_PROVEDOR_SEGUNDOS } from './progresso-geracao.ts';

export const PRAZO_DESLIGAMENTO_MS = (LIMITE_PROVEDOR_SEGUNDOS + 10) * 1000;
// Depois que a última geração encerra no serviço, o Next ainda escreve a resposta HTTP. Sair na hora cortaria esse envio:
// a drenagem dá esse tempo. Prazo + drenagem (132 s) cabem na carência da Render planejada (150 s, fase 3).
export const DRENAGEM_RESPOSTA_MS = 2_000;
export const MENSAGEM_DESLIGANDO = 'O sistema está sendo atualizado. Tente gerar de novo em alguns instantes. Nenhum crédito foi usado.';

type Estado = { abertas: number; desligando: boolean; ouvintes: Set<() => void> };

// O Next empacota instrumentation e rotas separadamente; cada pacote teria a própria cópia do módulo. O estado fica no
// globalThis para o handler do sinal enxergar as gerações abertas pelas rotas.
const CHAVE = Symbol.for('kidmais.convites.desligamento');
function estado(): Estado {
  const g = globalThis as typeof globalThis & { [CHAVE]?: Estado };
  return (g[CHAVE] ??= { abertas: 0, desligando: false, ouvintes: new Set() });
}

/** Registra uma geração. Devolve a função que a encerra (idempotente), ou null se o processo está desligando. */
export function abrirGeracao(): (() => void) | null {
  const e = estado();
  if (e.desligando) return null;
  e.abertas++;
  let encerrada = false;
  return () => {
    if (encerrada) return;
    encerrada = true;
    e.abertas--;
    if (e.abertas === 0) for (const avisar of [...e.ouvintes]) avisar();
  };
}

/** "pid=… ppid=…" para o log: mostra no Render qual processo recebeu (ou não) o sinal na troca de instância. */
export function identificarProcesso(processo: { pid?: number; ppid?: number } = process) {
  return `pid=${processo.pid ?? '?'} ppid=${processo.ppid ?? '?'}`;
}

export function geracoesAbertas() { return estado().abertas; }
export function desligando() { return estado().desligando; }

/** Para de aceitar gerações e espera as abertas terminarem ou o prazo vencer. */
export function esperarGeracoes(prazoMs = PRAZO_DESLIGAMENTO_MS): Promise<{ resultado: 'vazio' | 'prazo'; abertas: number }> {
  const e = estado();
  e.desligando = true;
  if (e.abertas === 0) return Promise.resolve({ resultado: 'vazio', abertas: 0 });
  return new Promise(resolve => {
    const fim = (resultado: 'vazio' | 'prazo') => { clearTimeout(relogio); e.ouvintes.delete(avisar); resolve({ resultado, abertas: e.abertas }); };
    const avisar = () => fim('vazio');
    const relogio = setTimeout(() => fim('prazo'), prazoMs);
    e.ouvintes.add(avisar);
  });
}

type Processo = Pick<NodeJS.Process, 'on' | 'exit'> & { pid?: number; ppid?: number };
const CODIGO_SAIDA = { SIGTERM: 143, SIGINT: 130 } as const;

/**
 * Instala o desligamento que espera as gerações. Só com NEXT_MANUAL_SIG_HANDLE: sem ela, o handler do Next também roda
 * e sai na hora; com ela e sem este handler, o processo ignoraria o SIGTERM até o SIGKILL. Os dois andam juntos.
 */
export function instalarDesligamento(env: Record<string, string | undefined> = process.env, processo: Processo = process,
  prazoMs = PRAZO_DESLIGAMENTO_MS, log: (linha: string) => void = l => console.info(l), drenagemMs = DRENAGEM_RESPOSTA_MS) {
  if (!env.NEXT_MANUAL_SIG_HANDLE) return false;
  let saindo = false;
  for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
    // `on`, não `once`: um segundo sinal durante a espera não pode cair no padrão do Node (sair na hora) nem ficar
    // sem ouvinte; a flag garante uma saída só.
    processo.on(sinal, () => {
      if (saindo) { log(`[convites] ${sinal} repetido; a espera continua.`); return; }
      saindo = true;
      log(`[convites] ${sinal} recebido (${identificarProcesso(processo)}): recusando gerações novas; ${geracoesAbertas()} em curso.`);
      void esperarGeracoes(prazoMs).then(r => {
        if (r.resultado === 'prazo') {
          log(`[convites] Prazo de ${Math.round(prazoMs / 1000)} s vencido com ${r.abertas} geração(ões) aberta(s); encerrando.`);
          processo.exit(CODIGO_SAIDA[sinal]);
          return;
        }
        log(`[convites] Gerações em curso terminaram; encerrando em ${Math.round(drenagemMs / 1000)} s (envio das respostas).`);
        setTimeout(() => processo.exit(CODIGO_SAIDA[sinal]), drenagemMs);
      });
    });
  }
  return true;
}
