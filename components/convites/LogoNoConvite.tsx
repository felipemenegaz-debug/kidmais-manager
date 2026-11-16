'use client';
/* eslint-disable @next/next/no-img-element */
/**
 * Logo do buffet no editor (plano etapa 3 r15.1, §4, §5 e §6). Toda escrita da logo passa pela fila (`filaDaLogo`):
 * o rascunho de textos nunca leva a logo, e salvar/publicar mantêm o que está gravado. A tela mostra o gravado com as
 * intenções da fila por cima; leituras só trocam os campos da logo quando a fila não tem nada pendente e a época não mudou.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { filaDaLogo, type EstadoFilaLogo, type FilaLogo, type PosicaoLogoEnvio } from '@/lib/convites/fila-logo';
import { analisarArte, LIMIAR_SEM_LUGAR, pontuacaoNaPosicao, sugerirPosicaoLogo, type AnaliseArte, type PosicaoLogo } from '@/lib/convites/posicao-logo';
import type { CaixaPct, PosicaoSobre, SobreArte } from './ConviteArte';
import {
  anuncioPosicao, arrastarLogo, incorporarConfirmados, limitarAoExibido, AVISO_COBRINDO, AVISO_PERMANENTE_SOBRE, AVISO_PREVIA_NAO_PUBLICADA, AVISO_SEM_LUGAR, avisoOrigem, avisoSemNome,
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
type Gravada = LogoLocal & { semNome: string[]; publicadoArteId: string | null };
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

const SEM_LOGO: Gravada = { mostrar: false, posicoes: {}, semNome: [], publicadoArteId: null };
function daLeitura(d: LeituraLogo): Gravada {
  return { mostrar: !!d.logoBuffet?.mostrar, posicoes: { ...(d.conteudo.logoPosicoes ?? {}) }, semNome: [...(d.conteudo.logoSemNome ?? [])], publicadoArteId: d.publicadoArteId ?? null };
}

export type LogoNoConvite = {
  /** Época da fila no início de uma leitura (regra da época, §5). */
  marcarLeitura(): number | undefined;
  /** Aplica os campos da logo de uma leitura, se a regra da época deixar. */
  aplicarLeitura(d: LeituraLogo, epoca: number | undefined): void;
  /** §4: valor de `logoLigada` para `gerar` (espera o `mostrar` até 5 s); null = não gerar. */
  logoLigada(esperando?: () => void): Promise<boolean | null>;
  esquecerArte(arteId: string): void;
  /** Para o ConviteArte da prévia. */
  sobre: SobreArte | null;
  /** Para o download: logo da faixa (ou da sobreposição) e posição sobre a arte, quando a regra vale. */
  baixar: { logo: string | null; sobre: PosicaoSobre | null };
  painel: ReactNode;
};

/**
 * `ativo`: editor do buffet, fora do laboratório, com convite carregado. `conteudo` traz só o que a regra de exibição usa.
 */
export function useLogoNoConvite({ ativo, conviteId, logoDataUrl, publicado, conteudo, arteUrl, ler, busy, ui }: {
  ativo: boolean; conviteId?: string; logoDataUrl: string | null; publicado: boolean;
  conteudo: { arteId?: string | null; visual?: { modo: 'modelo' | 'completa' } | null } | null; arteUrl?: string;
  ler: () => Promise<LeituraLogo>; busy: boolean; ui: Record<string, string>;
}): LogoNoConvite {
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
  const analises = useRef(new Map<string, AnaliseArte>()), proporcaoLogo = useRef<number | null>(null);
  const inicioArraste = useRef<{ pos: PosicaoLogoEnvio; px: number; py: number; w: number; h: number; id: number } | null>(null);
  // r2 (Astra r1, P2): base = última leitura aceita + só o que a fila confirmou depois dela (número da confirmação).
  const confirmacaoIncorporada = useRef(0), baseLida = useRef(false), reconciliar = useRef(false), lendo = useRef(false);
  // r2 (Astra r1, P2): versão por arte das intenções desta tela; a sugestão só vale se nada mudou na arte enquanto lia as imagens.
  const versaoArte = useRef(new Map<string, number>());
  // r2 (Astra r1, P3): caixa exibida da logo (em % da arte), para setas, arraste e lugares partirem do centro mostrado.
  const caixaExibida = useRef<{ arteId: string; largura: number; fundo: boolean; caixa: CaixaPct } | null>(null);
  const lerRef = useRef(ler); useEffect(() => { lerRef.current = ler; });
  const relerRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!fila) return;
    const aplicar = (e: EstadoFilaLogo) => {
      setEstadoFila(e);
      if (e.confirmados.n > confirmacaoIncorporada.current) {
        const desde = confirmacaoIncorporada.current;
        confirmacaoIncorporada.current = e.confirmados.n;
        setGravada(g => incorporarConfirmados(g, e.confirmados, desde));
      }
      // Leitura descartada durante a drenagem: relê quando a fila esvaziar.
      if (reconciliar.current && !e.pendente) relerRef.current();
    };
    aplicar(fila.estado());
    const sair = fila.assinar(aplicar);
    return () => { sair(); fila.drenar(); };
  }, [fila]);

  const marcarLeitura = useCallback(() => fila?.epoca(), [fila]);
  const aplicarLeitura = useCallback((d: LeituraLogo, epoca: number | undefined) => {
    if (!d.logoBuffet || d.laboratorioLocal) return;
    const f = d.id ? filaDaLogo(d.id) : null;
    if (f && (f.temPendencia() || (epoca !== undefined && f.epoca() !== epoca))) {
      reconciliar.current = true;
      if (!baseLida.current) {
        // Reabrir durante a drenagem: a leitura serve de base sob as intenções locais até a releitura de reconciliação.
        baseLida.current = true;
        setGravada(daLeitura(d));
      } else {
        // Só o id publicado não é campo da logo gravado pela fila: pode atualizar sempre.
        setGravada(g => ({ ...g, publicadoArteId: d.publicadoArteId ?? null }));
      }
      if (!f.temPendencia()) setTimeout(() => relerRef.current(), 0);
      return;
    }
    baseLida.current = true; reconciliar.current = false;
    if (f) confirmacaoIncorporada.current = f.estado().confirmados.n;
    setGravada(daLeitura(d));
  }, []);

  // §5: ao voltar à aba, relê só os campos da logo (nunca o conteúdo em edição); também reconcilia depois da drenagem.
  const reler = useCallback(() => {
    if (!fila || lendo.current) return;
    lendo.current = true; const ep = fila.epoca();
    void lerRef.current().then(d => aplicarLeitura(d, ep)).catch(() => undefined).finally(() => {
      lendo.current = false;
      if (reconciliar.current && !fila.temPendencia()) setTimeout(() => relerRef.current(), 0);
    });
  }, [fila, aplicarLeitura]);
  useEffect(() => { relerRef.current = reler; }, [reler]);
  useEffect(() => {
    if (!fila) return;
    const aoVoltar = () => { if (document.visibilityState === 'visible') reler(); };
    window.addEventListener('focus', aoVoltar); document.addEventListener('visibilitychange', aoVoltar);
    return () => { window.removeEventListener('focus', aoVoltar); document.removeEventListener('visibilitychange', aoVoltar); };
  }, [fila, reler]);

  const efetiva = logoEfetiva(gravada, estadoFila);
  const efetivaRef = useRef(efetiva); useEffect(() => { efetivaRef.current = efetiva; });
  const arteId = conteudo?.arteId ?? null;
  const completa = conteudo?.visual?.modo === 'completa' && !!arteId && !!arteUrl;
  const entrada: EntradaLogo | null = arteId ? efetiva.posicoes[arteId] ?? null : null;
  const temLogo = !!logoDataUrl;
  const sobreValendo = ativo && temLogo && efetiva.mostrar && completa && entrada?.modo === 'sobre';
  const superada = estadoFila?.situacao === 'superada';
  const bloqueado = busy || superada;
  const posicaoMostrada = sobreValendo && entrada ? (arraste && arraste.arteId === entrada.arteId ? arraste : entrada) : null;

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
    const c = caixaExibida.current;
    return c && c.arteId === p.arteId && c.largura === p.largura && c.fundo === p.fundo ? c.caixa : null;
  }
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
    enviar(limitarAoExibido(moverLogo(limitarAoExibido(entrada, caixa), dx, dy), caixa), adiar);
  }

  // ---------------------------------------------------------------- arraste (§6)
  function inicio(e: ReactPointerEvent<HTMLButtonElement>) {
    if (bloqueado || !entrada || entrada.modo !== 'sobre' || e.button !== 0) return;
    const camada = e.currentTarget.parentElement?.getBoundingClientRect();
    if (!camada) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    inicioArraste.current = { pos: limitarAoExibido(entrada, caixaDe(entrada)), px: e.clientX, py: e.clientY, w: camada.width, h: camada.height, id: e.pointerId };
    setArraste(inicioArraste.current.pos); setCobrindo(false);
    if (arteId && arteUrl) void prepararAnalise(arteId, arteUrl);
  }
  function movimento(e: ReactPointerEvent<HTMLButtonElement>) {
    const i = inicioArraste.current; if (!i || i.id !== e.pointerId) return;
    const p = limitarAoExibido(arrastarLogo(i.pos, e.clientX - i.px, e.clientY - i.py, i.w, i.h), caixaDe(i.pos));
    setArraste(p);
    const analise = arteId ? analises.current.get(arteId) : undefined;
    setCobrindo(!!analise && !!proporcaoLogo.current && pontuacaoNaPosicao(analise, p, proporcaoLogo.current) > LIMIAR_SEM_LUGAR);
  }
  function fim(e: ReactPointerEvent<HTMLButtonElement>) {
    const i = inicioArraste.current; if (!i || i.id !== e.pointerId) return;
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
    if (posicaoMostrada) caixaExibida.current = { arteId: posicaoMostrada.arteId, largura: posicaoMostrada.largura, fundo: posicaoMostrada.fundo, caixa };
    return <button type="button" className={styles.controleLogo} aria-label="Logo do buffet sobre a arte" aria-describedby="logo-controle-ajuda"
    data-arrastando={!!arraste} disabled={bloqueado}
    style={{ left: `${caixa.left + caixa.width / 2}%`, top: `${caixa.top + caixa.height / 2}%`, width: `${caixa.width}%`, height: `${caixa.height}%` }}
    onPointerDown={inicio} onPointerMove={movimento} onPointerUp={fim} onPointerCancel={cancelar} onLostPointerCapture={e => { if (inicioArraste.current?.id === e.pointerId) cancelar(); }}
    onKeyDown={tecla} />;
  };

  const sobre: SobreArte | null = posicaoMostrada && logoDataUrl
    ? { logo: logoDataUrl, posicao: { x: posicaoMostrada.x, y: posicaoMostrada.y, largura: posicaoMostrada.largura, fundo: posicaoMostrada.fundo }, controle }
    : null;

  const logoLigada = useCallback((esperando?: () => void) => logoLigadaParaGerar(fila, () => efetivaRef.current.mostrar, esperando), [fila]);
  const esquecerArte = useCallback((id: string) => { fila?.esquecerArte(id); analises.current.delete(id); }, [fila]);

  function mudarMostrar(v: boolean) {
    if (!fila) return;
    fila.mostrar(v);
    setAvisoDesligar(v ? null : avisoSemNome(arteId, gravada.publicadoArteId, gravada.semNome));
  }

  const situacao = estadoFila && estadoFila.situacao !== 'ocioso' ? estadoFila.situacao : null;
  const painel = ativo ? <div className={ui.logoBuffet} data-logo-buffet>
    {efetiva.mostrar && temLogo && !sobreValendo && <div className={ui.logoBuffetPrevia} aria-label="Rodapé da página do convite"><img src={logoDataUrl!} alt="Logo do buffet" /></div>}
    <label className={ui.check}><input type="checkbox" checked={efetiva.mostrar && temLogo} disabled={bloqueado || !temLogo} aria-describedby="logo-buffet-nota" onChange={e => mudarMostrar(e.target.checked)} />
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
          {LUGARES_LOGO.map(l => <button key={l.nome} type="button" aria-label={l.nome} title={l.nome} onClick={() => enviar(limitarAoExibido({ ...entrada, x: l.x, y: l.y }, caixaDe(entrada)))}><span aria-hidden="true">•</span></button>)}
        </div>
        <div className={ui.setasLogo} role="group" aria-label="Mover a logo">
          <button type="button" aria-label="Mover para cima" onClick={() => mover(0, -PASSO_SETA, true)}>↑</button>
          <button type="button" aria-label="Mover para a esquerda" onClick={() => mover(-PASSO_SETA, 0, true)}>←</button>
          <button type="button" aria-label="Mover para a direita" onClick={() => mover(PASSO_SETA, 0, true)}>→</button>
          <button type="button" aria-label="Mover para baixo" onClick={() => mover(0, PASSO_SETA, true)}>↓</button>
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
    <p className={styles.somenteLeitor} aria-live="polite" data-anuncio-logo>{anuncio}</p>
    <p aria-live="polite" data-situacao-logo={situacao ?? 'ocioso'}>{situacao && <small>
      {TEXTO_SITUACAO_FILA[situacao]}
      {situacao === 'erro' && <> <button type="button" className={ui.linkBotao} onClick={() => fila?.tentarDeNovo()}>Tentar de novo</button></>}
      {situacao === 'superada' && <> <button type="button" className={ui.linkBotao} onClick={() => window.location.reload()}>Recarregar</button></>}
    </small>}</p>
  </div> : null;

  return {
    marcarLeitura, aplicarLeitura, logoLigada, esquecerArte, sobre, painel,
    baixar: { logo: ativo && efetiva.mostrar ? logoDataUrl : null, sobre: sobreValendo && entrada ? { x: entrada.x, y: entrada.y, largura: entrada.largura, fundo: entrada.fundo } : null },
  };
}
