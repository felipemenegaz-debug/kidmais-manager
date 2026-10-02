// Worker externo do atendimento WhatsApp: chama o processador do PRÓPRIO ambiente em laço.
// Destino e segredo exclusivos deste ambiente. Não imprime credenciais, telefones nem mensagens.
//
// Durabilidade: o estado vive na fila do banco. O worker não guarda nada; pode ser parado, reiniciado ou
// duplicado (a reserva usa SKIP LOCKED e uma tarefa ativa por conversa). Tarefa interrompida por mais de
// 10 minutos vai para a equipe e nunca é reenviada (recuperarTrabalhosInterrompidos).
import { pathToFileURL } from 'node:url';

const CAMINHO = '/api/integracoes/gupshup/atendimento/processar';
const ESPERA_MS = 3000, ESPERA_MAX_MS = 60000, RESUMO_MS = 10 * 60000;

/** Mesmas regras do processador: URL HTTPS completa do processador e segredo de 32 a 256 caracteres imprimíveis. */
export function configuracaoWorker(env) {
  const base = env.WHATSAPP_ATENDIMENTO_WORKER_URL, secret = env.WHATSAPP_ATENDIMENTO_WORKER_SECRET;
  let url;
  try { url = new URL(base ?? ''); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || url.pathname !== CAMINHO || url.search || url.username || url.password) throw new Error('Configure WHATSAPP_ATENDIMENTO_WORKER_URL com a URL HTTPS completa do processador deste ambiente.');
  if (!secret || !/^[\x21-\x7e]{32,256}$/.test(secret)) throw new Error('Configure WHATSAPP_ATENDIMENTO_WORKER_SECRET (32 a 256 caracteres, sem espaços).');
  return { url: url.href, secret };
}

/** Espera crescente depois de falhas seguidas (3 s, 6 s, 12 s ... até 60 s); volta a 3 s no primeiro sucesso. */
export function esperaAposFalhas(falhas) { return Math.min(ESPERA_MS * 2 ** Math.max(0, falhas - 1), ESPERA_MAX_MS); }

/**
 * Uma volta do laço. Devolve quanto esperar antes da próxima chamada e o novo contador de falhas.
 * Lote interrompido pelo limite (estado LIMITE): ainda há fila, chama de novo sem esperar.
 */
export async function ciclo({ url, secret }, buscar, falhas, log) {
  try {
    const r = await buscar(url, { method: 'POST', redirect: 'error', headers: { 'x-kidmais-worker-secret': secret }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      // 401/403: segredo ou transporte não aceitos — configuração, não instabilidade.
      log(r.status === 401 || r.status === 403 ? `Atendimento: processador recusou o worker (${r.status}); confira URL e segredo deste ambiente.` : `Atendimento: processador indisponível (${r.status}).`);
      return { espera: esperaAposFalhas(falhas + 1), falhas: falhas + 1, tarefas: 0 };
    }
    const corpo = await r.json().catch(() => null);
    const tarefas = Number.isSafeInteger(corpo?.tarefas) ? corpo.tarefas : 0;
    return { espera: corpo?.estado === 'LIMITE' ? 0 : ESPERA_MS, falhas: 0, tarefas, estado: typeof corpo?.estado === 'string' ? corpo.estado : 'DESCONHECIDO' };
  } catch {
    log('Atendimento: falha de comunicação com o processador.');
    return { espera: esperaAposFalhas(falhas + 1), falhas: falhas + 1, tarefas: 0 };
  }
}

export async function executar({ env = process.env, buscar = fetch, log = m => console.error(m), info = m => console.info(m), sinal = new AbortController().signal, agora = Date.now } = {}) {
  const config = configuracaoWorker(env);
  const dormir = ms => new Promise(resolve => { if (!ms || sinal.aborted) return resolve(); const t = setTimeout(resolve, ms); sinal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });
  let falhas = 0, tarefas = 0, ultimoResumo = agora(), ultimoEstado = '';
  info('Atendimento: worker iniciado.');
  while (!sinal.aborted) {
    const r = await ciclo(config, buscar, falhas, log);
    falhas = r.falhas; tarefas += r.tarefas;
    // Só mudança de estado (ex.: DESLIGADO → SEM_TAREFA) e um resumo a cada 10 min: sem ruído no log.
    if (r.estado && r.estado !== ultimoEstado) { info(`Atendimento: processador ${r.estado}.`); ultimoEstado = r.estado; }
    if (agora() - ultimoResumo >= RESUMO_MS) { info(`Atendimento: ${tarefas} tarefa(s) nos últimos 10 min.`); tarefas = 0; ultimoResumo = agora(); }
    await dormir(r.espera);
  }
  info('Atendimento: worker encerrado.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controle = new AbortController();
  process.on('SIGTERM', () => controle.abort());
  process.on('SIGINT', () => controle.abort());
  try { await executar({ sinal: controle.signal }); }
  catch (erro) { console.error(erro instanceof Error ? erro.message : 'Atendimento: falha ao iniciar o worker.'); process.exitCode = 1; }
}
