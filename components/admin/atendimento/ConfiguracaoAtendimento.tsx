'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { ConfiguracaoAtendimento as Configuracao } from '@/lib/whatsapp/atendimento/core';
import { bloqueioDoCodigo, type BloqueioAtendimento } from '@/lib/whatsapp/atendimento/acesso-tela';
import styles from './atendimento.module.css';

type Dados = { configuracao: Configuracao | null; automacaoDisponivel: boolean; podeConfigurar: boolean; wallE?: { disponivel: boolean } };
const nova = (): Configuracao => ({ ativo: false, nome: 'Kidmais', perguntas: [], limites: { respostasPor24h: 20 }, wallE: { ativo: false } });
/** Sem a 075 o Wall-e não existe neste ambiente: a chave não é gravada (o atendimento da fase B segue igual). */
function semWallE(c: Configuracao): Configuracao { const copia = { ...c }; delete copia.wallE; return copia; }

/**
 * Configuração das respostas automáticas (representante): atendimento ligado, Wall-e, limite por conversa e perguntas
 * frequentes com respostas aprovadas. Separada da conversa: nada aqui fica entre o histórico e a resposta.
 */
export default function ConfiguracaoAtendimento() {
  const [dados, setDados] = useState<Dados | null>(null), [config, setConfig] = useState<Configuracao | null>(null), [erro, setErro] = useState(''), [aviso, setAviso] = useState(''), [ocupado, setOcupado] = useState(false), [bloqueio, setBloqueio] = useState<BloqueioAtendimento | null>(null);
  const carregar = useCallback(async () => {
    try {
      const r = await adminFetch('/api/admin/atendimento'); const json = await r.json();
      const recusa = r.ok ? null : bloqueioDoCodigo(json?.codigo);
      if (recusa) { setDados(null); setBloqueio(recusa); return; }
      if (!r.ok || !json.ok) throw Error(json.erro || 'Não foi possível carregar a configuração.');
      setDados(json.data); setConfig(c => c ?? { ...nova(), ...(json.data.configuracao ?? {}) }); setErro(''); setBloqueio(null);
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível carregar a configuração.'); }
  }, []);
  useEffect(() => { const t = window.setTimeout(() => void carregar(), 0); return () => window.clearTimeout(t); }, [carregar]);
  async function salvar() {
    if (!config || ocupado) return; setOcupado(true); setErro(''); setAviso('');
    const enviar = dados?.wallE?.disponivel ? config : semWallE(config);
    try { const r = await adminFetch('/api/admin/atendimento', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ acao: 'configurar', configuracao: enviar }) }); const json = await r.json(); if (!r.ok || !json.ok) throw Error(json.erro || 'Confira os campos da configuração.'); setAviso('Configuração salva.'); await carregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : 'Falha ao salvar.'); } finally { setOcupado(false); }
  }
  return <main className={styles.pagina}>
    <header className={styles.topo}><div><h1>Configuração do atendimento</h1><p>Respostas automáticas, Wall-e e limites.</p></div><div className={styles.acoes}><Link href="/admin/atendimento">Voltar ao atendimento</Link><Link href="/admin/atendimento/biblioteca">Biblioteca</Link></div></header>
    {bloqueio && <section className={styles.bloqueio} role="alert" data-bloqueio={bloqueio.tipo}><h2>{bloqueio.titulo}</h2><p>{bloqueio.orientacao}</p></section>}
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {aviso && <p role="status" className={styles.aviso}>{aviso}</p>}
    {!dados && !erro && !bloqueio && <p aria-live="polite">Carregando configuração…</p>}
    {dados && !dados.podeConfigurar && <p>Só o representante autorizado altera a configuração do atendimento.</p>}
    {dados?.podeConfigurar && config && <form className={styles.painel} onSubmit={e => { e.preventDefault(); void salvar(); }} aria-busy={ocupado || undefined}>
      <label>Nome da empresa (como o Wall-e se apresenta)<input value={config.nome} required minLength={2} maxLength={100} onChange={e => setConfig({ ...config, nome: e.target.value })} /></label>
      <label className={styles.opcao}><input type="checkbox" disabled={!dados.automacaoDisponivel} checked={config.ativo} onChange={e => setConfig({ ...config, ativo: e.target.checked })} />Respostas automáticas ligadas</label>
      {!dados.automacaoDisponivel && <p>Só pode ser ligado depois da ativação no servidor deste ambiente.</p>}
      <fieldset><legend>Wall-e</legend>
        {dados.wallE?.disponivel ? <>
          <label className={styles.opcao}><input type="checkbox" checked={!!config.wallE?.ativo} onChange={e => setConfig({ ...config, wallE: { ativo: e.target.checked } })} />Wall-e responde com as fontes oficiais</label>
          <p className={styles.nota}>Com o Wall-e ligado, as respostas usam a agenda, os pacotes, os preços da tabela publicada, o buffet, o modelo de contrato e só o material da biblioteca publicado com envio automático autorizado. Ele nunca reserva data, dá desconto ou informa contrato particular: nesses casos passa para a equipe.</p>
        </> : <p>O Wall-e fica disponível depois da atualização deste ambiente (migration 075). Até lá vale o atendimento com as respostas aprovadas abaixo.</p>}
      </fieldset>
      <label>Respostas automáticas por conversa em 24 horas<input type="number" inputMode="numeric" required min={1} max={100} value={config.limites.respostasPor24h} onChange={e => setConfig({ ...config, limites: { respostasPor24h: Number(e.target.value) } })} aria-describedby="limite-ajuda" /></label>
      <p id="limite-ajuda">Ao atingir o limite, a conversa vai para a equipe com uma mensagem fixa de encaminhamento. O custo máximo da IA é definido no servidor.</p>
      <h2>Perguntas frequentes</h2>
      <p>Publique só respostas aprovadas. Elas são usadas como estão; nada de preço, desconto, disponibilidade ou condição é criado.</p>
      {config.perguntas.map((p, index) => <fieldset key={p.id}><legend>Resposta {index + 1}</legend><label>Pergunta<input value={p.pergunta} required minLength={3} maxLength={250} onChange={e => setConfig({ ...config, perguntas: config.perguntas.map((x, i) => i === index ? { ...x, pergunta: e.target.value } : x) })} /></label><label>Resposta aprovada<textarea value={p.resposta} required minLength={3} maxLength={1500} onChange={e => setConfig({ ...config, perguntas: config.perguntas.map((x, i) => i === index ? { ...x, resposta: e.target.value } : x) })} /></label><button type="button" onClick={() => setConfig({ ...config, perguntas: config.perguntas.filter((_, i) => i !== index) })}>Remover resposta</button></fieldset>)}
      <div className={styles.acoes}><button type="button" disabled={config.perguntas.length >= 30} onClick={() => setConfig({ ...config, perguntas: [...config.perguntas, { id: 'faq_' + crypto.randomUUID().slice(0, 8), pergunta: '', resposta: '' }] })}>Adicionar resposta</button><button type="submit" className={styles.primario} aria-disabled={ocupado || undefined}>Salvar configuração</button></div>
    </form>}
  </main>;
}
