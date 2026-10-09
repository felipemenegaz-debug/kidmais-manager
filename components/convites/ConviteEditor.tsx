'use client';
// As imagens privadas já são normalizadas pelo servidor; não usar cache público do otimizador Next.
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import { temas, type Conteudo } from '@/lib/convites/domain';
import { baseNeutra, modeloBiblioteca, modeloComFoto, modelosBiblioteca } from '@/lib/convites/modelos';
import ConviteArte, { baixarConvite } from './ConviteArte';
import ConviteVisual from './ConviteVisual';
import ConvitePresencas from './ConvitePresencas';
import ConviteFamilias, { type ResultadoFamilia } from './ConviteFamilias';
import type { ComandoFamilia, Familia } from '@/lib/convites/familias-domain';
import { extrairPaleta, visualPadrao } from '@/lib/convites/visual';
import styles from './convites.module.css';
import adminStyles from './editor-admin.module.css';
type Arte = { id: string; url: string; origem: string };
type Dados = { conteudo: Conteudo; revisao: number; publicado: boolean; desatualizado: boolean; linkPublico: string; clienteHabilitado: boolean; convidadosContratados?: number | null; familias?: Familia[];
  disponiveis: number; iaDisponivel: boolean; cotas: { festa: number; festaUsado: number; cliente: number; clienteUsado: number; empresa?: number; empresaUsado?: number };
  artes: Arte[]; respostas: { nome: string; presenca: boolean; adultos: number; criancas: number }[]; historico: { acao: string; ator: string; criado_em: string }[] };
const campos = [['nome', 'Nome do aniversariante'], ['idade', 'Idade ou celebração'], ['data', 'Data'], ['horario', 'Horário'], ['local', 'Local da festa'], ['endereco', 'Endereço']] as const;
export default function ConviteEditor({ festaId }: { festaId?: string }) {
  const admin = !!festaId;
  const ui = admin ? { ...styles, ...adminStyles } : styles;
  const [dados, setDados] = useState<Dados | null>(null), [conteudo, setConteudo] = useState<Conteudo | null>(null);
  const [carregando, setCarregando] = useState(true), [busy, setBusy] = useState(false), [erro, setErro] = useState(''), [aviso, setAviso] = useState('');
  const [prompt, setPrompt] = useState(''), [referencias, setReferencias] = useState<string[]>([]), [linkCliente, setLinkCliente] = useState('');
  const [cotaFesta, setCotaFesta] = useState(3), [cotaCliente, setCotaCliente] = useState(3);
  const [categoriaModelo, setCategoriaModelo] = useState<'todos' | 'neutros' | 'temas' | 'fotos'>('todos');
  const [arteExcluir, setArteExcluir] = useState<Arte | null>(null);
  const dialogo = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (arteExcluir) dialogo.current?.showModal(); else dialogo.current?.close(); }, [arteExcluir]);
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
  function campo<K extends keyof Conteudo>(k: K, value: Conteudo[K]) { setConteudo(c => c ? { ...c, [k]: value } : c); }
  async function extrairCores() {
    if (!arte || !conteudo) return;
    const arteId = conteudo.arteId; setBusy(true); setErro('');
    try {
      const cores = await extrairPaleta(arte);
      setConteudo(c => c?.arteId === arteId ? { ...c, visual: { ...(c.visual ?? visualPadrao), cores } } : c);
      setAviso('Cores extraídas. Confira a prévia e publique para atualizar a página. Nenhum crédito foi usado.');
    } catch (e) { setErro((e as Error).message); } finally { setBusy(false); }
  }
  async function atualizarPresencas() {
    setBusy(true); setErro('');
    try {
      const atual = await api() as Dados;
      // Não avança a revisão do rascunho: outra aba pode ter editado o convite.
      setDados(d => d ? { ...d, respostas: atual.respostas, familias: atual.familias, convidadosContratados: atual.convidadosContratados } : d);
      setAviso('Confirmações atualizadas. Suas alterações no editor foram preservadas.');
    }
    catch (e) { setErro((e as Error).message); } finally { setBusy(false); }
  }
  async function executarFamilia(cmd: ComandoFamilia): Promise<ResultadoFamilia | null> {
    setBusy(true); setErro(''); setAviso('');
    try {
      const r = await api(cmd) as ResultadoFamilia;
      const atual = await api() as Dados;
      setDados(d => d ? { ...d, familias: atual.familias, respostas: atual.respostas, historico: atual.historico, convidadosContratados: atual.convidadosContratados } : d);
      return r;
    } catch (e) { setErro((e as Error).message); return null; } finally { setBusy(false); }
  }
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
  async function excluirArte() {
    if (!arteExcluir || !dados) return;
    const id = arteExcluir.id;
    const r = await executar({ acao: 'excluir_arte', arteId: id, revisao: dados.revisao }, 'Imagem excluída da galeria. As demais alterações no editor foram preservadas.', true);
    if (r) {
      setConteudo(c => c?.arteId === id ? { ...c, arteId: null } : c);
      setReferencias(refs => refs.filter(ref => ref !== id));
      setArteExcluir(null);
    }
  }
  const arte = dados?.artes.find(a => a.id === conteudo?.arteId)?.url;
  return <main className={ui.editor} data-editor={admin ? 'buffet' : 'cliente'}>
    <header className={ui.cabecalho}><div><p className={ui.sobretitulo}>{admin ? 'FESTAS · CONVITE VIRTUAL' : 'KIDMAIS · CONVITES'}</p><h1>{admin ? 'Convite da festa' : <>Uma festa começa<br />com um convite.</>}</h1><p>{admin ? 'Personalize o convite, compartilhe com o cliente e acompanhe as confirmações.' : 'Escolha um tema, dê seu toque e compartilhe esse momento.'}</p></div>{admin && <Link className={ui.voltar} href={`/admin/festas/${festaId}`}>← Voltar à festa</Link>}</header>
    {erro && <p className={ui.erro} role="alert">{erro}</p>}{aviso && <p className={ui.aviso} role="status">{aviso}</p>}
    {carregando ? <p>Preparando seu convite…</p> : !dados || !conteudo ? <section className={ui.painel}><h2>Seu convite começa aqui</h2><p>Modelos prontos e arte própria não consomem créditos de IA.</p>{admin && <button disabled={busy} className={ui.primario} onClick={() => { setBusy(true); void carregar(true).then(() => setErro('')).catch(e => setErro(e.message)).finally(() => setBusy(false)); }}>Criar convite da festa</button>}</section> : <>
      <div className={ui.barra}><span>{dados.publicado ? '● Publicado' : '○ Rascunho'}{alterado ? ' · Alterações não salvas' : ''}</span><span><strong>{dados.disponiveis}</strong> créditos de imagem disponíveis</span></div>
      {dados.desatualizado && <p className={ui.erro}>A contratação foi atualizada e o link público está suspenso. Confira data, horário e local e publique novamente.</p>}
      <div className={ui.colunas}><div className={ui.configuracao}>
        <fieldset disabled={busy} className={ui.painel}><legend>01 · Escolha o visual</legend>
          <div className={styles.filtrosModelos} role="group" aria-label="Filtrar modelos">{([['todos', 'Todos'], ['neutros', 'Bases neutras'], ['fotos', 'Com foto'], ['temas', 'Temas']] as const).map(([id, nome]) => <button key={id} type="button" aria-pressed={categoriaModelo === id} onClick={() => setCategoriaModelo(id)}>{nome}</button>)}</div>
          <div className={styles.modelosBiblioteca}>{modelosBiblioteca.filter(id => categoriaModelo === 'todos' || (categoriaModelo === 'fotos' ? modeloComFoto(id) : categoriaModelo === 'neutros' ? baseNeutra(id) : !baseNeutra(id) && !modeloComFoto(id))).map(id => <button key={id} type="button" aria-pressed={conteudo.tema === id} onClick={() => setConteudo(c => c && (c.tema === id ? c : { ...c, tema: id, visual: { ...visualPadrao }, arteId: c.arteId }))}><img src={`/convites/modelos/${id}.svg`} alt="" /><strong>{temas[id].nome}</strong><small>{modeloComFoto(id) ? 'Sua foto em destaque' : baseNeutra(id) ? 'Base neutra · vários temas' : 'Tema espacial'}</small></button>)}</div>
          {(categoriaModelo === 'todos' || categoriaModelo === 'temas') && <details className={styles.modelosAnteriores}><summary>Mais modelos</summary><div className={ui.temas}>{Object.entries(temas).filter(([id]) => !modeloBiblioteca(id as Conteudo['tema'])).map(([id, t]) => <button key={id} type="button" aria-pressed={conteudo.tema === id} onClick={() => campo('tema', id as Conteudo['tema'])} style={{ background: t.fundo, color: t.tinta }}><span>{t.simbolo}</span>{t.nome}</button>)}</div></details>}
          <label className={ui.upload}>{modeloComFoto(conteudo.tema) ? 'Adicionar sua foto' : 'Usar uma arte própria'}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} /><small>PNG, JPEG ou WebP · até 5 MB · sem créditos de IA</small></label>
          {modeloComFoto(conteudo.tema) && <small>{arte ? 'A foto aparece inteira. Você pode trocá-la ou removê-la abaixo.' : 'Envie uma foto ou escolha uma imagem da festa para completar o modelo.'}</small>}
          {dados.artes.length > 0 && <><p>Imagens da festa</p><div className={ui.galeria}>{dados.artes.map((a, n) => <div key={a.id} className={ui.arteItem}><button className={ui.arteSelecionar} type="button" aria-label={`Selecionar imagem ${n + 1}`} aria-pressed={conteudo.arteId === a.id} onClick={() => campo('arteId', a.id)}><img src={a.url} alt={`Imagem ${n + 1} da festa`} /><span>{conteudo.arteId === a.id ? 'Selecionada' : 'Usar imagem'}</span></button><button type="button" className={ui.excluir} aria-label={`Excluir imagem ${n + 1}`} onClick={() => { setErro(''); setArteExcluir(a); }}>Excluir imagem</button></div>)}</div>{conteudo.arteId && <button type="button" className={ui.linkBotao} onClick={() => { campo('arteId', null); setAviso('Imagem removida da composição. Salve o rascunho ou publique para aplicar.'); }}>Remover imagem do convite</button>}<small>Remover do convite mantém o arquivo na galeria. Excluir imagem apaga o arquivo desta festa.</small></>}
          <ConviteVisual conteudo={conteudo} arte={arte} ui={ui} busy={busy} mudar={v => campo('visual', v)} extrair={() => void extrairCores()} />
        </fieldset>
        <fieldset disabled={busy} className={ui.painel}><legend>02 · Conte a sua festa</legend><div className={ui.campos}>{campos.map(([k, label]) => <label key={k}>{label}<input type={k === 'data' ? 'date' : k === 'horario' ? 'time' : 'text'} value={conteudo[k]} maxLength={k === 'endereco' ? 240 : k === 'local' ? 120 : k === 'idade' ? 20 : 80} onChange={e => campo(k, e.target.value)} /></label>)}</div><label>Mensagem<textarea rows={3} maxLength={400} value={conteudo.mensagem} onChange={e => campo('mensagem', e.target.value)} /></label><label className={ui.check}><input type="checkbox" checked={conteudo.confirmarPresenca} onChange={e => campo('confirmarPresenca', e.target.checked)} />Receber confirmações de presença</label><small>Alterar os textos não consome créditos.</small></fieldset>
        <details className={ui.painel}><summary>Crie uma arte com IA <span>Opcional · 1 crédito</span></summary><p>Descreva o visual. Nome, data e endereço serão colocados pelo editor.</p><textarea aria-label="Descreva a arte do convite" rows={4} maxLength={3000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Uma festa no espaço, com planetas em aquarela e tons de azul…" disabled={busy} />
          {!!dados.artes.length && <><p>Referências: escolha até duas artes anexadas.</p><div className={ui.artes}>{dados.artes.map(a => <button key={a.id} disabled={busy || (!referencias.includes(a.id) && referencias.length >= 2)} type="button" aria-label="Usar arte como referência" aria-pressed={referencias.includes(a.id)} onClick={() => setReferencias(refs => refs.includes(a.id) ? refs.filter(id => id !== a.id) : [...refs, a.id])}><img src={a.url} alt="Referência" /></button>)}</div></>}
          <button className={ui.primario} disabled={busy || !dados.iaDisponivel || dados.disponiveis < 1 || prompt.trim().length < 5} onClick={() => void gerar()}>{busy ? 'Processando…' : 'Gerar arte · 1 crédito'}</button>
          <small>{!dados.iaDisponivel ? 'O buffet ainda não habilitou a IA. Você pode usar os modelos e enviar sua arte.' : 'Cada nova geração ou edição por IA usa 1 crédito. Downloads não usam créditos.'}</small><button className={ui.linkBotao} disabled={busy} onClick={() => void executar({ acao: 'salvar', revisao: dados.revisao, conteudo }, 'Histórico atualizado.')}>Salvar e atualizar histórico</button>
        </details>
        {admin && <details className={ui.painel}><summary>Acesso do cliente e limites</summary><p>{dados.clienteHabilitado ? 'O cliente já pode criar o convite.' : 'Libere um link exclusivo para o cliente criar o convite.'}</p><button disabled={busy} onClick={async () => { const r = await executar({ acao: 'acesso', habilitado: true }, 'Novo acesso criado. O link anterior foi revogado.', true); if (r?.linkCliente) setLinkCliente(new URL(r.linkCliente, window.location.origin).href); }}>Gerar novo link do cliente</button>{dados.clienteHabilitado && <button disabled={busy} onClick={async () => { const r = await executar({ acao: 'acesso', habilitado: false }, 'Acesso revogado.', true); if (r) setLinkCliente(''); }}>Revogar acesso</button>}
          {linkCliente && <label>Link exclusivo de edição<input readOnly value={linkCliente} onFocus={e => e.target.select()} /><button onClick={() => void copiar(linkCliente)}>Copiar link do cliente</button></label>}
          <p>Franquia mensal: {dados.cotas.empresaUsado ?? 0} de {dados.cotas.empresa ?? 0} usados. A festa já usou {dados.cotas.festaUsado}, sendo {dados.cotas.clienteUsado} pelo cliente.</p>
          <div className={ui.campos}><label>Limite total da festa<input type="number" min={dados.cotas.festaUsado} max={100} value={cotaFesta} onChange={e => setCotaFesta(Number(e.target.value))} /></label><label>Limite do cliente<input type="number" min={dados.cotas.clienteUsado} max={cotaFesta} value={cotaCliente} onChange={e => setCotaCliente(Number(e.target.value))} /></label></div><button disabled={busy} onClick={() => void executar({ acao: 'cotas', festa: cotaFesta, cliente: cotaCliente }, 'Limites atualizados.', true)}>Aplicar limites</button><small>Os limites da festa são compartilhados. Somente a gestão pode aumentá-los. O saldo mensal da empresa continua sendo o teto.</small>
        </details>}
      </div><aside className={ui.preview}><p className={ui.sobretitulo}>É ASSIM QUE SEU CONVITE VAI FICAR</p><ConviteArte conteudo={conteudo} arte={arte} /><div className={ui.acoes}><button disabled={busy} onClick={() => void executar({ acao: 'salvar', revisao: dados.revisao, conteudo }, 'Rascunho salvo.')}>Salvar rascunho</button><button disabled={busy} className={ui.primario} onClick={() => void executar({ acao: 'publicar', revisao: dados.revisao, conteudo }, 'Convite publicado. Agora você pode compartilhar!')}>Publicar convite</button><button disabled={busy} onClick={() => void baixarConvite(conteudo, arte).catch(() => setErro('Não foi possível baixar. Tente novamente.'))}>Baixar imagem</button></div>
        {dados.publicado && <div className={ui.painel}><a href={dados.linkPublico} target="_blank" rel="noreferrer">Abrir convite publicado ↗</a><div className={ui.acoes}><button onClick={() => void copiar(dados.linkPublico)}>Copiar link público</button><button onClick={() => { const url = new URL(dados.linkPublico, window.location.origin).href; window.open(`https://wa.me/?text=${encodeURIComponent(`Você está convidado! ${url}`)}`, '_blank', 'noopener,noreferrer'); }}>Compartilhar no WhatsApp</button><button disabled={busy} onClick={() => void executar({ acao: 'despublicar', revisao: dados.revisao }, 'Convite despublicado.', true)}>Despublicar</button></div></div>}
      </aside></div>
      <ConviteFamilias familias={dados.familias ?? []} publicado={dados.publicado && !dados.desatualizado} busy={busy} erro={erro} ui={ui} executar={executarFamilia} />
      <ConvitePresencas respostas={dados.respostas} contratados={dados.convidadosContratados ?? null} ui={ui} busy={busy} atualizar={() => void atualizarPresencas()} />
      <details className={ui.painel}><summary>Histórico do convite</summary><ul>{dados.historico.map((h, n) => <li key={n}>{new Date(h.criado_em).toLocaleString('pt-BR')} · {h.ator === 'CLIENTE' ? 'Cliente' : 'Buffet'} · {h.acao.toLowerCase().replaceAll('_', ' ')}</li>)}</ul></details>
    </>}
    <dialog ref={dialogo} className={ui.dialogo} aria-labelledby="titulo-excluir-imagem" onCancel={e => { if (busy) e.preventDefault(); else setArteExcluir(null); }} onClose={() => setArteExcluir(null)}>
      <h2 id="titulo-excluir-imagem">Excluir imagem da galeria?</h2>
      <p>O arquivo será excluído desta festa. Essa ação não pode ser desfeita e não devolve créditos de IA.</p>
      <p>Se a imagem estiver no convite publicado, remova ou substitua a imagem e publique antes de excluí-la.</p>
      {erro && <p className={ui.erro} role="alert">{erro}</p>}
      <div className={ui.acoes}><button type="button" autoFocus disabled={busy} onClick={() => setArteExcluir(null)}>Cancelar</button><button type="button" className={ui.excluir} disabled={busy} onClick={() => void excluirArte()}>{busy ? 'Excluindo…' : 'Confirmar exclusão'}</button></div>
    </dialog>
  </main>;
}
