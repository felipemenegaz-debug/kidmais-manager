// Disparo da rotina de retenção do atendimento WhatsApp (D2, 12/10/2026): uma chamada à rota protegida do PRÓPRIO
// ambiente, para um agendador externo (cron). Independente das chaves do canal e da IA. Não imprime credenciais,
// telefones nem mensagens: só o estado e as contagens devolvidos pela rota. Sai com código 1 em qualquer falha.
import { pathToFileURL } from 'node:url';

const CAMINHO = '/api/integracoes/gupshup/atendimento/retencao';

/** URL HTTPS completa da rota de retenção e o segredo próprio da retenção (32 a 256 caracteres imprimíveis). */
export function configuracaoRetencao(env) {
  const base = env.WHATSAPP_ATENDIMENTO_RETENCAO_URL, secret = env.WHATSAPP_ATENDIMENTO_RETENCAO_SECRET;
  let url;
  try { url = new URL(base ?? ''); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || url.pathname !== CAMINHO || url.search || url.username || url.password) throw new Error(`Configure WHATSAPP_ATENDIMENTO_RETENCAO_URL com a URL HTTPS completa de ${CAMINHO}.`);
  if (!secret || !/^[\x21-\x7e]{32,256}$/.test(secret)) throw new Error('Configure WHATSAPP_ATENDIMENTO_RETENCAO_SECRET (32 a 256 caracteres, sem espaços).');
  return { url: url.href, secret };
}

/** Uma execução: devolve o resumo (estado e contagens) ou lança com uma mensagem sem dados. */
export async function executarUmaVez({ env = process.env, buscar = fetch } = {}) {
  const { url, secret } = configuracaoRetencao(env);
  const r = await buscar(url, { method: 'POST', redirect: 'error', headers: { 'x-kidmais-worker-secret': secret }, signal: AbortSignal.timeout(120000) });
  if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(`Retenção: rota recusou ou falhou (${r.status}).`); }
  const c = await r.json().catch(() => null);
  const numero = (v) => (Number.isSafeInteger(v) ? v : 0);
  return { estado: typeof c?.estado === 'string' ? c.estado : 'DESCONHECIDO', empresas: numero(c?.empresas), excluidas: numero(c?.excluidas), adiadas: numero(c?.adiadas),
    falhas: numero(c?.falhas), recentes: numero(c?.recentes), pendentes: numero(c?.pendentes), dedup: numero(c?.dedup), erros: Array.isArray(c?.erros) ? c.erros.filter((x) => typeof x === 'string' && /^[A-Z0-9_]{1,80}$/.test(x)).slice(0, 20) : [] };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const r = await executarUmaVez();
    console.info(`Retenção: ${r.estado}; empresas ${r.empresas}, excluídas ${r.excluidas}, adiadas ${r.adiadas}, falhas ${r.falhas}, recentes ${r.recentes}, pendentes ${r.pendentes}, ids de deduplicação ${r.dedup}${r.erros.length ? `; erros ${r.erros.join(',')}` : ''}`);
    // EM_EXECUCAO: outra execução está em andamento (uma por vez); não é falha desta chamada.
    if (!['CONCLUIDA', 'SEM_082', 'EM_EXECUCAO'].includes(r.estado)) process.exitCode = 1;
  } catch (erro) { console.error(erro instanceof Error ? erro.message : 'Retenção: falha ao executar.'); process.exitCode = 1; }
}
