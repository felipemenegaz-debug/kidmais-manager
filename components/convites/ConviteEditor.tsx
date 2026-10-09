'use client';
// As imagens privadas já são normalizadas pelo servidor; não usar cache público do otimizador Next.
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import { temas, type Conteudo } from '@/lib/convites/domain';
import ConviteArte, { baixarConvite } from './ConviteArte';
import styles from './convites.module.css';
type Arte = { id: string; url: string; origem: string };
type Dados = { conteudo: Conteudo; revisao: number; publicado: boolean; desatualizado: boolean; linkPublico: string; clienteHabilitado: boolean;
  disponiveis: number; iaDisponivel: boolean; cotas: { festa: number; festaUsado: number; cliente: number; clienteUsado: number; empresa?: number; empresaUsado?: number };
  artes: Arte[]; respostas: { nome: string; presenca: boolean; adultos: number; criancas: number }[]; historico: { acao: string; ator: string; criado_em: string }[] };
const campos = [['nome', 'Nome do aniversariante'], ['idade', 'Idade ou celebração'], ['data', 'Data'], ['horario', 'Horário'], ['local', 'Local da festa'], ['endereco', 'Endereço']] as const;
export default function ConviteEditor({ festaId }: { festaId?: string }) {
  const admin = !!festaId;
  const [dados, setDados] = useState<Dados | null>(null), [conteudo, setConteudo] = useState<Conteudo | null>(null);
  const [carregando, setCarregando] = useState(true), [busy, setBusy] = useState(false), [erro, setErro] = useState(''), [aviso, setAviso] = useState('');
  const [prompt, setPrompt] = useState(''), [referencias, setReferencias] = useState<string[]>([]), [linkCliente, setLinkCliente] = useState('');
  const [cotaFesta, setCotaFesta] = useState(3), [cotaCliente, setCotaCliente] = useState(3);
  const token = useRef(''), pedido = useRef<{ assinatura: string; chave: string } | null>(null);
  const endpoint = admin ? `/api/admin/convites?festaId=${festaId}` : '/api/convites/cliente';
  const api = useCallback(async (body?: object) => {
    const init: RequestInit = { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(!admin ? { Authorization: `Bearer ${token.current}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store' };
    const r = await (admin ? adminFetch(endpoint, init) : fetch(endpoint, init));
    const j = await r.json(); if (!r.ok) throw new Error(j.erro || 'Não foi possível concluir.'); return j.data;
  }, [admin, endpoint]);
  const carregar = useCallback(async (criar = false, preservar = false) => {
    const d = await api(criar ? { acao: 'criar' } : undefined) as Dados;
    setDados(d); if (!preservar) setConteudo(d.conteudo); setCotaFesta(d.cotas.festa); setCotaCliente(d.cotas.cliente);
  }, [api]);
  useEffect(() => {
    let ativo = true;
    token.current = window.location.hash.slice(1);
    // Token só no fragmento e memória desta aba; nunca em query string ou armazenamento persistente.
    void Promise.resolve().then(async () => { if (ativo) { try { await carregar(); } catch (e) { if (ativo) setErro((e as Error).message); } finally { if (ativo) setCarregando(false); } } });
    return () => { ativo = false; };
  }, [carregar]);
  const alterado = !!dados && !!conteudo && JSON.stringify(conteudo) !== JSON.stringify(dados.conteudo);
  useEffect(() => { const sair = (e: BeforeUnloadEvent) => { if (alterado) e.preventDefault(); }; window.addEventListener('beforeunload', sair); return () => window.removeEventListener('beforeunload', sair); }, [alterado]);
  async function executar(body: object, mensagem: string, preservar = false) {
    setBusy(true); setErro(''); setAviso('');
    try { const r = await api(body); await carregar(false, preservar); setAviso(mensagem); return r; }
    catch (e) { setErro((e as Error).message); return null; } finally { setBusy(false); }
  }
  function campo(k: keyof Conteudo, value: string | boolean | null) { setConteudo(c => c ? { ...c, [k]: value } : c); }
  async function upload(file?: File) {
    if (!file) return;
    if (file.size > 5_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setErro('Envie PNG, JPEG ou WebP de até 5 MB.'); return; }
    try {
      const imagem = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); });
      const r = await executar({ acao: 'upload', imagem }, 'Arte enviada. Salve ou publique para aplicar.', true);
      if (r?.arteId) campo('arteId', r.arteId);
    } catch { setErro('Não foi possível ler o arquivo.'); }
  }
  async function gerar() {
    const assinatura = JSON.stringify({ prompt, referencias });
    if (!pedido.current || pedido.current.assinatura !== assinatura) pedido.current = { assinatura, chave: crypto.randomUUID() };
    const r = await executar({ acao: 'gerar', chave: pedido.current.chave, prompt, referencias }, 'Confira a arte e publique quando estiver pronta.', true);
    if (r?.arteId) { campo('arteId', r.arteId); pedido.current = null; }
    else if (r) setAviso('Pedido já recebido. Recarregue o histórico para conferir o resultado.');
  }
  async function copiar(link: string) { try { await navigator.clipboard.writeText(new URL(link, window.location.origin).href); setAviso('Link copiado.'); } catch { setErro('Não foi possível copiar. Selecione o link para copiar manualmente.'); } }
  const arte = dados?.artes.find(a => a.id === conteudo?.arteId)?.url;
  const confirmados = dados?.respostas.filter(r => r.presenca) ?? [];
  return <main className={styles.editor}>
    <header className={styles.cabecalho}><div><p className={styles.sobretitulo}>KIDMAIS · CONVITES</p><h1>Uma festa começa<br />com um convite.</h1><p>Escolha um tema, dê seu toque e compartilhe esse momento.</p></div>{admin && <Link className={styles.voltar} href={`/admin/festas/${festaId}`}>← Voltar à festa</Link>}</header>
    {erro && <p className={styles.erro} role="alert">{erro}</p>}{aviso && <p className={styles.aviso} role="status">{aviso}</p>}
    {carregando ? <p>Preparando seu convite…</p> : !dados || !conteudo ? <section className={styles.painel}><h2>Seu convite começa aqui</h2><p>Modelos prontos e arte própria não consomem créditos de IA.</p>{admin && <button disabled={busy} className={styles.primario} onClick={() => { setBusy(true); void carregar(true).then(() => setErro('')).catch(e => setErro(e.message)).finally(() => setBusy(false)); }}>Criar convite da festa</button>}</section> : <>
      <div className={styles.barra}><span>{dados.publicado ? '● Publicado' : '○ Rascunho'}{alterado ? ' · Alterações não salvas' : ''}</span><span><strong>{dados.disponiveis}</strong> créditos de imagem disponíveis</span></div>
      {dados.desatualizado && <p className={styles.erro}>A contratação foi atualizada e o link público está suspenso. Confira data, horário e local e publique novamente.</p>}
      <div className={styles.colunas}><div className={styles.configuracao}>
        <fieldset disabled={busy} className={styles.painel}><legend>01 · Escolha o visual</legend><div className={styles.temas}>{Object.entries(temas).map(([id, t]) => <button key={id} type="button" aria-pressed={conteudo.tema === id} onClick={() => campo('tema', id)} style={{ background: t.fundo, color: t.tinta }}><span>{t.simbolo}</span>{t.nome}</button>)}</div><label className={styles.upload}>Usar uma arte própria<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} /><small>PNG, JPEG ou WebP · até 5 MB · sem créditos de IA</small></label>
          {dados.artes.length > 0 && <><div className={styles.artes}>{dados.artes.map(a => <button key={a.id} type="button" aria-label={`Selecionar arte ${a.origem}`} aria-pressed={conteudo.arteId === a.id} onClick={() => campo('arteId', a.id)}><img src={a.url} alt="Arte do convite" /></button>)}</div><button type="button" className={styles.linkBotao} onClick={() => campo('arteId', null)}>Usar somente o modelo</button></>}
        </fieldset>
        <fieldset disabled={busy} className={styles.painel}><legend>02 · Conte a sua festa</legend><div className={styles.campos}>{campos.map(([k, label]) => <label key={k}>{label}<input type={k === 'data' ? 'date' : k === 'horario' ? 'time' : 'text'} value={conteudo[k]} maxLength={k === 'endereco' ? 240 : k === 'local' ? 120 : k === 'idade' ? 20 : 80} onChange={e => campo(k, e.target.value)} /></label>)}</div><label>Mensagem<textarea rows={3} maxLength={400} value={conteudo.mensagem} onChange={e => campo('mensagem', e.target.value)} /></label><label className={styles.check}><input type="checkbox" checked={conteudo.confirmarPresenca} onChange={e => campo('confirmarPresenca', e.target.checked)} />Receber confirmações de presença</label><small>Alterar os textos não consome créditos.</small></fieldset>
        <details className={styles.painel}><summary>Crie uma arte com IA <span>Opcional · 1 crédito</span></summary><p>Descreva o visual. Nome, data e endereço serão colocados pelo editor.</p><textarea aria-label="Descreva a arte do convite" rows={4} maxLength={3000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Uma festa no espaço, com planetas em aquarela e tons de azul…" disabled={busy} />
          {!!dados.artes.length && <><p>Referências: escolha até duas artes anexadas.</p><div className={styles.artes}>{dados.artes.map(a => <button key={a.id} disabled={busy || (!referencias.includes(a.id) && referencias.length >= 2)} type="button" aria-label="Usar arte como referência" aria-pressed={referencias.includes(a.id)} onClick={() => setReferencias(refs => refs.includes(a.id) ? refs.filter(id => id !== a.id) : [...refs, a.id])}><img src={a.url} alt="Referência" /></button>)}</div></>}
          <button className={styles.primario} disabled={busy || !dados.iaDisponivel || dados.disponiveis < 1 || prompt.trim().length < 5} onClick={() => void gerar()}>{busy ? 'Processando…' : 'Gerar arte · 1 crédito'}</button>
          <small>{!dados.iaDisponivel ? 'O buffet ainda não habilitou a IA. Você pode usar os modelos e enviar sua arte.' : 'Cada nova geração ou edição por IA usa 1 crédito. Downloads não usam créditos.'}</small><button className={styles.linkBotao} disabled={busy} onClick={() => void executar({ acao: 'salvar', revisao: dados.revisao, conteudo }, 'Histórico atualizado.')}>Salvar e atualizar histórico</button>
        </details>
        {admin && <details className={styles.painel}><summary>Acesso do cliente e limites</summary><p>{dados.clienteHabilitado ? 'O cliente já pode criar o convite.' : 'Libere um link exclusivo para o cliente criar o convite.'}</p><button disabled={busy} onClick={async () => { const r = await executar({ acao: 'acesso', habilitado: true }, 'Novo acesso criado. O link anterior foi revogado.', true); if (r?.linkCliente) setLinkCliente(new URL(r.linkCliente, window.location.origin).href); }}>Gerar novo link do cliente</button>{dados.clienteHabilitado && <button disabled={busy} onClick={async () => { const r = await executar({ acao: 'acesso', habilitado: false }, 'Acesso revogado.', true); if (r) setLinkCliente(''); }}>Revogar acesso</button>}
          {linkCliente && <label>Link exclusivo de edição<input readOnly value={linkCliente} onFocus={e => e.target.select()} /><button onClick={() => void copiar(linkCliente)}>Copiar link do cliente</button></label>}
          <p>Franquia mensal: {dados.cotas.empresaUsado ?? 0} de {dados.cotas.empresa ?? 0} usados. A festa já usou {dados.cotas.festaUsado}, sendo {dados.cotas.clienteUsado} pelo cliente.</p>
          <div className={styles.campos}><label>Limite total da festa<input type="number" min={dados.cotas.festaUsado} max={100} value={cotaFesta} onChange={e => setCotaFesta(Number(e.target.value))} /></label><label>Limite do cliente<input type="number" min={dados.cotas.clienteUsado} max={cotaFesta} value={cotaCliente} onChange={e => setCotaCliente(Number(e.target.value))} /></label></div><button disabled={busy} onClick={() => void executar({ acao: 'cotas', festa: cotaFesta, cliente: cotaCliente }, 'Limites atualizados.', true)}>Aplicar limites</button><small>Os limites da festa são compartilhados. Somente a gestão pode aumentá-los. O saldo mensal da empresa continua sendo o teto.</small>
        </details>}
      </div><aside className={styles.preview}><p className={styles.sobretitulo}>É ASSIM QUE SEU CONVITE VAI FICAR</p><ConviteArte conteudo={conteudo} arte={arte} /><div className={styles.acoes}><button disabled={busy} onClick={() => void executar({ acao: 'salvar', revisao: dados.revisao, conteudo }, 'Rascunho salvo.')}>Salvar rascunho</button><button disabled={busy} className={styles.primario} onClick={() => void executar({ acao: 'publicar', revisao: dados.revisao, conteudo }, 'Convite publicado. Agora você pode compartilhar!')}>Publicar convite</button><button disabled={busy} onClick={() => void baixarConvite(conteudo, arte).catch(() => setErro('Não foi possível baixar. Tente novamente.'))}>Baixar imagem</button></div>
        {dados.publicado && <div className={styles.painel}><a href={dados.linkPublico} target="_blank" rel="noreferrer">Abrir convite publicado ↗</a><div className={styles.acoes}><button onClick={() => void copiar(dados.linkPublico)}>Copiar link público</button><button onClick={() => { const url = new URL(dados.linkPublico, window.location.origin).href; window.open(`https://wa.me/?text=${encodeURIComponent(`Você está convidado! ${url}`)}`, '_blank', 'noopener,noreferrer'); }}>Compartilhar no WhatsApp</button><button disabled={busy} onClick={() => void executar({ acao: 'despublicar', revisao: dados.revisao }, 'Convite despublicado.', true)}>Despublicar</button></div></div>}
      </aside></div>
      <section className={styles.painel}><p className={styles.sobretitulo}>QUEM VEM COMEMORAR</p><h2>Confirmações de presença</h2><p>{confirmados.reduce((n, r) => n + r.adultos, 0)} adultos · {confirmados.reduce((n, r) => n + r.criancas, 0)} crianças · {dados.respostas.filter(r => !r.presenca).length} respostas “não vou”</p><small>São respostas por família, sem verificação de identidade. Não alteram o contrato nem a cobrança.</small>{dados.respostas.length ? <div className={styles.tabela}><table><thead><tr><th>Família</th><th>Resposta</th><th>Adultos</th><th>Crianças</th></tr></thead><tbody>{dados.respostas.map((r, n) => <tr key={n}><td>{r.nome}</td><td>{r.presenca ? 'Vou!' : 'Não vou'}</td><td>{r.adultos}</td><td>{r.criancas}</td></tr>)}</tbody></table></div> : <p>As confirmações aparecerão aqui depois de compartilhar o convite.</p>}</section>
      <details className={styles.painel}><summary>Histórico do convite</summary><ul>{dados.historico.map((h, n) => <li key={n}>{new Date(h.criado_em).toLocaleString('pt-BR')} · {h.ator === 'CLIENTE' ? 'Cliente' : 'Buffet'} · {h.acao.toLowerCase().replaceAll('_', ' ')}</li>)}</ul></details>
    </>}
  </main>;
}
