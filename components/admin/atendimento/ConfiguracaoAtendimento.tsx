'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { ConfiguracaoAtendimento as Configuracao } from '@/lib/whatsapp/atendimento/core';
import { bloqueioDoCodigo, type BloqueioAtendimento } from '@/lib/whatsapp/atendimento/acesso-tela';
import styles from './atendimento.module.css';

type LinkPublico = { ok: true; link: string } | { ok: false; motivo: 'OUTRA_EMPRESA' | 'NAO_CONFIGURADO' | 'ORIGEM_NAO_SEGURA' };
type Dados = { configuracao: Configuracao | null; automacaoDisponivel: boolean; podeConfigurar: boolean; wallE?: { disponivel: boolean; linkPublico?: LinkPublico } };
const nova = (): Configuracao => ({ ativo: false, nome: 'Kidmais', perguntas: [], limites: { respostasPor24h: 20 }, wallE: { ativo: false } });
/** Sem a 082 o Wall-e não existe neste ambiente: a chave não é gravada (o atendimento da fase B segue igual). */
function semWallE(c: Configuracao): Configuracao { const copia = { ...c }; delete copia.wallE; return copia; }
/** Por que o link público não sai, em linguagem de atendimento (o detalhe técnico fica com quem configura o servidor). */
const SEM_LINK: Record<Extract<LinkPublico, { ok: false }>['motivo'], string> = {
  NAO_CONFIGURADO: 'A página pública de disponibilidade ainda não está ligada neste servidor. Enquanto isso, o Wall-e consulta a agenda e a equipe conduz a contratação.',
  OUTRA_EMPRESA: 'A página pública deste servidor atende outra empresa. O Wall-e não envia esse link nas conversas desta empresa.',
  ORIGEM_NAO_SEGURA: 'O endereço público do sistema precisa usar https para o link ser enviado aos clientes.',
};

/**
 * Configuração do atendimento (representante), em três partes (rodada 40): identidade e boas-vindas (nome, Wall-e e a
 * prévia da saudação), links e atendimento (o link público de disponibilidade e as respostas aprovadas) e, recolhidos,
 * limites e opções avançadas. Separada da conversa: nada aqui fica entre o histórico e a resposta.
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
  const link = dados?.wallE?.linkPublico;
  const nome = config?.nome.trim() || 'sua empresa';
  return <main className={styles.pagina}>
    <header className={styles.topo}><div><h1>Configurações do atendimento</h1><p>Como o Wall-e se apresenta, o que ele envia e até onde ele vai.</p></div><div className={styles.acoes}><Link href="/admin/atendimento">Voltar ao atendimento</Link><Link href="/admin/atendimento/biblioteca">Biblioteca</Link></div></header>
    {bloqueio && <section className={styles.bloqueio} role="alert" data-bloqueio={bloqueio.tipo}><h2>{bloqueio.titulo}</h2><p>{bloqueio.orientacao}</p></section>}
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {aviso && <p role="status" className={styles.aviso}>{aviso}</p>}
    {!dados && !erro && !bloqueio && <p aria-live="polite">Carregando configuração…</p>}
    {dados && !dados.podeConfigurar && <p>Só o representante autorizado altera a configuração do atendimento.</p>}
    {dados?.podeConfigurar && config && <form className={styles.secoesConfig} onSubmit={e => { e.preventDefault(); void salvar(); }} aria-busy={ocupado || undefined}>
      <section className={styles.painel} aria-labelledby="config-identidade"><h2 id="config-identidade">Identidade e boas-vindas</h2>
        <label>Nome da empresa (como o Wall-e se apresenta)<input value={config.nome} required minLength={2} maxLength={100} onChange={e => setConfig({ ...config, nome: e.target.value })} /></label>
        <p className={styles.nota}>Assim o cliente é recebido na primeira mensagem (o cumprimento acompanha o dele):</p>
        <p className={styles.previaSaudacao} aria-label="Prévia da saudação">{`Boa tarde! Tudo bem, e você? Sou o Wall-e, agente inteligente da ${nome}. Se preferir falar com uma pessoa da equipe, é só pedir.`}</p>
        <label className={styles.opcao}><input type="checkbox" disabled={!dados.automacaoDisponivel} checked={config.ativo} onChange={e => setConfig({ ...config, ativo: e.target.checked })} />Responder os clientes automaticamente</label>
        {!dados.automacaoDisponivel && <p className={styles.nota}>Só pode ser ligado depois da ativação no servidor deste ambiente.</p>}
        {dados.wallE?.disponivel
          ? <label className={styles.opcao}><input type="checkbox" checked={!!config.wallE?.ativo} onChange={e => setConfig({ ...config, wallE: { ativo: e.target.checked } })} />Wall-e atende com as informações oficiais da empresa</label>
          : <p className={styles.nota}>O Wall-e fica disponível depois da atualização deste ambiente. Até lá vale o atendimento com as respostas aprovadas.</p>}
      </section>
      <section className={styles.painel} aria-labelledby="config-links"><h2 id="config-links">Links e atendimento</h2>
        <h3>Link público de disponibilidade</h3>
        {link?.ok ? <>
          <p className={styles.linkPublico}><code>{link.link}</code><a href={link.link} target="_blank" rel="noopener noreferrer">Abrir a página<span className={styles.oculto}> pública de disponibilidade (nova aba)</span></a></p>
          <p className={styles.nota}>O Wall-e envia este link quando o cliente pergunta por datas ou quer fechar. Enviar o link não reserva nada: a data só fica garantida quando a contratação é concluída. É o mesmo link para todos — diferente do link do contrato de cada cliente, que só a equipe envia.</p>
        </> : <p className={styles.nota}>{link ? SEM_LINK[link.motivo] : 'Disponível depois da atualização deste ambiente.'}</p>}
        <h3>Respostas aprovadas</h3>
        <p className={styles.nota}>Perguntas frequentes com a resposta exata da empresa. São usadas como estão; nada de preço, desconto, disponibilidade ou condição é criado.</p>
        {config.perguntas.map((p, index) => <fieldset key={p.id}><legend>Resposta {index + 1}</legend><label>Pergunta do cliente<input value={p.pergunta} required minLength={3} maxLength={250} onChange={e => setConfig({ ...config, perguntas: config.perguntas.map((x, i) => i === index ? { ...x, pergunta: e.target.value } : x) })} /></label><label>Resposta aprovada<textarea value={p.resposta} required minLength={3} maxLength={1500} onChange={e => setConfig({ ...config, perguntas: config.perguntas.map((x, i) => i === index ? { ...x, resposta: e.target.value } : x) })} /></label><button type="button" onClick={() => setConfig({ ...config, perguntas: config.perguntas.filter((_, i) => i !== index) })}>Remover resposta<span className={styles.oculto}> {index + 1}</span></button></fieldset>)}
        <button type="button" disabled={config.perguntas.length >= 30} onClick={() => setConfig({ ...config, perguntas: [...config.perguntas, { id: 'faq_' + crypto.randomUUID().slice(0, 8), pergunta: '', resposta: '' }] })}>Adicionar resposta</button>
      </section>
      <details className={`${styles.painel} ${styles.maisOpcoes}`}><summary>Limites e opções avançadas</summary>
        <label>Respostas automáticas por conversa em 24 horas<input type="number" inputMode="numeric" required min={1} max={100} value={config.limites.respostasPor24h} onChange={e => setConfig({ ...config, limites: { respostasPor24h: Number(e.target.value) } })} aria-describedby="limite-ajuda" /></label>
        <p id="limite-ajuda" className={styles.nota}>Ao atingir o limite, a conversa vai para a equipe em silêncio: o cliente não recebe nenhuma mensagem automática. O custo máximo da IA é definido no servidor.</p>
        {dados.wallE?.disponivel && <p className={styles.nota}>Com o Wall-e ligado, as respostas usam a agenda, os pacotes, os preços da tabela publicada, o buffet, o modelo de contrato e só o material da biblioteca publicado e liberado para ele. Ele nunca reserva data, dá desconto ou informa contrato particular: nesses casos passa para a equipe.</p>}
      </details>
      <div className={styles.acoes}><button type="submit" className={styles.primario} aria-disabled={ocupado || undefined}>Salvar configuração</button></div>
    </form>}
  </main>;
}
