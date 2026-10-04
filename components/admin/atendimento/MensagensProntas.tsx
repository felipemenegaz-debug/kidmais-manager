'use client';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { ATALHOS, NOME_ATALHO, NOME_TIPO, TIPOS, categorias, filtrarProntas, type Atalho, type Pronta, type TipoPronta } from '@/lib/whatsapp/atendimento/prontas';
import styles from './atendimento.module.css';

type Biblioteca = { prontas: Pronta[]; favoritas: string[]; podeGerenciar: boolean };
type Rascunho = { titulo: string; texto: string; linkIndividual: 'PREENCHIDO' | 'NAO_PREENCHIDO' | null; aviso: string | null };
const ROTA = '/api/admin/atendimento/prontas';

async function chamar<T>(corpo?: unknown): Promise<T> {
  const r = await adminFetch(ROTA, corpo ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) } : undefined);
  const json = await r.json();
  if (!r.ok || !json.ok) throw Error(json.erro || 'Não foi possível concluir.');
  return json.data as T;
}
function useBiblioteca(ativa: boolean) {
  const [dados, setDados] = useState<Biblioteca | null>(null), [erro, setErro] = useState('');
  const carregar = useCallback(async () => {
    try { setDados(await chamar<Biblioteca>()); setErro(''); } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível carregar as mensagens prontas.'); }
  }, []);
  useEffect(() => { if (!ativa) return; const t = window.setTimeout(() => void carregar(), 0); return () => window.clearTimeout(t); }, [ativa, carregar]);
  return { dados, erro, setErro, carregar };
}

/**
 * Biblioteca junto ao campo de resposta: busca, categorias, favoritas e os atalhos em destaque. Escolher prepara um
 * rascunho com prévia editável; "Colocar na resposta" só preenche o campo. O envio continua no "Enviar resposta".
 */
export function MensagensProntas({ conversaId, podeUsar, motivoBloqueio, textoAtual, onUsar }: { conversaId: string; podeUsar: boolean; motivoBloqueio: string; textoAtual: string; onUsar: (texto: string) => void }) {
  const [aberta, setAberta] = useState(false), [busca, setBusca] = useState(''), [categoria, setCategoria] = useState(''), [soFavoritas, setSoFavoritas] = useState(false);
  const [rascunho, setRascunho] = useState<Rascunho | null>(null), [ocupado, setOcupado] = useState(false), [aviso, setAviso] = useState('');
  const { dados, erro, setErro, carregar } = useBiblioteca(aberta);
  const id = useId(), painel = `${id}-painel`, previa = `${id}-previa`;
  const favoritas = useMemo(() => new Set(dados?.favoritas ?? []), [dados]);
  const lista = useMemo(() => dados ? filtrarProntas(dados.prontas, { busca, categoria: categoria || null, favoritas: soFavoritas ? favoritas : null }) : [], [dados, busca, categoria, soFavoritas, favoritas]);
  const porAtalho = (a: Atalho) => dados?.prontas.find(p => p.atalho === a);
  // Trocar de conversa descarta a prévia: o link individual depende do contato.
  useEffect(() => { const t = window.setTimeout(() => setRascunho(null), 0); return () => window.clearTimeout(t); }, [conversaId]);

  async function preparar(p: Pronta) {
    if (ocupado) return; setOcupado(true); setErro(''); setAviso('');
    try { setRascunho(await chamar<Rascunho>({ acao: 'rascunho', id: p.id, conversaId })); }
    catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível preparar o rascunho.'); } finally { setOcupado(false); }
  }
  async function alternarFavorita(p: Pronta) {
    try { await chamar({ acao: 'favoritar', id: p.id, favorita: !favoritas.has(p.id) }); await carregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível atualizar a favorita.'); }
  }
  function usar() { if (!rascunho || !podeUsar) return; onUsar(rascunho.texto); setRascunho(null); setAviso('Rascunho colocado no campo de resposta. Revise e envie quando quiser.'); }

  return <div className={styles.prontas}>
    <button type="button" aria-expanded={aberta} aria-controls={painel} onClick={() => setAberta(v => !v)}>{aberta ? 'Fechar mensagens prontas' : 'Mensagens prontas'}</button>
    {aviso && <p role="status" className={styles.nota}>{aviso}</p>}
    {aberta && <section id={painel} className={styles.painelProntas} aria-label="Mensagens prontas">
      <p className={styles.nota}>Biblioteca da equipe. Não é usada pela IA e nada é enviado sem você.</p>
      {erro && <p className={styles.erro} role="alert">{erro}</p>}
      {!dados && !erro && <p aria-live="polite">Carregando mensagens prontas…</p>}
      {dados && <>
        <div className={styles.atalhos} role="group" aria-label="Atalhos">
          {ATALHOS.map(a => { const p = porAtalho(a); return <button type="button" key={a} className={styles.atalho} disabled={!p || ocupado} aria-describedby={p ? undefined : `${id}-sem-${a}`} onClick={() => p && void preparar(p)}>{NOME_ATALHO[a]}</button>; })}
          {ATALHOS.filter(a => !porAtalho(a)).map(a => <span key={a} id={`${id}-sem-${a}`} className={styles.nota}>{NOME_ATALHO[a]}: ainda não cadastrada.</span>)}
        </div>
        <div className={styles.filtros}>
          <label>Buscar<input type="search" value={busca} onChange={e => setBusca(e.target.value)} placeholder="Título, categoria ou texto" /></label>
          <label>Categoria<select value={categoria} onChange={e => setCategoria(e.target.value)}><option value="">Todas</option>{categorias(dados.prontas).map(c => <option key={c}>{c}</option>)}</select></label>
          <label className={styles.opcao}><input type="checkbox" checked={soFavoritas} onChange={e => setSoFavoritas(e.target.checked)} />Só favoritas</label>
        </div>
        <p className={styles.nota} aria-live="polite">{lista.length === 1 ? '1 mensagem' : `${lista.length} mensagens`}</p>
        <ul className={styles.listaProntas}>
          {lista.map(p => <li key={p.id}>
            <button type="button" className={styles.itemPronta} disabled={ocupado} onClick={() => void preparar(p)}><strong>{p.titulo}</strong><span>{p.categoria} · {NOME_TIPO[p.tipo]}</span></button>
            <button type="button" className={styles.favorita} aria-pressed={favoritas.has(p.id)} aria-label={`Favorita: ${p.titulo}`} onClick={() => void alternarFavorita(p)}>{favoritas.has(p.id) ? '★' : '☆'}</button>
          </li>)}
        </ul>
        {!lista.length && <p>{dados.prontas.length ? 'Nenhuma mensagem com esse filtro.' : 'Nenhuma mensagem pronta cadastrada.'}</p>}
      </>}
      {rascunho && <div className={styles.previa}>
        <label htmlFor={previa}>Prévia de “{rascunho.titulo}” — edite antes de usar</label>
        <textarea id={previa} maxLength={4000} value={rascunho.texto} onChange={e => setRascunho({ ...rascunho, texto: e.target.value })} aria-describedby={rascunho.aviso ? `${previa}-aviso` : undefined} />
        {rascunho.aviso && <p id={`${previa}-aviso`} role="status" className={styles.fila}>{rascunho.aviso}</p>}
        {rascunho.linkIndividual === 'PREENCHIDO' && <p className={styles.nota}>Link individual preenchido pelo fluxo de contratação deste cliente.</p>}
        <div className={styles.acoes}>
          <button type="button" className={styles.primario} disabled={!podeUsar || !rascunho.texto.trim()} onClick={usar}>{textoAtual.trim() ? 'Substituir a resposta' : 'Colocar na resposta'}</button>
          <button type="button" onClick={() => setRascunho(null)}>Descartar prévia</button>
        </div>
        {!podeUsar && motivoBloqueio && <p>{motivoBloqueio}</p>}
        <p className={styles.nota}>O envio continua sendo pelo botão “Enviar resposta”.</p>
      </div>}
    </section>}
  </div>;
}

const vazia = (): EdicaoPronta => ({ titulo: '', categoria: '', tipo: 'TEXTO', texto: '', link: '', atalho: '' });
type EdicaoPronta = { id?: string; versao?: number; titulo: string; categoria: string; tipo: TipoPronta; texto: string; link: string; atalho: Atalho | '' };

/** Cadastro da biblioteca (representante). Separado das respostas publicadas para a IA e das automações. */
export function GerenciarMensagensProntas() {
  const [aberta, setAberta] = useState(false), [edicao, setEdicao] = useState<EdicaoPronta | null>(null), [ocupado, setOcupado] = useState(false), [aviso, setAviso] = useState('');
  const { dados, erro, setErro, carregar } = useBiblioteca(aberta);
  const id = useId();
  async function salvar() {
    if (!edicao || ocupado) return; setOcupado(true); setErro(''); setAviso('');
    const { link, atalho, ...resto } = edicao;
    try { await chamar({ acao: 'salvar', pronta: { ...resto, link: edicao.tipo === 'LINK' ? link.trim() : null, atalho: atalho || null } }); setEdicao(null); setAviso('Mensagem pronta salva.'); await carregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : 'Confira os campos.'); } finally { setOcupado(false); }
  }
  async function arquivar(p: Pronta) {
    if (ocupado || !window.confirm(`Remover “${p.titulo}” da biblioteca? Conversas já enviadas não mudam.`)) return;
    setOcupado(true); setErro(''); setAviso('');
    try { await chamar({ acao: 'arquivar', id: p.id, versao: p.versao }); setAviso('Mensagem removida da biblioteca.'); await carregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível remover.'); } finally { setOcupado(false); }
  }
  return <details className={styles.painel} onToggle={e => setAberta((e.target as HTMLDetailsElement).open)}>
    <summary>Mensagens prontas da equipe (cadastro)</summary>
    <p>Textos e links que o atendente escolhe, revisa e envia. Não são respostas da IA nem automações. Links individuais de fechamento não são digitados: vêm do fluxo de contratação do cliente.</p>
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {aviso && <p role="status">{aviso}</p>}
    {dados && !dados.podeGerenciar && <p>Só o representante autorizado cadastra mensagens prontas.</p>}
    {dados?.podeGerenciar && !edicao && <button type="button" onClick={() => setEdicao(vazia())}>Nova mensagem pronta</button>}
    {edicao && <form onSubmit={e => { e.preventDefault(); void salvar(); }} aria-label={edicao.id ? 'Editar mensagem pronta' : 'Nova mensagem pronta'}>
      <label>Título<input required minLength={2} maxLength={80} value={edicao.titulo} onChange={e => setEdicao({ ...edicao, titulo: e.target.value })} /></label>
      <label>Categoria<input required minLength={2} maxLength={40} list={`${id}-categorias`} value={edicao.categoria} onChange={e => setEdicao({ ...edicao, categoria: e.target.value })} /></label>
      <datalist id={`${id}-categorias`}>{categorias(dados?.prontas ?? []).map(c => <option key={c} value={c} />)}</datalist>
      <label>Tipo<select value={edicao.tipo} onChange={e => setEdicao({ ...edicao, tipo: e.target.value as TipoPronta, link: '' })}>{TIPOS.map(t => <option key={t} value={t}>{NOME_TIPO[t]}</option>)}</select></label>
      <label>Texto<textarea required maxLength={4000} value={edicao.texto} onChange={e => setEdicao({ ...edicao, texto: e.target.value })} /></label>
      {edicao.tipo === 'LINK' && <label>Link (https)<input type="url" required inputMode="url" placeholder="https://" value={edicao.link} onChange={e => setEdicao({ ...edicao, link: e.target.value })} /></label>}
      {edicao.tipo === 'LINK_FECHAMENTO_INDIVIDUAL' && <p>O link é preenchido na prévia só quando o telefone da conversa corresponde a um único cliente desta empresa, com um único contrato aguardando a assinatura dele.</p>}
      <label>Atalho<select value={edicao.atalho} onChange={e => setEdicao({ ...edicao, atalho: e.target.value as Atalho | '' })}><option value="">Nenhum</option>{ATALHOS.map(a => <option key={a} value={a}>{NOME_ATALHO[a]}</option>)}</select></label>
      <div className={styles.acoes}><button type="submit" className={styles.primario} disabled={ocupado}>Salvar mensagem pronta</button><button type="button" onClick={() => setEdicao(null)}>Cancelar</button></div>
    </form>}
    {dados && <ul className={styles.listaProntas}>{dados.prontas.map(p => <li key={p.id}>
      <span className={styles.itemPronta}><strong>{p.titulo}</strong><span>{p.categoria} · {NOME_TIPO[p.tipo]}{p.atalho ? ' · atalho ' + NOME_ATALHO[p.atalho] : ''}</span></span>
      {dados.podeGerenciar && <span className={styles.acoes}><button type="button" onClick={() => setEdicao({ id: p.id, versao: p.versao, titulo: p.titulo, categoria: p.categoria, tipo: p.tipo, texto: p.texto, link: p.link ?? '', atalho: p.atalho ?? '' })}>Editar<span className={styles.oculto}> {p.titulo}</span></button><button type="button" onClick={() => void arquivar(p)}>Remover<span className={styles.oculto}> {p.titulo}</span></button></span>}
    </li>)}</ul>}
  </details>;
}
