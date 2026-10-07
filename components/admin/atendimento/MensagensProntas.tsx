'use client';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import { ATALHOS, ATALHOS_074, FINALIDADES, LIMITE_LEGENDA, NOME_ANEXO, NOME_ATALHO, NOME_ESTADO_PRONTA, NOME_FINALIDADE, NOME_TIPO, REQUISITO_MIDIA, TIPOS, categorias, ehAnexo, ehMidia, filtrarProntas, type ArquivoPronta, type Atalho, type EstadoPronta, type Finalidade, type Pronta, type TipoAnexo, type TipoMidia, type TipoPronta } from '@/lib/whatsapp/atendimento/prontas';
import styles from './atendimento.module.css';

type Biblioteca = { prontas: Pronta[]; favoritas: string[]; podeGerenciar: boolean; recursos074?: boolean; recursos075?: boolean; unidades?: { id: string; nome: string }[]; pacotes?: { codigo: string; nome: string }[] };
/**
 * Foto, vídeo ou PDF de uma mensagem pronta: a URL é só para conferência; no envio vão o id e a versão da pronta vistos
 * na prévia (o servidor lê a mídia e recusa se a pronta mudou depois).
 */
export type MidiaPronta = { tipo: TipoAnexo; url: string; prontaId: string; versao: number; titulo: string; nome?: string };
type RascunhoServidor = { titulo: string; texto: string; linkIndividual: 'PREENCHIDO' | 'NAO_PREENCHIDO' | null; aviso: string | null; midia?: { tipo: TipoAnexo; url: string; prontaId: string; versao: number; nome?: string } };
/** O rascunho pertence à conversa de ORIGEM: o link individual e o texto só valem para ela. */
type Rascunho = RascunhoServidor & { conversaId: string; prontaId: string };
const ROTA = '/api/admin/atendimento/prontas';

async function chamar<T>(corpo?: unknown, consulta = ''): Promise<T> {
  const r = await adminFetch(ROTA + consulta, corpo ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) } : undefined);
  const json = await r.json();
  if (!r.ok || !json.ok) throw Error(json.erro || 'Não foi possível concluir.');
  return json.data as T;
}
function useBiblioteca(ativa: boolean, gerenciar = false) {
  const [dados, setDados] = useState<Biblioteca | null>(null), [erro, setErro] = useState('');
  const carregar = useCallback(async () => {
    try { setDados(await chamar<Biblioteca>(undefined, gerenciar ? '?gerenciar=1' : '')); setErro(''); } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível carregar as mensagens prontas.'); }
  }, [gerenciar]);
  useEffect(() => { if (!ativa) return; const t = window.setTimeout(() => void carregar(), 0); return () => window.clearTimeout(t); }, [ativa, carregar]);
  return { dados, erro, setErro, carregar };
}
const anexado = (tipo: TipoAnexo) => `${NOME_ANEXO[tipo].nome} ${NOME_ANEXO[tipo].anexado}`;

/**
 * Biblioteca do atendente: abre sob demanda numa gaveta lateral (nunca entre o histórico e o campo de resposta), com
 * busca, categorias, favoritas, "só anexos" e os atalhos em destaque. Escolher prepara uma prévia editável; "Colocar
 * na resposta" (ou "Anexar à resposta", foto/vídeo/PDF) só preenche a resposta. O envio continua no botão da resposta.
 * `cicloResposta`: a tela muda esse número quando a resposta sai ou o anexo deixa de valer; o aviso de antes some.
 * `pedirPronta`: a tela pede a prévia de uma pronta (sugestão do Wall-e): abre a gaveta e prepara, como um clique.
 */
export function MensagensProntas({ conversaId, podeUsar, motivoBloqueio, textoAtual, onUsar, cicloResposta = 0, pedirPronta = null }: { conversaId: string; podeUsar: boolean; motivoBloqueio: string; textoAtual: string; onUsar: (texto: string, conversaId: string, midia: MidiaPronta | null) => void; cicloResposta?: number; pedirPronta?: { id: string; n: number } | null }) {
  const [aberta, setAberta] = useState(false), [busca, setBusca] = useState(''), [categoria, setCategoria] = useState(''), [soFavoritas, setSoFavoritas] = useState(false), [soAnexos, setSoAnexos] = useState(false);
  const [rascunho, setRascunho] = useState<Rascunho | null>(null), [ocupado, setOcupado] = useState(false), [avisoUso, setAvisoUso] = useState<{ texto: string; ciclo: number } | null>(null);
  // Derivado (sem efeito): o aviso só vale no mesmo ciclo da resposta em que foi dado.
  const aviso = avisoUso && avisoUso.ciclo === cicloResposta ? avisoUso.texto : '';
  const setAviso = (texto: string) => setAvisoUso(texto ? { texto, ciclo: cicloResposta } : null);
  // Conversa vigente e número do último pedido de prévia: retorno atrasado (de outra conversa ou de pedido anterior) é descartado.
  const conversaAtual = useRef(conversaId), pedidoRascunho = useRef(0);
  // Foco: a busca ao abrir; a prévia quando chega (só a pedida nesta conversa); descartar devolve ao item de origem;
  // fechar a gaveta devolve ao botão que a abriu.
  const botaoAbrir = useRef<HTMLButtonElement>(null), botaoAnexar = useRef<HTMLButtonElement>(null), campoBusca = useRef<HTMLInputElement>(null), campoPrevia = useRef<HTMLTextAreaElement>(null), itens = useRef(new Map<string, HTMLButtonElement>()), focarPrevia = useRef(false), focarBusca = useRef(false), origemAbertura = useRef<'prontas' | 'anexos'>('prontas');
  const { dados, erro, setErro, carregar } = useBiblioteca(aberta);
  const id = useId(), painel = `${id}-painel`, previa = `${id}-previa`;
  const favoritas = useMemo(() => new Set(dados?.favoritas ?? []), [dados]);
  const lista = useMemo(() => dados ? filtrarProntas(dados.prontas, { busca, categoria: categoria || null, favoritas: soFavoritas ? favoritas : null }).filter(p => !soAnexos || ehAnexo(p.tipo)) : [], [dados, busca, categoria, soFavoritas, soAnexos, favoritas]);
  const porAtalho = (a: Atalho) => dados?.prontas.find(p => p.atalho === a);
  // Trocar de conversa: invalida o pedido em andamento, descarta a prévia e o aviso (o link individual depende do contato).
  useEffect(() => {
    conversaAtual.current = conversaId; pedidoRascunho.current++; focarPrevia.current = false;
    const t = window.setTimeout(() => { setRascunho(null); setAvisoUso(null); setOcupado(false); }, 0);
    return () => window.clearTimeout(t);
  }, [conversaId]);
  // Mesmo antes do efeito acima rodar, só aparece a prévia da conversa aberta.
  const previaAtual = rascunho && rascunho.conversaId === conversaId ? rascunho : null;
  useEffect(() => { if (previaAtual && focarPrevia.current) { focarPrevia.current = false; campoPrevia.current?.focus(); } }, [previaAtual]);
  useEffect(() => { if (aberta && focarBusca.current && campoBusca.current) { focarBusca.current = false; campoBusca.current.focus(); } }, [aberta, dados]);

  async function preparar(p: Pronta) {
    if (ocupado) return;
    const pedido = ++pedidoRascunho.current, origem = conversaId;
    setOcupado(true); setErro(''); setAviso('');
    try {
      const r = await chamar<RascunhoServidor>({ acao: 'rascunho', id: p.id, conversaId: origem });
      if (pedido !== pedidoRascunho.current || origem !== conversaAtual.current) return;
      focarPrevia.current = true;
      setRascunho({ ...r, conversaId: origem, prontaId: p.id });
    } catch (e) { if (pedido === pedidoRascunho.current) setErro(e instanceof Error ? e.message : 'Não foi possível preparar o rascunho.'); }
    finally { if (pedido === pedidoRascunho.current) setOcupado(false); }
  }
  // Pedido da tela (sugestão do Wall-e): abre e prepara a prévia daquela pronta quando a biblioteca estiver carregada.
  const pedidoTela = useRef(0);
  useEffect(() => {
    if (!pedirPronta || pedirPronta.n === pedidoTela.current) return;
    const t = window.setTimeout(() => {
      if (!aberta) { setAberta(true); return; }
      if (!dados) return;
      pedidoTela.current = pedirPronta.n;
      const p = dados.prontas.find(x => x.id === pedirPronta.id);
      if (p) void preparar(p); else setErro('Esse material não está mais publicado na biblioteca.');
    }, 0);
    return () => window.clearTimeout(t);
  });
  function abrir(origem: 'prontas' | 'anexos') {
    if (aberta && origemAbertura.current === origem) { fechar(); return; }
    origemAbertura.current = origem; setSoAnexos(origem === 'anexos'); focarBusca.current = true; setAberta(true);
  }
  function fechar() { setAberta(false); (origemAbertura.current === 'anexos' ? botaoAnexar : botaoAbrir).current?.focus(); }
  function descartar() {
    const origem = previaAtual?.prontaId;
    setRascunho(null);
    (origem && itens.current.get(origem) || botaoAbrir.current)?.focus();
  }
  async function alternarFavorita(p: Pronta) {
    try { await chamar({ acao: 'favoritar', id: p.id, favorita: !favoritas.has(p.id) }); await carregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível atualizar a favorita.'); }
  }
  // Confere o vínculo de novo no clique: só a prévia da conversa aberta vai para a resposta, levando a origem junto.
  function usar() {
    const r = previaAtual;
    if (!r || !podeUsar || r.conversaId !== conversaAtual.current) return;
    const midia = r.midia ? { ...r.midia, titulo: r.titulo } : null;
    onUsar(r.texto, r.conversaId, midia); setRascunho(null); setAberta(false);
    setAviso(midia ? `${anexado(midia.tipo)} à resposta, com a legenda no campo. Revise e envie quando quiser.` : 'Rascunho colocado no campo de resposta. Revise e envie quando quiser.');
  }
  const recursos074 = dados?.recursos074 ?? false;
  // Atalho sem mensagem: um aviso por motivo, abaixo dos botões (seis avisos soltos entre os botões poluíam a linha).
  // Cada botão desabilitado aponta (aria-describedby) para o aviso do seu motivo.
  const motivoAtalho = (a: Atalho) => !recursos074 && ATALHOS_074.includes(a) ? 'indisponivel' : 'sem-cadastro';
  const semAtalho = (motivo: string) => ATALHOS.filter(a => !porAtalho(a) && motivoAtalho(a) === motivo).map(a => NOME_ATALHO[a]);
  const semCadastro = semAtalho('sem-cadastro'), indisponiveis = semAtalho('indisponivel');

  return <div className={styles.prontas}>
    <div className={styles.botoesProntas}>
      <button ref={botaoAnexar} type="button" aria-expanded={aberta && soAnexos} aria-controls={painel} onClick={() => abrir('anexos')}>Anexar arquivo</button>
      <button ref={botaoAbrir} type="button" aria-expanded={aberta} aria-controls={painel} onClick={() => abrir('prontas')}>{aberta ? 'Fechar mensagens prontas' : 'Mensagens prontas'}</button>
    </div>
    {aviso && <p role="status" className={styles.nota}>{aviso}</p>}
    {aberta && <section id={painel} className={styles.gaveta} role="dialog" aria-label="Mensagens prontas" aria-busy={ocupado || undefined} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); fechar(); } }}>
      <div className={styles.topoGaveta}><h2>{soAnexos ? 'Anexar da biblioteca' : 'Mensagens prontas'}</h2><button type="button" onClick={fechar}>Fechar</button></div>
      <p className={styles.nota}>Biblioteca da equipe. Nada é enviado sem você: escolher prepara uma prévia que você revisa.</p>
      {erro && <p className={styles.erro} role="alert">{erro}</p>}
      {!dados && !erro && <p aria-live="polite">Carregando mensagens prontas…</p>}
      {dados && <>
        {/* Durante o pedido os botões ficam aria-disabled (não disabled): desabilitar o botão em foco jogaria o foco para o topo da página. */}
        <div className={styles.atalhos} role="group" aria-label="Atalhos">
          {ATALHOS.map(a => { const p = porAtalho(a); return <button type="button" key={a} className={styles.atalho} disabled={!p} aria-disabled={ocupado || undefined} aria-describedby={p ? undefined : `${id}-${motivoAtalho(a)}`} onClick={() => p && void preparar(p)}>{NOME_ATALHO[a]}</button>; })}
        </div>
        {semCadastro.length > 0 && <p id={`${id}-sem-cadastro`} className={styles.nota}>Ainda sem mensagem cadastrada: {semCadastro.join(', ')}.</p>}
        {indisponiveis.length > 0 && <p id={`${id}-indisponivel`} className={styles.nota}>{indisponiveis.length === 1 ? 'Indisponível' : 'Indisponíveis'} neste ambiente: {indisponiveis.join(', ')}.</p>}
        <div className={styles.filtros}>
          <label>Buscar<input ref={campoBusca} type="search" value={busca} onChange={e => setBusca(e.target.value)} placeholder="Título, categoria ou texto" /></label>
          <label>Categoria<select value={categoria} onChange={e => setCategoria(e.target.value)}><option value="">Todas</option>{categorias(dados.prontas).map(c => <option key={c}>{c}</option>)}</select></label>
          <label className={styles.opcao}><input type="checkbox" checked={soFavoritas} onChange={e => setSoFavoritas(e.target.checked)} />Só favoritas</label>
          <label className={styles.opcao}><input type="checkbox" checked={soAnexos} onChange={e => setSoAnexos(e.target.checked)} />Só anexos</label>
        </div>
        <p className={styles.nota} aria-live="polite">{lista.length === 1 ? '1 mensagem' : `${lista.length} mensagens`}</p>
        <ul className={styles.listaProntas}>
          {lista.map(p => <li key={p.id}>
            <button ref={el => { if (el) itens.current.set(p.id, el); else itens.current.delete(p.id); }} type="button" className={styles.itemPronta} aria-disabled={ocupado || undefined} onClick={() => void preparar(p)}><strong>{p.titulo}</strong><span>{p.categoria} · {NOME_TIPO[p.tipo]}</span></button>
            <button type="button" className={styles.favorita} aria-pressed={favoritas.has(p.id)} aria-label={`Favorita: ${p.titulo}`} onClick={() => void alternarFavorita(p)}>{favoritas.has(p.id) ? '★' : '☆'}</button>
          </li>)}
        </ul>
        {!lista.length && <p>{dados.prontas.length ? 'Nenhuma mensagem com esse filtro.' : 'Nenhuma mensagem pronta publicada.'}</p>}
      </>}
      {previaAtual && <div className={styles.previa}>
        {previaAtual.midia && <p className={styles.anexo}><strong>{NOME_TIPO[previaAtual.midia.tipo]}</strong> desta mensagem pronta{previaAtual.midia.nome ? ` (${previaAtual.midia.nome})` : ''}: <a href={previaAtual.midia.url} target="_blank" rel="noopener noreferrer">conferir {previaAtual.midia.tipo === 'IMAGEM' ? 'a foto' : previaAtual.midia.tipo === 'VIDEO' ? 'o vídeo' : 'o PDF'} em nova aba</a>. O arquivo não muda aqui; só a legenda.</p>}
        <label htmlFor={previa}>{previaAtual.midia ? `Legenda de “${previaAtual.titulo}” (opcional, até ${LIMITE_LEGENDA} caracteres)` : `Prévia de “${previaAtual.titulo}” — edite antes de usar`}</label>
        <textarea ref={campoPrevia} id={previa} maxLength={previaAtual.midia ? LIMITE_LEGENDA : 4000} value={previaAtual.texto} onChange={e => setRascunho({ ...previaAtual, texto: e.target.value })} aria-describedby={previaAtual.aviso ? `${previa}-aviso` : undefined} />
        {previaAtual.aviso && <p id={`${previa}-aviso`} role="status" className={styles.fila}>{previaAtual.aviso}</p>}
        {previaAtual.linkIndividual === 'PREENCHIDO' && <p className={styles.nota}>Link individual preenchido pelo fluxo de contratação deste cliente.</p>}
        <div className={styles.acoes}>
          <button type="button" className={styles.primario} disabled={!podeUsar || (!previaAtual.midia && !previaAtual.texto.trim())} onClick={usar}>{previaAtual.midia ? 'Anexar à resposta' : textoAtual.trim() ? 'Substituir a resposta' : 'Colocar na resposta'}</button>
          <button type="button" onClick={descartar}>Descartar prévia</button>
        </div>
        {!podeUsar && motivoBloqueio && <p>{motivoBloqueio}</p>}
        <p className={styles.nota}>{previaAtual.midia ? `O envio continua sendo pelo botão “Enviar ${NOME_ANEXO[previaAtual.midia.tipo].nome.toLowerCase().replace('pdf', 'PDF')}”, na resposta.` : 'O envio continua sendo pelo botão “Enviar resposta”.'}</p>
      </div>}
    </section>}
  </div>;
}

type EdicaoPronta = {
  id?: string; versao?: number; titulo: string; categoria: string; tipo: TipoPronta; texto: string; link: string; midiaUrl: string; atalho: Atalho | '';
  estado: Exclude<EstadoPronta, 'ARQUIVADA'>; envioAutomatico: boolean; finalidade: Finalidade | ''; pacoteCodigo: string; estabelecimentoId: string; arquivo: ArquivoPronta | null;
};
const vazia = (): EdicaoPronta => ({ titulo: '', categoria: '', tipo: 'TEXTO', texto: '', link: '', midiaUrl: '', atalho: '', estado: 'PUBLICADA', envioAutomatico: false, finalidade: '', pacoteCodigo: '', estabelecimentoId: '', arquivo: null });
const ACEITA: Record<TipoAnexo, string> = { IMAGEM: 'image/jpeg,image/png', VIDEO: 'video/mp4,video/3gpp', DOCUMENTO: 'application/pdf' };
const tamanho = (n: number) => n >= 1048576 ? `${(n / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * Cadastro da biblioteca (representante): textos, links, fotos, vídeos e PDFs; rascunho, publicada e arquivada; finalidade
 * e a autorização explícita para o Wall-e enviar sozinho; vínculo opcional com pacote e unidade. Arquivos são enviados
 * aqui (validados no servidor pelo conteúdo, tipo e tamanho). `pagina`: tela própria da biblioteca (carrega ao abrir,
 * mostra todos os estados); sem ela, o bloco recolhível da fase B.
 */
export function GerenciarMensagensProntas({ pagina = false }: { pagina?: boolean } = {}) {
  const [aberta, setAberta] = useState(pagina), [edicao, setEdicao] = useState<EdicaoPronta | null>(null), [ocupado, setOcupado] = useState(false), [aviso, setAviso] = useState(''), [enviando, setEnviando] = useState(false);
  const [filtroEstado, setFiltroEstado] = useState<EstadoPronta | ''>(''), [busca, setBusca] = useState('');
  const { dados, erro, setErro, carregar } = useBiblioteca(aberta, pagina);
  const id = useId();
  // Foco: abrir cadastro/edição vai ao Título; salvar/cancelar volta ao "Editar" do item (ou a "Nova mensagem pronta");
  // arquivar volta a "Nova mensagem pronta". O alvo é resolvido depois da renderização (o formulário e a lista mudam).
  const resumo = useRef<HTMLElement>(null), botaoNova = useRef<HTMLButtonElement>(null), campoTitulo = useRef<HTMLInputElement>(null), botoesEditar = useRef(new Map<string, HTMLButtonElement>());
  const focoPendente = useRef<{ alvo: 'titulo' } | { alvo: 'nova' } | { alvo: 'editar'; id: string } | null>(null);
  useEffect(() => {
    const f = focoPendente.current;
    if (!f) return;
    const el = f.alvo === 'titulo' ? campoTitulo.current : (f.alvo === 'editar' ? botoesEditar.current.get(f.id) : null) ?? botaoNova.current ?? resumo.current;
    if (!el) return;
    focoPendente.current = null;
    el.focus();
  });
  const r075 = dados?.recursos075 ?? false;
  function abrir(e: EdicaoPronta) { setErro(''); setAviso(''); setEdicao(e); focoPendente.current = { alvo: 'titulo' }; }
  function fechar() { const origem = edicao?.id; setEdicao(null); focoPendente.current = origem ? { alvo: 'editar', id: origem } : { alvo: 'nova' }; }
  async function salvar() {
    if (!edicao || ocupado) return; setOcupado(true); setErro(''); setAviso('');
    const { link, midiaUrl, atalho, arquivo, estado, envioAutomatico, finalidade, pacoteCodigo, estabelecimentoId, ...resto } = edicao;
    const anexoProprio = ehAnexo(edicao.tipo) && !!arquivo;
    const pronta = { ...resto, link: edicao.tipo === 'LINK' ? link.trim() : null, midiaUrl: ehMidia(edicao.tipo) && !anexoProprio ? midiaUrl.trim() : null, atalho: atalho || null,
      ...(r075 ? { estado, envioAutomatico, finalidade: finalidade || null, pacoteCodigo: pacoteCodigo || null, estabelecimentoId: estabelecimentoId || null, arquivoId: anexoProprio ? arquivo!.id : null } : {}) };
    try { await chamar({ acao: 'salvar', pronta }); await carregar(); fechar(); setAviso('Mensagem pronta salva.'); }
    catch (e) { setErro(e instanceof Error ? e.message : 'Confira os campos.'); } finally { setOcupado(false); }
  }
  async function arquivar(p: Pronta) {
    if (ocupado || !window.confirm(`${r075 ? 'Arquivar' : 'Remover'} “${p.titulo}”? Novos usos ficam bloqueados; conversas já enviadas não mudam.`)) return;
    setOcupado(true); setErro(''); setAviso('');
    try { await chamar({ acao: 'arquivar', id: p.id, versao: p.versao }); await carregar(); focoPendente.current = { alvo: 'nova' }; setAviso(r075 ? 'Mensagem arquivada.' : 'Mensagem removida da biblioteca.'); }
    catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível remover.'); } finally { setOcupado(false); }
  }
  async function publicar(p: Pronta, publicarAgora: boolean) {
    if (ocupado) return; setOcupado(true); setErro(''); setAviso('');
    try { await chamar({ acao: 'publicar', id: p.id, versao: p.versao, publicar: publicarAgora }); await carregar(); focoPendente.current = { alvo: 'editar', id: p.id }; setAviso(publicarAgora ? `“${p.titulo}” publicada.` : `“${p.titulo}” voltou para rascunho.`); }
    catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível mudar o estado.'); } finally { setOcupado(false); }
  }
  async function enviarArquivo(arquivo: File | undefined) {
    if (!edicao || !arquivo || enviando || !ehAnexo(edicao.tipo)) return;
    setEnviando(true); setErro('');
    try {
      const corpo = new FormData(); corpo.append('arquivo', arquivo, arquivo.name);
      const r = await adminFetch(`/api/admin/atendimento/arquivos?tipo=${edicao.tipo}`, { method: 'POST', body: corpo });
      const json = await r.json();
      if (!r.ok || !json.ok) throw Error(json.erro || 'Não foi possível enviar o arquivo.');
      setEdicao(atual => atual && { ...atual, arquivo: json.data as ArquivoPronta, midiaUrl: '' });
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível enviar o arquivo.'); } finally { setEnviando(false); }
  }
  const lista = useMemo(() => (dados?.prontas ?? []).filter(p => (!filtroEstado || (p.estado ?? 'PUBLICADA') === filtroEstado) && (!busca || filtrarProntas([p], { busca, categoria: null, favoritas: null }).length)), [dados, filtroEstado, busca]);
  const editar = (p: Pronta) => abrir({ id: p.id, versao: p.versao, titulo: p.titulo, categoria: p.categoria, tipo: p.tipo, texto: p.texto, link: p.link ?? '', midiaUrl: p.midia_url ?? '', atalho: p.atalho ?? '',
    estado: p.estado === 'RASCUNHO' ? 'RASCUNHO' : 'PUBLICADA', envioAutomatico: p.envio_automatico ?? false, finalidade: p.finalidade ?? '', pacoteCodigo: p.pacote_codigo ?? '', estabelecimentoId: p.estabelecimento_id ?? '', arquivo: p.arquivo ?? null });

  const conteudo = <>
    {pagina ? <p>Textos, links, fotos, vídeos e PDFs que a equipe usa nas conversas. O Wall-e só envia sozinho o que estiver <strong>publicado</strong> e com <strong>envio automático autorizado</strong>; rascunhos nunca saem.</p>
      : <p>Textos, links, fotos e vídeos que o atendente escolhe, revisa e envia. Não são respostas da IA nem automações. Links individuais de fechamento não são digitados: vêm do fluxo de contratação do cliente.</p>}
    {dados && !dados.recursos074 && <p className={styles.nota}>Fotos, vídeos e os atalhos de salgados, bolos, endereço e localização ficam disponíveis depois da atualização deste ambiente.</p>}
    {dados && dados.recursos074 && !r075 && pagina && <p className={styles.nota}>PDF, envio de arquivos, rascunho e envio automático pelo Wall-e ficam disponíveis depois da atualização deste ambiente (migration 075).</p>}
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {aviso && <p role="status">{aviso}</p>}
    {dados && !dados.podeGerenciar && <p>Só o representante autorizado cadastra mensagens prontas.</p>}
    {dados?.podeGerenciar && !edicao && <button ref={botaoNova} type="button" onClick={() => abrir(vazia())}>Nova mensagem pronta</button>}
    {edicao && <form onSubmit={e => { e.preventDefault(); void salvar(); }} aria-label={edicao.id ? 'Editar mensagem pronta' : 'Nova mensagem pronta'} aria-busy={ocupado || undefined} className={pagina ? styles.formBiblioteca : undefined}>
      <label>Título<input ref={campoTitulo} required minLength={2} maxLength={80} value={edicao.titulo} onChange={e => setEdicao({ ...edicao, titulo: e.target.value })} /></label>
      <label>Categoria<input required minLength={2} maxLength={40} list={`${id}-categorias`} value={edicao.categoria} onChange={e => setEdicao({ ...edicao, categoria: e.target.value })} /></label>
      <datalist id={`${id}-categorias`}>{categorias(dados?.prontas ?? []).map(c => <option key={c} value={c} />)}</datalist>
      <label>Tipo<select value={edicao.tipo} onChange={e => setEdicao({ ...edicao, tipo: e.target.value as TipoPronta, link: '', midiaUrl: '', arquivo: null })}>{TIPOS.map(t => { const off = (ehMidia(t) && !dados?.recursos074) || (t === 'DOCUMENTO' && !r075); return <option key={t} value={t} disabled={off}>{NOME_TIPO[t]}{off ? ' (indisponível neste ambiente)' : ''}</option>; })}</select></label>
      {ehAnexo(edicao.tipo) && r075 && <div className={styles.campoArquivo}>
        <label>{edicao.arquivo ? 'Trocar arquivo' : `Arquivo ${edicao.tipo === 'IMAGEM' ? 'da foto' : edicao.tipo === 'VIDEO' ? 'do vídeo' : 'PDF'}`}<input type="file" accept={ACEITA[edicao.tipo as TipoAnexo]} aria-busy={enviando || undefined} onChange={e => void enviarArquivo(e.target.files?.[0])} /></label>
        {enviando && <p aria-live="polite">Enviando arquivo…</p>}
        {edicao.arquivo && <p className={styles.anexo}><strong>{edicao.arquivo.nome}</strong> · {tamanho(edicao.arquivo.tamanho)} · <a href={edicao.arquivo.caminho} target="_blank" rel="noopener noreferrer">conferir em nova aba</a></p>}
      </div>}
      {ehMidia(edicao.tipo) && !edicao.arquivo && <label>{r075 ? 'Ou link ' : 'Link '}{edicao.tipo === 'IMAGEM' ? 'da foto' : 'do vídeo'} (https público)<input type="url" required={!r075} inputMode="url" placeholder="https://" value={edicao.midiaUrl} aria-describedby={`${id}-requisito`} onChange={e => setEdicao({ ...edicao, midiaUrl: e.target.value })} /></label>}
      {ehMidia(edicao.tipo) && <p id={`${id}-requisito`}>{REQUISITO_MIDIA[edicao.tipo as TipoMidia]} Use só imagens e vídeos da própria empresa.</p>}
      {edicao.tipo === 'DOCUMENTO' && <p>PDF até 16 MB, enviado aqui. O cliente recebe o arquivo com o nome mostrado acima.</p>}
      <label>{ehAnexo(edicao.tipo) ? `Legenda (até ${LIMITE_LEGENDA} caracteres)` : 'Texto'}<textarea required maxLength={ehAnexo(edicao.tipo) ? LIMITE_LEGENDA : 4000} value={edicao.texto} onChange={e => setEdicao({ ...edicao, texto: e.target.value })} /></label>
      {edicao.tipo === 'LINK' && <label>Link (https)<input type="url" required inputMode="url" placeholder="https://" value={edicao.link} onChange={e => setEdicao({ ...edicao, link: e.target.value })} /></label>}
      {edicao.tipo === 'LINK_FECHAMENTO_INDIVIDUAL' && <p>O link é preenchido na prévia só quando o telefone da conversa corresponde a um único cliente desta empresa, com um único contrato aguardando a assinatura dele.</p>}
      <label>Atalho<select value={edicao.atalho} onChange={e => setEdicao({ ...edicao, atalho: e.target.value as Atalho | '' })}><option value="">Nenhum</option>{ATALHOS.map(a => <option key={a} value={a} disabled={ATALHOS_074.includes(a) && !dados?.recursos074}>{NOME_ATALHO[a]}{ATALHOS_074.includes(a) && !dados?.recursos074 ? ' (indisponível neste ambiente)' : ''}</option>)}</select></label>
      {edicao.atalho === 'LOCALIZACAO' && !ehMidia(edicao.tipo) && <p>Localização: use o tipo Link com o endereço do mapa (https), ou Texto com o endereço completo.</p>}
      {r075 && <fieldset className={styles.grupoWallE}><legend>Uso pelo Wall-e</legend>
        <label>Finalidade<select value={edicao.finalidade} onChange={e => setEdicao({ ...edicao, finalidade: e.target.value as Finalidade | '', envioAutomatico: e.target.value ? edicao.envioAutomatico : false })}><option value="">Nenhuma (só a equipe usa)</option>{FINALIDADES.map(f => <option key={f} value={f}>{NOME_FINALIDADE[f]}</option>)}</select></label>
        <label className={styles.opcao}><input type="checkbox" disabled={!edicao.finalidade || edicao.tipo === 'LINK_FECHAMENTO_INDIVIDUAL'} checked={edicao.envioAutomatico} onChange={e => setEdicao({ ...edicao, envioAutomatico: e.target.checked })} />Wall-e pode enviar automaticamente</label>
        <p className={styles.nota}>Só vale quando a mensagem está publicada. Sem esta marcação o Wall-e nunca envia este conteúdo.</p>
        <label>Pacote (opcional)<select value={edicao.pacoteCodigo} onChange={e => setEdicao({ ...edicao, pacoteCodigo: e.target.value })}><option value="">Todos os pacotes</option>{(dados?.pacotes ?? []).map(p => <option key={p.codigo} value={p.codigo}>{p.nome}</option>)}</select></label>
        <label>Unidade (opcional)<select value={edicao.estabelecimentoId} onChange={e => setEdicao({ ...edicao, estabelecimentoId: e.target.value })}><option value="">Todas as unidades</option>{(dados?.unidades ?? []).map(u => <option key={u.id} value={u.id}>{u.nome}</option>)}</select></label>
        <label>Estado ao salvar<select value={edicao.estado} onChange={e => setEdicao({ ...edicao, estado: e.target.value as EdicaoPronta['estado'] })}><option value="PUBLICADA">Publicada (equipe e Wall-e, se autorizado)</option><option value="RASCUNHO">Rascunho (ninguém usa ainda)</option></select></label>
      </fieldset>}
      <div className={styles.acoes}><button type="submit" className={styles.primario} aria-disabled={ocupado || undefined}>Salvar mensagem pronta</button><button type="button" onClick={fechar}>Cancelar</button></div>
    </form>}
    {dados && pagina && <div className={styles.filtros}>
      <label>Buscar<input type="search" value={busca} onChange={e => setBusca(e.target.value)} placeholder="Título, categoria ou texto" /></label>
      <label>Estado<select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value as EstadoPronta | '')}><option value="">Todos</option>{(['PUBLICADA', 'RASCUNHO', 'ARQUIVADA'] as const).map(s => <option key={s} value={s}>{NOME_ESTADO_PRONTA[s]}</option>)}</select></label>
    </div>}
    {dados && <ul className={styles.listaProntas} data-pagina={pagina || undefined}>{lista.map(p => { const estado = p.estado ?? 'PUBLICADA'; return <li key={p.id}>
      <span className={styles.itemPronta}><strong>{p.titulo}</strong><span>{p.categoria} · {NOME_TIPO[p.tipo]}{p.atalho ? ' · atalho ' + NOME_ATALHO[p.atalho] : ''}{r075 ? ` · ${NOME_ESTADO_PRONTA[estado]} · versão ${p.versao}` : ''}{p.finalidade ? ` · ${NOME_FINALIDADE[p.finalidade]}` : ''}{p.envio_automatico ? ' · Wall-e envia sozinho' : ''}{p.arquivo ? ` · ${p.arquivo.nome}` : ''}</span></span>
      {dados.podeGerenciar && estado !== 'ARQUIVADA' && <span className={styles.acoes}><button ref={el => { if (el) botoesEditar.current.set(p.id, el); else botoesEditar.current.delete(p.id); }} type="button" onClick={() => editar(p)}>Editar<span className={styles.oculto}> {p.titulo}</span></button>
        {r075 && <button type="button" onClick={() => void publicar(p, estado === 'RASCUNHO')}>{estado === 'RASCUNHO' ? 'Publicar' : 'Voltar para rascunho'}<span className={styles.oculto}> {p.titulo}</span></button>}
        <button type="button" onClick={() => void arquivar(p)}>{r075 ? 'Arquivar' : 'Remover'}<span className={styles.oculto}> {p.titulo}</span></button></span>}
    </li>; })}</ul>}
    {dados && !lista.length && <p>{dados.prontas.length ? 'Nenhuma mensagem com esse filtro.' : 'Nenhuma mensagem pronta cadastrada.'}</p>}
  </>;
  if (pagina) return <section className={styles.painel} aria-labelledby={`${id}-titulo`} aria-busy={ocupado || undefined}><h2 id={`${id}-titulo`} ref={resumo as RefObject<HTMLHeadingElement>} tabIndex={-1}>Biblioteca</h2>{conteudo}</section>;
  return <details className={styles.painel} onToggle={e => setAberta((e.target as HTMLDetailsElement).open)}>
    <summary ref={resumo}>Mensagens prontas da equipe (cadastro)</summary>
    {conteudo}
  </details>;
}
