'use client';
/* eslint-disable @next/next/no-img-element */
/**
 * Logo do buffet no editor (plano etapa 3 r15.1, §4, §5 e §6). Toda escrita da logo passa pela fila (`filaDaLogo`):
 * o rascunho de textos nunca leva a logo, e salvar/publicar mantêm o que está gravado. A tela mostra o gravado com as
 * intenções da fila por cima. r4 (Astra r3; Felipe 16/11: "Cortar releitura"): a logo é lida só na carga do convite
 * (ConviteEditor, com destino, limite e cancelamento). A base é essa leitura mais as confirmações desta aba posteriores
 * ao início dela; não há releitura automática nem espera pela fila.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { filaDaLogo, type EstadoFilaLogo, type FilaLogo, type PosicaoLogoEnvio } from '@/lib/convites/fila-logo';
import { analisarArte, LIMIAR_SEM_LUGAR, pontuacaoNaPosicao, sugerirPosicaoLogo, type AnaliseArte, type PosicaoLogo } from '@/lib/convites/posicao-logo';
import type { CaixaPct, PosicaoSobre, SobreArte } from './ConviteArte';
import {
  anuncioPosicao, arrastarLogo, chaveDaCaixa, incorporarConfirmados, limitarAoExibido, AVISO_COBRINDO, AVISO_PERMANENTE_SOBRE, AVISO_PREVIA_NAO_PUBLICADA, AVISO_SEM_LUGAR, avisoOrigem, avisoSemNome,
  LUGARES_LOGO, logoEfetiva, logoLigadaParaGerar, moverLogo, passoDaTecla, PASSO_SETA, TAMANHOS_LOGO, TEXTO_SITUACAO_FILA,
  type EntradaLogo, type LogoLocal,
} from './logo-editor';
import styles from './convites.module.css';

/** O que a leitura do editor traz da logo (rota do buffet). */
export type LeituraLogo = {
  id?: string; laboratorioLocal?: boolean; publicadoArteId?: string | null;
  conteudo: { logoPosicoes?: Record<string, PosicaoLogo>; logoSemNome?: string[]; logoBuffet?: boolean };
  logoBuffet?: { mostrar: boolean; logoDataUrl: string | null } | null;
};
type Gravada = LogoLocal & { semNome: string[]; publicadoArteId: string | null; conviteId: string | null };
type Pixels = { rgba: Uint8ClampedArray; W: number; H: number };

async function pixels(src: string): Promise<Pixels | null> {
  const img = new Image(); img.src = src;
  try { await img.decode(); } catch { return null; }
  const W = img.naturalWidth, H = img.naturalHeight;
  if (!(W > 0 && H > 0)) return null;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  try { return { rgba: ctx.getImageData(0, 0, W, H).data, W, H }; } catch { return null; }
}

const SEM_LOGO: Gravada = { mostrar: false, posicoes: {}, semNome: [], publicadoArteId: null, conviteId: null };
function daLeitura(d: LeituraLogo, conviteId: string): Gravada {
  return { mostrar: !!d.logoBuffet?.mostrar, posicoes: { ...(d.conteudo.logoPosicoes ?? {}) }, semNome: [...(d.conteudo.logoSemNome ?? [])], publicadoArteId: d.publicadoArteId ?? null, conviteId };
}

export type LogoNoConvite = {
  /** Aplica os campos da logo de uma carga; `antes` = `confirmadosDasFilas()` tirado antes do pedido. */
  aplicarLeitura(d: LeituraLogo, antes: ReadonlyMap<string, number>): void;
  /** §4: valor de `logoLigada` para `gerar` (espera o `mostrar` até 5 s); null = não gerar. */
  logoLigada(esperando?: () => void): Promise<boolean | null>;
  esquecerArte(arteId: string): void;
  /** Para o ConviteArte da prévia. */
  sobre: SobreArte | null;
  /** Para o download: logo da faixa (ou da sobreposição) e posição sobre a arte, quando a regra vale. */
  baixar: { logo: string | null; sobre: PosicaoSobre | null };
  /** Logo no rodapé, logo abaixo da prévia (quando não está sobre a arte). */
  previa: ReactNode;
  /** Opção "Mostrar a logo" e ajustes: bloco recolhível, discreto, no fim da coluna da prévia. */
  painel: ReactNode;
};

/**
 * `ativo`: editor do buffet, fora do laboratório, com convite carregado. `conteudo` traz só o que a regra de exibição usa.
 */
export function useLogoNoConvite({ ativo, conviteId, logoDataUrl, publicado, conteudo, arteUrl, busy, ui }: {
  ativo: boolean; conviteId?: string; logoDataUrl: string | null; publicado: boolean;
  conteudo: { arteId?: string | null; visual?: { modo: 'modelo' | 'completa' } | null } | null; arteUrl?: string;
  busy: boolean; ui: Record<string, string>;
}): LogoNoConvite {
  // Começa fechado em qualquer largura; abrir ou fechar não grava nada.
  const [painelAberto, setPainelAberto] = useState(false);
  // r2 (Astra r1, P1): o endereço da fila nasce do id do convite dentro de filaDaLogo.
  const fila: FilaLogo | null = ativo && conviteId ? filaDaLogo(conviteId) : null;
  const [gravada, setGravada] = useState<Gravada>(SEM_LOGO);
  const [estadoFila, setEstadoFila] = useState<EstadoFilaLogo | null>(null);
  const [arraste, setArraste] = useState<PosicaoLogoEnvio | null>(null);
  const [anuncio, setAnuncio] = useState('');
  const [semLugar, setSemLugar] = useState<string | null>(null);
  const [sugerindo, setSugerindo] = useState(false);
  const [cobrindo, setCobrindo] = useState(false);
  const [falhaSugestao, setFalhaSugestao] = useState('');
  const [avisoDesligar, setAvisoDesligar] = useState<string | null>(null);
  // r3 (Astra r2, P3): caixa exibida, registrada pela camada depois do commit (nunca durante o render).
  const [caixaExibida, setCaixaExibida] = useState<{ chave: string; caixa: CaixaPct } | null>(null);
  const analises = useRef(new Map<string, AnaliseArte>()), proporcaoLogo = useRef<number | null>(null);
  // r4 (Astra r3, P3): o arraste guarda a chave da geometria do início; se a entrada mudar de largura, fundo ou arte, cancela.
  const inicioArraste = useRef<{ pos: PosicaoLogoEnvio; chave: string; px: number; py: number; w: number; h: number; id: number } | null>(null);
  // Base = última leitura aceita (deste convite) + só o que a fila confirmou depois dela (número da confirmação).
  const confirmacaoIncorporada = useRef<{ conviteId: string; n: number } | null>(null);
  // r2 (Astra r1, P2): versão por arte das intenções desta tela; a sugestão só vale se nada mudou na arte enquanto lia as imagens.
  const versaoArte = useRef(new Map<string, number>());

  useEffect(() => {
    if (!fila) return;
    const aplicar = (e: EstadoFilaLogo) => {
      setEstadoFila(e);
      const base = confirmacaoIncorporada.current;
      // Sem leitura aceita deste convite não há base: nada de reaplicar confirmações antigas.
      if (base && base.conviteId === conviteId && e.confirmados.n > base.n) {
        const desde = base.n;
        confirmacaoIncorporada.current = { conviteId: base.conviteId, n: e.confirmados.n };
        setGravada(g => g.conviteId === base.conviteId ? incorporarConfirmados(g, e.confirmados, desde) : g);
      }
    };
    aplicar(fila.estado());
    const sair = fila.assinar(aplicar);
    return () => { sair(); fila.drenar(); };
  }, [fila, conviteId]);

  // A carga vem do ConviteEditor (só a última vale). Base = leitura + confirmações desta aba depois do início dela.
  const aplicarLeitura = useCallback((d: LeituraLogo, antes: ReadonlyMap<string, number>) => {
    if (!d.logoBuffet || d.laboratorioLocal || !d.id) return;
    const conf = filaDaLogo(d.id).estado().confirmados;
    confirmacaoIncorporada.current = { conviteId: d.id, n: conf.n };
    setGravada(incorporarConfirmados(daLeitura(d, d.id), conf, antes.get(d.id) ?? 0));
  }, []);

  // Até a primeira leitura aceita deste convite, a base é vazia e os controles ficam parados (fila drenando ao reabrir).
  const carregada = !!conviteId && gravada.conviteId === conviteId;
  const carregadaRef = useRef(carregada); useEffect(() => { carregadaRef.current = carregada; });
  const efetiva = logoEfetiva(carregada ? gravada : SEM_LOGO, estadoFila);
  const efetivaRef = useRef(efetiva); useEffect(() => { efetivaRef.current = efetiva; });
  const arteId = conteudo?.arteId ?? null;
  const completa = conteudo?.visual?.modo === 'completa' && !!arteId && !!arteUrl;
  const entrada: EntradaLogo | null = arteId ? efetiva.posicoes[arteId] ?? null : null;
  const temLogo = !!logoDataUrl;
  const sobreValendo = ativo && temLogo && efetiva.mostrar && completa && entrada?.modo === 'sobre';
  const superada = estadoFila?.situacao === 'superada';
  const bloqueado = busy || superada || !carregada;
  // r4 (Astra r3, P3): o arraste só aparece enquanto tem a geometria (arte, largura, fundo) da entrada atual.
  const posicaoMostrada = sobreValendo && entrada ? (arraste && chaveDaCaixa(arraste) === chaveDaCaixa(entrada) ? arraste : entrada) : null;

  // beforeunload: intenção na fila ou arraste em curso (§5).
  useEffect(() => {
    if (!fila) return;
    const sair = (e: BeforeUnloadEvent) => { if (fila.temPendencia() || inicioArraste.current) e.preventDefault(); };
    window.addEventListener('beforeunload', sair); return () => window.removeEventListener('beforeunload', sair);
  }, [fila]);

  async function prepararAnalise(id: string, url: string) {
    if (analises.current.has(id) && proporcaoLogo.current) return analises.current.get(id)!;
    const [a, l] = await Promise.all([pixels(url), logoDataUrl ? pixels(logoDataUrl) : null]);
    if (!a || !l) return null;
    proporcaoLogo.current = l.W / l.H;
    const analise = analisarArte(a); analises.current.set(id, analise);
    return analise;
  }

  function caixaDe(p: PosicaoLogoEnvio) {
    return caixaExibida && caixaExibida.chave === chaveDaCaixa(p) ? caixaExibida.caixa : null;
  }
  const aoCaixa = useCallback((chave: string, caixa: CaixaPct | null) => {
    setCaixaExibida(a => caixa ? (a && a.chave === chave && a.caixa.left === caixa.left && a.caixa.top === caixa.top && a.caixa.width === caixa.width && a.caixa.height === caixa.height ? a : { chave, caixa }) : (a?.chave === chave ? null : a));
  }, []);
  const caixaPronta = !!entrada && entrada.modo === 'sobre' && !!caixaDe(entrada);
  function enviar(p: PosicaoLogoEnvio, adiar = false) {
    if (!fila || superada) return;
    versaoArte.current.set(p.arteId, (versaoArte.current.get(p.arteId) ?? 0) + 1);
    fila.posicao(p, adiar ? { adiar: true } : undefined);
    setAnuncio(anuncioPosicao(p));
  }

  async function colocarSobre() {
    if (!fila || !arteId || !arteUrl || !logoDataUrl) return;
    setSugerindo(true); setFalhaSugestao(''); setSemLugar(null);
    const versao = versaoArte.current.get(arteId) ?? 0;
    try {
      const [a, l] = await Promise.all([pixels(arteUrl), pixels(logoDataUrl)]);
      // Uma intenção posterior para a mesma arte (faixa, mover, tamanho) vence a sugestão atrasada.
      if ((versaoArte.current.get(arteId) ?? 0) !== versao) return;
      if (!a || !l) { setFalhaSugestao('Não foi possível ler a arte ou a logo. Tente de novo.'); return; }
      proporcaoLogo.current = l.W / l.H;
      const analise = analisarArte(a); analises.current.set(arteId, analise);
      const s = sugerirPosicaoLogo(a, { rgba: l.rgba, wl: l.W, hl: l.H }, analise);
      // A posição atual mantém o tamanho escolhido quando já existe uma entrada "sobre".
      const largura = entrada?.modo === 'sobre' ? entrada.largura : s.largura;
      enviar({ modo: 'sobre', arteId, x: s.x, y: s.y, largura, fundo: s.fundo });
      setSemLugar(s.semLugarLivre ? arteId : null);
    } finally { setSugerindo(false); }
  }

  function mover(dx: number, dy: number, adiar: boolean) {
    if (!entrada || entrada.modo !== 'sobre') return;
    const caixa = caixaDe(entrada);
    if (!caixa) return;
    enviar(limitarAoExibido(moverLogo(limitarAoExibido(entrada, caixa), dx, dy), caixa), adiar);
  }

  // ---------------------------------------------------------------- arraste (§6)
  function inicio(e: ReactPointerEvent<HTMLButtonElement>) {
    if (bloqueado || !entrada || entrada.modo !== 'sobre' || e.button !== 0 || !caixaDe(entrada)) return;
    const camada = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!camada) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    inicioArraste.current = { pos: limitarAoExibido(entrada, caixaDe(entrada)), chave: chaveDaCaixa(entrada), px: e.clientX, py: e.clientY, w: camada.width, h: camada.height, id: e.pointerId };
    setArraste(inicioArraste.current.pos); setCobrindo(false);
    if (arteId && arteUrl) void prepararAnalise(arteId, arteUrl);
  }
  /** r4 (Astra r3, P3): a entrada atual ainda tem a geometria do início do arraste? */
  function mesmaGeometria(chave: string) {
    // r5 (Astra r4, P3): a `entrada` deste render (o handler é sempre o do último commit), não uma ref de efeito.
    return !!entrada && entrada.modo === 'sobre' && chaveDaCaixa(entrada) === chave;
  }
  function movimento(e: ReactPointerEvent<HTMLButtonElement>) {
    const i = inicioArraste.current; if (!i || i.id !== e.pointerId) return;
    if (!mesmaGeometria(i.chave)) { cancelar(); return; }
    const p = limitarAoExibido(arrastarLogo(i.pos, e.clientX - i.px, e.clientY - i.py, i.w, i.h), caixaDe(i.pos));
    setArraste(p);
    const analise = arteId ? analises.current.get(arteId) : undefined;
    setCobrindo(!!analise && !!proporcaoLogo.current && pontuacaoNaPosicao(analise, p, proporcaoLogo.current) > LIMIAR_SEM_LUGAR);
  }
  function fim(e: ReactPointerEvent<HTMLButtonElement>) {
    const i = inicioArraste.current; if (!i || i.id !== e.pointerId) return;
    if (!mesmaGeometria(i.chave)) { cancelar(); return; }
    const p = limitarAoExibido(arrastarLogo(i.pos, e.clientX - i.px, e.clientY - i.py, i.w, i.h), caixaDe(i.pos));
    inicioArraste.current = null; setArraste(null);
    if (p.x !== i.pos.x || p.y !== i.pos.y) enviar(p);
  }
  function cancelar() { inicioArraste.current = null; setArraste(null); setCobrindo(false); }
  function tecla(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'Escape' && inicioArraste.current) { e.preventDefault(); cancelar(); return; }
    const passo = passoDaTecla(e.key, e.shiftKey);
    if (!passo || bloqueado) return;
    e.preventDefault(); mover(passo.dx, passo.dy, true);
  }

  const controle = (caixa: CaixaPct) => {
    return <button type="button" className={styles.controleLogo} aria-label="Logo do buffet sobre a arte" aria-describedby="logo-controle-ajuda"
    data-arrastando={!!arraste} disabled={bloqueado}
    style={{ left: `${caixa.left + caixa.width / 2}%`, top: `${caixa.top + caixa.height / 2}%`, width: `${caixa.width}%`, height: `${caixa.height}%` }}
    onPointerDown={inicio} onPointerMove={movimento} onPointerUp={fim} onPointerCancel={cancelar} onLostPointerCapture={e => { if (inicioArraste.current?.id === e.pointerId) cancelar(); }}
    onKeyDown={tecla} />;
  };

  const sobre: SobreArte | null = posicaoMostrada && logoDataUrl
    ? { logo: logoDataUrl, posicao: { x: posicaoMostrada.x, y: posicaoMostrada.y, largura: posicaoMostrada.largura, fundo: posicaoMostrada.fundo }, controle, chave: chaveDaCaixa(posicaoMostrada), aoCaixa }
    : null;

  // Sem leitura aceita, o valor da tela não é o gravado: não gera (o editor mostra o aviso).
  const logoLigada = useCallback(async (esperando?: () => void) => {
    const v = await logoLigadaParaGerar(fila, () => efetivaRef.current.mostrar, esperando);
    return v !== null && !carregadaRef.current ? null : v;
  }, [fila]);
  const esquecerArte = useCallback((id: string) => { fila?.esquecerArte(id); analises.current.delete(id); }, [fila]);

  function mudarMostrar(v: boolean) {
    if (!fila) return;
    fila.mostrar(v);
    setAvisoDesligar(v ? null : avisoSemNome(arteId, gravada.publicadoArteId, gravada.semNome));
  }

  const situacao = estadoFila && estadoFila.situacao !== 'ocioso' ? estadoFila.situacao : null;
  const logoAparecendo = efetiva.mostrar && temLogo;
  const controles = <>
    <label className={ui.check}><input type="checkbox" checked={logoAparecendo} disabled={bloqueado || !temLogo} aria-describedby="logo-buffet-nota" onChange={e => mudarMostrar(e.target.checked)} />
      Mostrar a logo do buffet neste convite</label>
    <small id="logo-buffet-nota">{!temLogo
      ? <>Envie uma logo no <Link href="/admin/configuracoes/perfil-empresa">Perfil da empresa</Link> para mostrar neste convite.</>
      : sobreValendo ? 'A logo fica sobre a arte, na página do convite e na imagem baixada. Vale na hora, mesmo depois de publicado.'
        : 'Aparece no rodapé da página do convite e numa faixa abaixo da arte na imagem baixada. A arte não muda. Vale na hora, mesmo depois de publicado.'}</small>
    {avisoDesligar && !efetiva.mostrar && <p role="status" data-aviso-sem-nome><small>{avisoDesligar}</small></p>}
    {temLogo && efetiva.mostrar && completa && arteId && <>
      {entrada && avisoOrigem(entrada.origem) && (entrada.origem === 'faixa') === (entrada.modo === 'faixa') && <p role="status" data-aviso-origem={entrada.origem}><small>{avisoOrigem(entrada.origem)}</small></p>}
      {publicado && gravada.publicadoArteId !== arteId && <p data-aviso-previa><small>{AVISO_PREVIA_NAO_PUBLICADA}</small></p>}
      {!sobreValendo && <button type="button" className={ui.linkBotao} disabled={bloqueado || sugerindo} onClick={() => void colocarSobre()}>{sugerindo ? 'Procurando um lugar livre…' : 'Colocar a logo sobre a arte'}</button>}
      {sobreValendo && entrada && <fieldset className={ui.controlesLogo} disabled={bloqueado} aria-label="Posição da logo sobre a arte">
        <p id="logo-controle-ajuda" className={ui.ajudaLogo}><small>Use as setas para mover; Shift + seta move mais. Esc cancela o arraste.</small></p>
        <p><small>{AVISO_PERMANENTE_SOBRE}</small></p>
        {semLugar === arteId && <p role="status"><small>{AVISO_SEM_LUGAR}</small></p>}
        {cobrindo && <p role="status" data-aviso-cobrindo><small>{AVISO_COBRINDO}</small></p>}
        <div className={ui.lugaresLogo} role="group" aria-label="Lugar da logo">
          {LUGARES_LOGO.map(l => <button key={l.nome} type="button" aria-label={l.nome} title={l.nome} disabled={!caixaPronta} onClick={() => { const c = caixaDe(entrada); if (c) enviar(limitarAoExibido({ ...entrada, x: l.x, y: l.y }, c)); }}><span aria-hidden="true">•</span></button>)}
        </div>
        <div className={ui.setasLogo} role="group" aria-label="Mover a logo">
          <button type="button" aria-label="Mover para cima" disabled={!caixaPronta} onClick={() => mover(0, -PASSO_SETA, true)}>↑</button>
          <button type="button" aria-label="Mover para a esquerda" disabled={!caixaPronta} onClick={() => mover(-PASSO_SETA, 0, true)}>←</button>
          <button type="button" aria-label="Mover para a direita" disabled={!caixaPronta} onClick={() => mover(PASSO_SETA, 0, true)}>→</button>
          <button type="button" aria-label="Mover para baixo" disabled={!caixaPronta} onClick={() => mover(0, PASSO_SETA, true)}>↓</button>
        </div>
        <div className={ui.tamanhosLogo} role="radiogroup" aria-label="Tamanho da logo">
          {TAMANHOS_LOGO.map(([sigla, nome, largura]) => <label key={sigla}><input type="radio" name={`tamanho-logo-${arteId}`} checked={entrada.largura === largura} onChange={() => enviar({ ...entrada, largura })} />{nome}</label>)}
        </div>
        <label className={ui.check}><input type="checkbox" checked={entrada.fundo} onChange={e => enviar({ ...entrada, fundo: e.target.checked })} />Fundo claro atrás da logo</label>
        <div className={ui.acoes}>
          <button type="button" disabled={sugerindo} onClick={() => void colocarSobre()}>{sugerindo ? 'Procurando…' : 'Sugerir lugar'}</button>
          <button type="button" onClick={() => { setSemLugar(null); enviar({ ...entrada, modo: 'faixa' }); }}>Voltar para a faixa</button>
        </div>
      </fieldset>}
      {falhaSugestao && <p role="alert"><small>{falhaSugestao}</small></p>}
    </>}
  </>;
  const previa = ativo && logoAparecendo && !sobreValendo
    ? <div className={ui.logoBuffetPrevia} aria-label="Rodapé da página do convite" data-logo-previa><img src={logoDataUrl!} alt="Logo do buffet" /></div> : null;
  const painel = ativo ? <div className={`${ui.logoBuffet} ${ui.logoBuffetOpcoes ?? ''}`} data-logo-buffet>
    <details open={painelAberto}>
      <summary className={ui.resumoLogo} onClick={event => {
        event.preventDefault();
        setPainelAberto(aberto => !aberto);
      }}>
        Logo do buffet no convite <span>· {logoAparecendo ? 'aparecendo' : 'oculta'}</span>
      </summary>
      {controles}
    </details>
    {!carregada && <p role="status" data-logo-conferindo><small>Conferindo a logo gravada…</small></p>}
    <p className={styles.somenteLeitor} aria-live="polite" data-anuncio-logo>{anuncio}</p>
    <p aria-live="polite" data-situacao-logo={situacao ?? 'ocioso'}>{situacao && <small>
      {TEXTO_SITUACAO_FILA[situacao]}
      {situacao === 'erro' && <> <button type="button" className={ui.linkBotao} onClick={() => fila?.tentarDeNovo()}>Tentar de novo</button></>}
      {situacao === 'superada' && <> <button type="button" className={ui.linkBotao} onClick={() => window.location.reload()}>Recarregar</button></>}
    </small>}</p>
  </div> : null;

  return {
    aplicarLeitura, logoLigada, esquecerArte, sobre, previa, painel,
    baixar: { logo: ativo && efetiva.mostrar ? logoDataUrl : null, sobre: sobreValendo && entrada ? { x: entrada.x, y: entrada.y, largura: entrada.largura, fundo: entrada.fundo } : null },
  };
}
