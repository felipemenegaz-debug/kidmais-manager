// Processador LOCAL das automações de Marketing: chama o ciclo do próprio app (planejar → reservar → processar).
// Goal local de 14/10/2026: só aceita destino em localhost/127.0.0.1 (nunca staging/produção) e transporte simulado
// (o app recusa qualquer outro). O estado vive no banco; o worker não guarda nada e pode ser parado/duplicado
// (reserva com SKIP LOCKED e posse com prazo). Não imprime segredo, telefone nem mensagem.
//
// Uso: MARKETING_AUTOMACOES_WORKER_URL=http://127.0.0.1:3000/api/integracoes/marketing/automacoes/processar \
//      MARKETING_AUTOMACOES_WORKER_SECRET=<32+ caracteres> node scripts/marketing-automacoes-worker.mjs [--uma-vez]
import { pathToFileURL } from 'node:url';

const CAMINHO = '/api/integracoes/marketing/automacoes/processar';
const ESPERA_MS = 60000;

export function configuracaoWorker(env) {
  let url;
  try { url = new URL(env.MARKETING_AUTOMACOES_WORKER_URL ?? ''); } catch { url = null; }
  const local = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!url || !local || !['http:', 'https:'].includes(url.protocol) || url.pathname !== CAMINHO || url.search || url.username || url.password) {
    throw new Error('Configure MARKETING_AUTOMACOES_WORKER_URL com o processador LOCAL (localhost/127.0.0.1) deste app.');
  }
  const secret = env.MARKETING_AUTOMACOES_WORKER_SECRET;
  if (!secret || !/^[\x21-\x7e]{32,256}$/.test(secret)) throw new Error('Configure MARKETING_AUTOMACOES_WORKER_SECRET (32 a 256 caracteres, sem espaços).');
  return { url: url.href, secret };
}

export async function ciclo({ url, secret }, buscar, log) {
  try {
    const r = await buscar(url, { method: 'POST', redirect: 'error', headers: { 'x-kidmais-worker-secret': secret }, signal: AbortSignal.timeout(120000) });
    const corpo = await r.json().catch(() => null);
    if (!r.ok) { log(`Marketing: processador recusou (${r.status}${corpo?.codigo ? ` ${corpo.codigo}` : ''}).`); return { ok: false }; }
    const d = corpo?.data ?? {};
    log(`Marketing: ${d.planejamento?.criadas ?? 0} agendada(s), ${d.processadas ?? 0} processada(s) ${JSON.stringify(d.resultados ?? {})}.`);
    return { ok: true, data: d };
  } catch {
    log('Marketing: processador inacessível.');
    return { ok: false };
  }
}

async function principal() {
  const cfg = configuracaoWorker(process.env);
  const umaVez = process.argv.includes('--uma-vez');
  const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
  do {
    await ciclo(cfg, fetch, log);
    if (!umaVez) await new Promise((r) => setTimeout(r, ESPERA_MS));
  } while (!umaVez);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) principal().catch((e) => { console.error(e instanceof Error ? e.message : 'Falha.'); process.exit(1); });
