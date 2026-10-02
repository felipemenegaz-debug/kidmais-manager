// Worker externo: destino e segredo exclusivos deste ambiente. Não imprime credenciais ou mensagens.
const base = process.env.WHATSAPP_ATENDIMENTO_WORKER_URL;
const secret = process.env.WHATSAPP_ATENDIMENTO_WORKER_SECRET;
if (!base || new URL(base).protocol !== 'https:' || !secret || secret.length < 32) throw new Error('Configure URL HTTPS e segredo do worker.');
let parar = false;
process.on('SIGTERM', () => { parar = true; });
process.on('SIGINT', () => { parar = true; });
while (!parar) {
  try {
    const r = await fetch(base, { method: 'POST', redirect: 'error', headers: { 'x-kidmais-worker-secret': secret }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) console.error('Atendimento: processador indisponível (%d).', r.status);
    // Lote interrompido pelo limite: ainda há fila, chama de novo sem esperar.
    else if ((await r.json().catch(() => null))?.estado === 'LIMITE') continue;
  } catch { console.error('Atendimento: falha de comunicação com processador.'); }
  if (!parar) await new Promise(resolve => setTimeout(resolve, 3000));
}
