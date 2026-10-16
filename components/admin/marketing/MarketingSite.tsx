'use client';
/* eslint-disable @next/next/no-img-element -- Miniaturas servidas pela rota administrativa (WebP já reprocessado), sem otimizador remoto. */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ESTILOS_SITE, type ConteudoPublicado, type ConteudoSite, type EstiloSite } from '@/lib/marketing/site/conteudo';
import type { SiteAdmin } from '@/lib/marketing/site/servico';
import type { Dominio } from '@/lib/marketing/dominios/servico';
import { ESTILOS, PALETAS, avisosDeCores, paletaDasCores, temaDoSite } from '@/lib/marketing/site/tema';
import { adminFetch } from '@/lib/http/admin-fetch';
import { dataHoraBr, ROTULO_ESTADO_SITE, rotuloDominio } from '@/lib/marketing/apresentacao';
import SitePublicoPagina from '@/components/marketing/site/SitePublicoPagina';
import { AdminPrimaryButton } from '../AdminPrimaryButton';
import { useRouter } from 'next/navigation';
import { CabecalhoMarketing, EstadoCarga, enviarMarketing, useMarketing } from './comum';
import { useProtecaoDeSaida } from './protecao-saida';
import styles from './marketing.module.css';
import ed from './site-editor.module.css';

type Imagem = { id: string; largura: number; altura: number; bytes: number; descricao: string | null; criadoEm: string };
type PacoteDisponivel = { codigo: string; nome: string; descricao?: string | null; convidadosMinimos?: number | null; convidadosMaximos?: number | null; duracaoMinutos?: number | null };
type Dados = {
  site: SiteAdmin | null; unidades: Array<{ id: string; nome: string }>; imagens?: Imagem[]; versoes?: Array<{ id: string; numero: number; publicadoEm: string; publicadoPor: string | null }>;
  dominios?: Dominio[]; pacotesDisponiveis?: PacoteDisponivel[]; enderecos?: { plataforma: string; canonical: string; sitemap: string };
  previa?: { conteudo: ConteudoPublicado; avisos: string[] }; ambiente: { sitesPublicos: boolean; dominiosPersonalizados: boolean; dominioSimuladoServido: boolean }; capacidades: string[]; avisos?: string[];
};
type EstadoSalvar = 'salvo' | 'sujo' | 'salvando' | 'erro';
const ABAS = [['identidade', 'Identidade'], ['fotos', 'Fotos'], ['conteudo', 'Conteúdo'], ['pacotes', 'Pacotes'], ['publicacao', 'Publicação e SEO']] as const;
type Aba = (typeof ABAS)[number][0];
const urlImagemAdmin = (id: string) => `/api/admin/marketing/site/imagens/${id}`;

/**
 * Prévia IMEDIATA do rascunho (inclusive não salvo): o mesmo renderizador da página pública. Pacotes: dados do pacote
 * vigente; o preço "a partir de" só aparece se a última prévia do servidor (rascunho salvo) já o resolveu — o valor
 * definitivo é congelado na publicação.
 */
function conteudoDaPrevia(rascunho: ConteudoSite, servidor: ConteudoPublicado | undefined, disponiveis: PacoteDisponivel[]): ConteudoPublicado {
  const pacotes = rascunho.pacotes.flatMap((p) => {
    const r = servidor?.pacotes.find((x) => x.codigo === p.codigo);
    const d = disponiveis.find((x) => x.codigo === p.codigo);
    if (!r && !d) return [];
    return [{
      codigo: p.codigo, nome: r?.nome ?? d!.nome, descricao: r?.descricao ?? d?.descricao ?? null, destaque: p.destaque,
      convidadosMinimos: r?.convidadosMinimos ?? d?.convidadosMinimos ?? null, convidadosMaximos: r?.convidadosMaximos ?? d?.convidadosMaximos ?? null,
      duracaoMinutos: r?.duracaoMinutos ?? d?.duracaoMinutos ?? null, precoAPartirCentavos: p.mostrarPreco ? (r?.precoAPartirCentavos ?? null) : null, imagemId: p.imagemId,
    }];
  });
  return { ...rascunho, pacotes, versao: 0, publicadoEm: '', rascunhoHash: '' };
}

export default function MarketingSite() {
  const router = useRouter();
  const [unidadeId, setUnidadeId] = useState('');
  const url = `/api/admin/marketing/site${unidadeId ? `?unidadeId=${unidadeId}` : ''}`;
  const { dados: carregados, dadosDe, falha, carregando, recarregar, setDados } = useMarketing<Dados>(url);
  // Só os dados da unidade SELECIONADA ficam acionáveis. Enquanto a nova unidade carrega (ou se a leitura falhou),
  // o conteúdo da anterior não aparece sob o rótulo novo. A lista de unidades é da empresa e vale para qualquer resposta.
  const dados = dadosDe === url ? carregados : null;
  const unidades = carregados?.unidades ?? [];
  // Edição local amarrada à versão do rascunho no servidor (site + versão). Ao salvar, o que foi digitado DEPOIS do envio
  // é reconciliado para a versão nova e continua "não salvo" (ver `salvar`).
  const [edicao, setEdicao] = useState<{ chave: string; conteudo: ConteudoSite } | null>(null);
  const [slugEditado, setSlugEditado] = useState<{ chave: string; slug: string } | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  // Operações em andamento (salvar, publicar, fotos, domínio): enquanto houver, a unidade não pode ser trocada.
  const [pendentes, setPendentes] = useState(0);
  const [salvando, setSalvando] = useState<'salvando' | 'erro' | null>(null);
  const [aba, setAba] = useState<Aba>('identidade');
  const [modo, setModo] = useState<'editar' | 'previa'>('editar');
  const [largura, setLargura] = useState<'desktop' | 'celular'>('desktop');
  const [trocaPedida, setTrocaPedida] = useState<string | null>(null);
  const chave = dados?.site ? `${dados.site.id}:${dados.site.rascunhoVersao}` : 'novo';
  const sujo = edicao?.chave === chave;
  const conteudo: ConteudoSite | null = dados?.site ? (sujo ? edicao!.conteudo : dados.site.rascunho) : null;
  const versaoRascunho = dados?.site?.rascunhoVersao ?? 0;
  const chaveSlug = dados?.site ? dados.site.id : `novo:${unidadeId}`;
  const slug = slugEditado?.chave === chaveSlug ? slugEditado.slug : dados?.site?.slug ?? '';
  const setSlug = (valor: string) => setSlugEditado({ chave: chaveSlug, slug: valor });
  const estadoSalvar: EstadoSalvar = salvando === 'salvando' ? 'salvando' : sujo ? (salvando === 'erro' ? 'erro' : 'sujo') : 'salvo';

  const pode = (c: string) => dados?.capacidades.includes(c) ?? false;
  const podeEditar = pode('MARKETING_SITE_EDITAR');
  const nomeUnidade = unidadeId ? unidades.find((u) => u.id === unidadeId)?.nome ?? 'unidade' : 'empresa (sem unidade)';

  // Estado mais recente para handlers que concluem depois de um `await` (fotos, remoção, salvar): nunca uma cópia antiga.
  const atual = useRef({ url, chave, rascunho: dados?.site?.rascunho ?? null, siteId: dados?.site?.id ?? null, podeEditar, edicao, capacidades: dados?.capacidades ?? [] });
  useEffect(() => { atual.current = { url, chave, rascunho: dados?.site?.rascunho ?? null, siteId: dados?.site?.id ?? null, podeEditar, edicao, capacidades: dados?.capacidades ?? [] }; });
  const emOperacao = useRef(false);

  const editar = (alteracao: (c: ConteudoSite) => ConteudoSite, doSite?: string) => {
    const a = atual.current;
    const base = a.rascunho;
    if (!base || !a.podeEditar || (doSite && doSite !== a.siteId)) return;
    setEdicao((e) => ({ chave: a.chave, conteudo: alteracao(e?.chave === a.chave ? e.conteudo : base) }));
    setSalvando((s) => (s === 'erro' ? null : s));
  };
  /** Conta a operação como pendente (bloqueia trocar de unidade) até terminar, com sucesso ou erro. */
  async function rastrear<T>(p: () => Promise<T>): Promise<T> {
    setPendentes((n) => n + 1);
    try { return await p(); } finally { setPendentes((n) => n - 1); }
  }
  /** Imagens/domínios devolvidos pela API: aplicados sobre os dados atuais e só se ainda forem do mesmo site. */
  const atualizarDoSite = (siteId: string, f: (d: Dados) => Dados) => setDados((d) => (d.site?.id === siteId ? f(d) : d));

  async function acao(corpo: Record<string, unknown>, sucesso: string, opcoes: { deSalvar?: boolean; aoConcluir?: (novo: Dados) => string | void } = {}): Promise<boolean> {
    if (emOperacao.current) return false; // clique repetido antes de a tela atualizar
    emOperacao.current = true;
    const de = atual.current.url;
    setOcupado(true); setAviso(null); if (opcoes.deSalvar) setSalvando('salvando');
    try {
      const novo = await rastrear(() => enviarMarketing<Dados>('/api/admin/marketing/site', corpo));
      if (atual.current.url !== de) { setAviso({ tipo: 'ok', texto: `${sucesso} (site de outra unidade; esta tela não foi alterada)` }); return true; }
      setDados({ ...novo, capacidades: atual.current.capacidades });
      const extra = opcoes.aoConcluir?.(novo);
      setAviso({ tipo: 'ok', texto: [sucesso, extra, ...(novo.avisos ?? [])].filter(Boolean).join(' ') });
      if (opcoes.deSalvar) setSalvando(null);
      return true;
    } catch (e) {
      setAviso({ tipo: 'erro', texto: e instanceof Error ? e.message : 'Não foi possível concluir.' });
      if (opcoes.deSalvar) setSalvando('erro');
      return false;
    } finally { emOperacao.current = false; setOcupado(false); }
  }
  /** "ok" = tudo salvo; "restou" = salvou o enviado, mas há alterações feitas durante o envio; "erro" = nada mudou. */
  async function salvar(): Promise<'ok' | 'restou' | 'erro'> {
    const a = atual.current;
    if (!a.siteId || !conteudo || !sujo) return sujo ? 'erro' : 'ok';
    const enviado = conteudo, chaveEnviada = a.chave;
    let restou = false;
    const ok = await acao({ acao: 'salvar', siteId: a.siteId, rascunhoVersao: versaoRascunho, conteudo: enviado }, 'Rascunho salvo. Nada mudou no site publicado.', {
      deSalvar: true,
      aoConcluir: (novo) => {
        const chaveNova = novo.site ? `${novo.site.id}:${novo.site.rascunhoVersao}` : 'novo';
        const depois = atual.current.edicao;
        const houveMais = Boolean(depois && depois.chave === chaveEnviada && depois.conteudo !== enviado);
        // Só o que foi enviado está salvo; o que foi digitado durante o envio passa para a versão nova como NÃO salvo.
        setEdicao((e) => (e && e.chave === chaveEnviada && e.conteudo !== enviado ? { chave: chaveNova, conteudo: e.conteudo } : null));
        restou = houveMais;
        return houveMais ? 'O que você alterou durante o salvamento continua marcado como não salvo.' : undefined;
      },
    });
    return ok ? (restou ? 'restou' : 'ok') : 'erro';
  }
  const trocarUnidade = (valor: string) => {
    if (pendentes > 0 || valor === unidadeId) return;
    if (sujo) { setTrocaPedida(valor); return; }
    setEdicao(null); setAviso(null); setUnidadeId(valor);
  };
  const protecao = useProtecaoDeSaida(sujo, (href, substituir) => (substituir ? router.replace(href) : router.push(href)));
  const dialogo = trocaPedida !== null ? { titulo: `Trocar para o site da ${trocaPedida ? unidades.find((u) => u.id === trocaPedida)?.nome ?? 'unidade' : 'empresa (sem unidade)'}?`, acao: 'trocar' as const }
    : protecao.pendente ? { titulo: 'Sair do editor?', acao: 'sair' as const } : null;
  const fecharDialogo = () => { if (trocaPedida !== null) setTrocaPedida(null); else protecao.permanecer(); };
  const descartar = () => {
    setEdicao(null);
    if (trocaPedida !== null) { const v = trocaPedida; setTrocaPedida(null); setAviso(null); setUnidadeId(v); } else protecao.sair();
  };
  const salvarEContinuar = async () => {
    const r = await salvar();
    // Erro: fica no editor, com o conteúdo e o aviso. Alterado durante o envio: também fica (sair perderia o que restou).
    if (r !== 'ok') { fecharDialogo(); return; }
    if (trocaPedida !== null) { const v = trocaPedida; setTrocaPedida(null); setEdicao(null); setUnidadeId(v); } else protecao.sair();
  };

  const previaConteudo = conteudo ? conteudoDaPrevia(conteudo, dados?.previa?.conteudo, dados?.pacotesDisponiveis ?? []) : null;
  const bloqueadoPorOperacao = pendentes > 0;

  return <main className={styles.pagina}>
    <CabecalhoMarketing titulo="Site e SEO" descricao="Monte o site de cada unidade: identidade, fotos, conteúdo e pacotes, com prévia ao lado. Salvar não publica — só o que você publicar aparece para os visitantes." />
    {unidades.length > 0 && <div className={styles.filtros}><label>Editando o site da<select value={unidadeId} disabled={bloqueadoPorOperacao} aria-describedby="unidade-ajuda" onChange={(e) => trocarUnidade(e.target.value)}>
      <option value="">Empresa (sem unidade)</option>{unidades.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select></label>
      <span id="unidade-ajuda" className={styles.muted}>{bloqueadoPorOperacao ? 'Aguarde a operação em andamento terminar para trocar de unidade.' : 'Cada unidade tem o próprio site; mudanças aqui não alteram as outras unidades.'}</span></div>}
    <EstadoCarga carregando={carregando && !dados} falha={dados ? null : falha} aoTentar={recarregar} />
    {dados && !dados.ambiente.sitesPublicos && <p className={styles.aviso}>A publicação está desligada neste ambiente (MARKETING_SITES_PUBLICOS). Você pode editar e publicar, mas a página pública só abre quando o servidor ligar o recurso.</p>}
    {aviso && <p className={aviso.tipo === 'ok' ? styles.info : styles.aviso} role={aviso.tipo === 'ok' ? 'status' : 'alert'}>{aviso.texto}</p>}
    {dados && !dados.site && <section className={styles.cartao}>
      <h2>Criar o site da {nomeUnidade}</h2>
      <p>O rascunho começa com o nome comercial, endereço e contatos do cadastro aplicado da empresa. Você escolhe o que publicar.</p>
      {podeEditar ? <div className={styles.filtros}>
        <label>Endereço (opcional)<input value={slug} placeholder="ex.: buffet-alegria" pattern="[a-z][a-z0-9-]{1,62}[a-z0-9]" onChange={(e) => setSlug(e.target.value.toLowerCase())} /></label>
        <AdminPrimaryButton type="button" carregando={ocupado} onClick={() => void acao({ acao: 'criar', unidadeId: unidadeId || null, ...(slug ? { slug } : {}) }, 'Site criado como rascunho.', { aoConcluir: () => { setSlugEditado(null); } })}>Criar rascunho</AdminPrimaryButton>
      </div> : <p className={styles.muted}>Seu acesso não inclui editar o site.</p>}
    </section>}

    {dados?.site && conteudo && previaConteudo && <>
      <div className={styles.barraFixa} style={{ position: 'sticky', top: 0, bottom: 'auto', marginBottom: 16 }}>
        <div className={styles.acoes} style={{ alignItems: 'center' }}>
          <span className={dados.site.estado === 'PUBLICADO' ? styles.seloAtivo : styles.selo}>{ROTULO_ESTADO_SITE[dados.site.estado]}</span>
          {dados.site.alteracoesNaoPublicadas && dados.site.versaoPublicada && <span className={styles.seloAlerta}>rascunho diferente do publicado</span>}
          <span className={ed.estadoSalvar} data-estado={estadoSalvar} role="status" aria-live="polite">
            {estadoSalvar === 'salvo' ? 'Rascunho salvo' : estadoSalvar === 'sujo' ? 'Alterações não salvas' : estadoSalvar === 'salvando' ? 'Salvando…' : 'Erro ao salvar — tente de novo'}
          </span>
        </div>
        <div className={styles.acoes}>
          {podeEditar && <button type="button" className={styles.secundario} disabled={ocupado || !sujo} onClick={() => void salvar()}>Salvar rascunho</button>}
          {pode('MARKETING_SITE_PUBLICAR') && <AdminPrimaryButton type="button" carregando={ocupado} disabled={sujo || dados.site.pendencias.length > 0}
            title={sujo ? 'Salve o rascunho antes de publicar' : dados.site.pendencias.length ? 'Resolva as pendências (aba Publicação e SEO)' : undefined}
            onClick={() => { if (window.confirm(`Publicar o rascunho salvo do site da ${nomeUnidade}? Ele passa a ser a página pública.`)) void acao({ acao: 'publicar', siteId: dados.site!.id, rascunhoVersao: versaoRascunho }, 'Site publicado.'); }}>Publicar</AdminPrimaryButton>}
        </div>
      </div>
      {!podeEditar && <p className={styles.info}>Seu acesso permite só visualizar o site. Peça à Gestão a permissão de edição em Marketing → Permissões.</p>}

      <div className={ed.soCelularEditor}><div className={ed.alternancia} role="group" aria-label="Mostrar">
        <button type="button" aria-pressed={modo === 'editar'} onClick={() => setModo('editar')}>Editar</button>
        <button type="button" aria-pressed={modo === 'previa'} onClick={() => setModo('previa')}>Prévia</button>
      </div></div>

      <div className={ed.layout} data-modo={modo}>
        <div className={ed.painelEdicao}>
          <Abas aba={aba} setAba={setAba} />
          <fieldset disabled={!podeEditar} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div role="tabpanel" id={`painel-${aba}`} aria-labelledby={`aba-${aba}`}>
              {aba === 'identidade' && <AbaIdentidade conteudo={conteudo} editar={editar} imagens={dados.imagens ?? []} />}
              {aba === 'fotos' && <AbaFotos siteId={dados.site.id} imagens={dados.imagens ?? []} conteudo={conteudo} editar={editar} podeEditar={podeEditar} rastrear={rastrear}
                aoMudar={(siteId, imagens) => atualizarDoSite(siteId, (d) => ({ ...d, imagens }))} />}
              {aba === 'conteudo' && <AbaConteudo conteudo={conteudo} editar={editar} />}
              {aba === 'pacotes' && <AbaPacotes conteudo={conteudo} editar={editar} disponiveis={dados.pacotesDisponiveis ?? []} imagens={dados.imagens ?? []} />}
            </div>
          </fieldset>
          {aba === 'publicacao' && <div role="tabpanel" id="painel-publicacao" aria-labelledby="aba-publicacao">
            <AbaPublicacao dados={dados} conteudo={conteudo} editar={editar} podeEditar={podeEditar} slug={slug} setSlug={setSlug} versaoRascunho={versaoRascunho}
              ocupado={ocupado} acao={(corpo, texto) => acao(corpo, texto, corpo.acao === 'endereco' ? { aoConcluir: () => { setSlugEditado(null); } } : {})} unidadeId={unidadeId} nomeUnidade={nomeUnidade}
              rastrear={rastrear} aoMudarDominios={(siteId, dominios) => atualizarDoSite(siteId, (d) => ({ ...d, dominios }))} />
          </div>}
        </div>

        <aside className={ed.painelPrevia} aria-label="Prévia do site">
          <div className={ed.previaTopo}>
            <strong>Prévia {sujo ? '(com alterações não salvas)' : 'do rascunho salvo'}</strong>
            <div className={styles.acoes} style={{ alignItems: 'center' }}>
              <div className={ed.alternancia} role="group" aria-label="Largura da prévia">
                <button type="button" aria-pressed={largura === 'desktop'} onClick={() => setLargura('desktop')}>Computador</button>
                <button type="button" aria-pressed={largura === 'celular'} onClick={() => setLargura('celular')}>Celular</button>
              </div>
              <a className={styles.fantasma} href={`/admin/marketing/site/previa${unidadeId ? `?unidadeId=${unidadeId}` : ''}`} target="_blank" rel="noopener"
                onClick={(e) => { if (sujo) { e.preventDefault(); setAviso({ tipo: 'erro', texto: 'A tela cheia mostra o rascunho SALVO. Salve antes de abrir.' }); } }}>Tela cheia</a>
            </div>
          </div>
          <p className={styles.muted} style={{ margin: 0 }}>Não é a página publicada. O formulário não envia; preços “a partir de” são confirmados na publicação.</p>
          <div className={ed.moldura} data-largura={largura}>
            <SitePublicoPagina conteudo={previaConteudo} base="" previa urlImagem={urlImagemAdmin} acaoFormulario="#" captura={{}} datasLivres={null} />
          </div>
        </aside>
      </div>
    </>}
    {dialogo && <DialogoAlteracoes titulo={dialogo.titulo} nomeUnidade={nomeUnidade} acao={dialogo.acao} podeSalvar={podeEditar} salvandoAgora={estadoSalvar === 'salvando'}
      aoPermanecer={fecharDialogo} aoDescartar={descartar} aoSalvar={() => void salvarEContinuar()} />}
  </main>;
}

/**
 * Confirmação ao sair do editor (ou trocar de unidade) com alterações não salvas. `<dialog>` modal nativo: foco preso,
 * Esc = permanecer, foco inicial em "Continuar editando". "Salvar e …" só segue depois do sucesso; com erro, fica.
 */
function DialogoAlteracoes({ titulo, nomeUnidade, acao, podeSalvar, salvandoAgora, aoPermanecer, aoDescartar, aoSalvar }: {
  titulo: string; nomeUnidade: string; acao: 'sair' | 'trocar'; podeSalvar: boolean; salvandoAgora: boolean; aoPermanecer: () => void; aoDescartar: () => void; aoSalvar: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); }, []);
  return <dialog ref={ref} className={ed.dialogo} aria-labelledby="dialogo-alteracoes-titulo" aria-describedby="dialogo-alteracoes-texto"
    onCancel={(e) => { e.preventDefault(); aoPermanecer(); }}>
    <h2 id="dialogo-alteracoes-titulo">{titulo}</h2>
    <p id="dialogo-alteracoes-texto">O site da {nomeUnidade} tem alterações que ainda não foram salvas. {acao === 'sair' ? 'Se sair agora sem salvar, elas se perdem.' : 'Se trocar agora sem salvar, elas se perdem.'}</p>
    <div className={styles.acoes}>
      <button type="button" className={styles.secundario} autoFocus onClick={aoPermanecer}>Continuar editando</button>
      {podeSalvar && <AdminPrimaryButton type="button" carregando={salvandoAgora} onClick={aoSalvar}>{acao === 'sair' ? 'Salvar e sair' : 'Salvar e trocar'}</AdminPrimaryButton>}
      <button type="button" className={styles.perigo} disabled={salvandoAgora} onClick={aoDescartar}>{acao === 'sair' ? 'Sair sem salvar' : 'Trocar sem salvar'}</button>
    </div>
  </dialog>;
}

function Abas({ aba, setAba }: { aba: Aba; setAba: (a: Aba) => void }) {
  const lista = useRef<HTMLDivElement>(null);
  function teclas(e: KeyboardEvent<HTMLDivElement>) {
    const i = ABAS.findIndex(([id]) => id === aba);
    const prox = e.key === 'ArrowRight' ? (i + 1) % ABAS.length : e.key === 'ArrowLeft' ? (i - 1 + ABAS.length) % ABAS.length : e.key === 'Home' ? 0 : e.key === 'End' ? ABAS.length - 1 : -1;
    if (prox < 0) return;
    e.preventDefault(); setAba(ABAS[prox][0]);
    lista.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[prox]?.focus();
  }
  return <div ref={lista} className={ed.abasEditor} role="tablist" aria-label="Partes do site" onKeyDown={teclas}>
    {ABAS.map(([id, rotulo]) => <button key={id} id={`aba-${id}`} type="button" role="tab" aria-selected={aba === id} aria-controls={`painel-${id}`} tabIndex={aba === id ? 0 : -1} onClick={() => setAba(id)}>{rotulo}</button>)}
  </div>;
}

function Secao({ titulo, children, descricao }: { titulo: string; children: ReactNode; descricao?: string }) {
  return <section className={styles.cartao} aria-label={titulo}><h2>{titulo}</h2>{descricao && <p className={styles.muted}>{descricao}</p>}{children}</section>;
}
function Campo({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return <label className={styles.campo}>{rotulo}{children}</label>;
}
type Editar = (f: (c: ConteudoSite) => ConteudoSite, doSite?: string) => void;
type Rastrear = <T>(p: () => Promise<T>) => Promise<T>;

function AbaIdentidade({ conteudo, editar, imagens }: { conteudo: ConteudoSite; editar: Editar; imagens: Imagem[] }) {
  const estilo = conteudo.aparencia.estilo;
  const paleta = paletaDasCores(conteudo.identidade.corPrimaria, conteudo.identidade.corSecundaria);
  const avisos = avisosDeCores(conteudo.identidade.corPrimaria, conteudo.identidade.corSecundaria, estilo);
  const setCor = (k: 'corPrimaria' | 'corSecundaria', v: string) => editar((c) => ({ ...c, identidade: { ...c.identidade, [k]: v.toLowerCase() } }));
  return <>
    <Secao titulo="Nome e frase" descricao="Aparecem no topo, na abertura e no rodapé.">
      <div className={styles.grade2}>
        <Campo rotulo="Nome do buffet"><input maxLength={80} value={conteudo.identidade.nome} onChange={(e) => editar((c) => ({ ...c, identidade: { ...c.identidade, nome: e.target.value } }))} /></Campo>
        <Campo rotulo="Frase de destaque (opcional)"><input maxLength={120} value={conteudo.identidade.slogan} placeholder="ex.: Festas com carinho desde 2010" onChange={(e) => editar((c) => ({ ...c, identidade: { ...c.identidade, slogan: e.target.value } }))} /></Campo>
      </div>
    </Secao>
    <Secao titulo="Estilo do site" descricao="Muda a composição, as letras e os tons de fundo. O conteúdo é o mesmo; troque quando quiser.">
      <div className={ed.estilos} role="radiogroup" aria-label="Estilo do site">
        {ESTILOS_SITE.map((id) => {
          const t = temaDoSite({ aparencia: { estilo: id }, identidade: conteudo.identidade }).variaveis;
          return <label key={id} className={ed.opcaoEstilo}>
            <input type="radio" name="estilo" value={id} checked={estilo === id} onChange={() => editar((c) => ({ ...c, aparencia: { ...c.aparencia, estilo: id as EstiloSite } }))} />
            <span className={ed.amostra} aria-hidden="true"><i style={{ background: t['--fundo'] }} /><i style={{ background: t['--cor-primaria'] }} /><i style={{ background: t['--fundo-alternado'] }} /></span>
            <strong>{ESTILOS[id].nome}</strong><span>{ESTILOS[id].descricao}</span>
          </label>;
        })}
      </div>
    </Secao>
    <Secao titulo="Cores" descricao="Escolha uma paleta pronta ou defina as suas. O site ajusta o texto para continuar legível.">
      <div className={ed.paletas} role="radiogroup" aria-label="Paletas prontas">
        {PALETAS.map((p) => <label key={p.id} className={ed.opcaoPaleta}>
          <input type="radio" name="paleta" checked={paleta?.id === p.id} onChange={() => editar((c) => ({ ...c, identidade: { ...c.identidade, corPrimaria: p.primaria, corSecundaria: p.secundaria } }))} />
          <span className={ed.bolinhas} aria-hidden="true"><i style={{ background: p.primaria }} /><i style={{ background: p.secundaria }} /></span>{p.nome}
        </label>)}
        <label className={ed.opcaoPaleta}><input type="radio" name="paleta" checked={!paleta} readOnly onChange={() => undefined} />
          <span className={ed.bolinhas} aria-hidden="true"><i style={{ background: conteudo.identidade.corPrimaria }} /><i style={{ background: conteudo.identidade.corSecundaria }} /></span>Personalizada</label>
      </div>
      <div className={ed.coresPersonalizadas}>
        <CorPersonalizada rotulo="Cor principal (botões e destaques)" valor={conteudo.identidade.corPrimaria} aoMudar={(v) => setCor('corPrimaria', v)} />
        <CorPersonalizada rotulo="Cor de apoio (detalhes)" valor={conteudo.identidade.corSecundaria} aoMudar={(v) => setCor('corSecundaria', v)} />
      </div>
      {avisos.length > 0 && <div className={styles.aviso} role="status" style={{ marginTop: 12 }}><strong>Atenção à leitura:</strong><ul>{avisos.map((a) => <li key={a}>{a}</li>)}</ul></div>}
    </Secao>
    <Secao titulo="Logo" descricao="Envie a imagem na aba Fotos e escolha aqui. Sem logo, o site mostra as iniciais do nome.">
      <div className={ed.miniaturas} role="group" aria-label="Escolher logo">
        <button type="button" className={ed.miniatura} aria-pressed={!conteudo.identidade.logoImagemId} onClick={() => editar((c) => ({ ...c, identidade: { ...c.identidade, logoImagemId: null } }))}>Sem logo</button>
        {imagens.map((i, n) => <button key={i.id} type="button" className={ed.miniatura} aria-pressed={conteudo.identidade.logoImagemId === i.id} aria-label={`Usar imagem ${n + 1} como logo`}
          onClick={() => editar((c) => ({ ...c, identidade: { ...c.identidade, logoImagemId: i.id } }))}><img src={urlImagemAdmin(i.id)} alt="" /></button>)}
      </div>
    </Secao>
  </>;
}

function CorPersonalizada({ rotulo, valor, aoMudar }: { rotulo: string; valor: string; aoMudar: (v: string) => void }) {
  const [texto, setTexto] = useState<{ base: string; valor: string } | null>(null);
  const atual = texto?.base === valor ? texto.valor : valor;
  return <label>{rotulo}<span className={ed.linhaCor}>
    <input type="color" value={valor} onChange={(e) => aoMudar(e.target.value)} aria-label={`${rotulo} (seletor)`} />
    <input type="text" value={atual} maxLength={7} aria-label={`${rotulo} em hexadecimal`} onChange={(e) => {
      const v = e.target.value.trim();
      setTexto({ base: valor, valor: v });
      if (/^#[0-9a-fA-F]{6}$/.test(v)) aoMudar(v);
    }} />
  </span></label>;
}

function AbaFotos({ siteId, imagens, conteudo, editar, podeEditar, aoMudar, rastrear }: {
  siteId: string; imagens: Imagem[]; conteudo: ConteudoSite; editar: Editar; podeEditar: boolean; aoMudar: (siteId: string, i: Imagem[]) => void; rastrear: Rastrear;
}) {
  const arquivo = useRef<HTMLInputElement>(null);
  const [progresso, setProgresso] = useState<{ atual: number; total: number } | null>(null);
  const [erros, setErros] = useState<string[]>([]);
  async function enviar(lista: FileList | null) {
    const arquivos = Array.from(lista ?? []);
    if (!arquivos.length) return;
    setErros([]);
    let ultima: Imagem[] | null = null;
    await rastrear(async () => { for (const [n, f] of arquivos.entries()) {
      setProgresso({ atual: n + 1, total: arquivos.length });
      try {
        const form = new FormData(); form.set('siteId', siteId); form.set('arquivo', f);
        const corpo = await (await adminFetch('/api/admin/marketing/site/imagens', { method: 'POST', body: form })).json();
        if (!corpo.ok) throw new Error(corpo.erro ?? 'não foi possível enviar.');
        ultima = corpo.data.imagens;
      } catch (e) { setErros((x) => [...x, `${f.name}: ${e instanceof Error ? e.message : 'não foi possível enviar.'}`]); }
    } });
    if (ultima) aoMudar(siteId, ultima);
    setProgresso(null);
    if (arquivo.current) arquivo.current.value = '';
  }
  async function remover(id: string) {
    if (!window.confirm('Remover a foto? Se estiver no site publicado, deixa de ser servida na hora (cópias em cache do navegador podem durar até 5 min).')) return;
    try {
      const r = await rastrear(() => enviarMarketing<{ imagens: Imagem[] }>(`/api/admin/marketing/site/imagens/${id}`, { acao: 'remover', siteId }));
      aoMudar(siteId, r.imagens);
      // Tira a foto do rascunho EM EDIÇÃO (o mais recente, não uma cópia de antes do envio) e só se ainda for o mesmo site.
      editar((c) => ({ ...c, identidade: { ...c.identidade, logoImagemId: c.identidade.logoImagemId === id ? null : c.identidade.logoImagemId },
        galeria: c.galeria.filter((g) => g.imagemId !== id), pacotes: c.pacotes.map((p) => (p.imagemId === id ? { ...p, imagemId: null } : p)) }), siteId);
    } catch (e) { setErros([e instanceof Error ? e.message : 'Não foi possível remover.']); }
  }
  const pos = (id: string) => conteudo.galeria.findIndex((g) => g.imagemId === id);
  const mover = (id: string, delta: -1 | 1) => editar((c) => {
    const g = [...c.galeria]; const i = g.findIndex((x) => x.imagemId === id); const j = i + delta;
    if (i < 0 || j < 0 || j >= g.length) return c;
    [g[i], g[j]] = [g[j], g[i]]; return { ...c, galeria: g };
  });
  const capa = (id: string) => editar((c) => {
    const existente = c.galeria.find((g) => g.imagemId === id) ?? { imagemId: id, legenda: '' };
    return { ...c, galeria: [existente, ...c.galeria.filter((g) => g.imagemId !== id)].slice(0, 12) };
  });
  const ordenadas = [...imagens].sort((a, b) => { const pa = pos(a.id), pb = pos(b.id); return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb); });
  return <Secao titulo="Fotos" descricao="A capa do site é a 1ª foto da galeria (use “Usar como capa”). Fotos enviadas ficam privadas; só aparecem no site as que estão na galeria, no logo ou vinculadas a um pacote, depois de publicar. PNG, JPEG ou WebP até 8 MB, convertidas e sem dados de localização.">
    {podeEditar && <div>
      <label className={styles.campo}>Enviar fotos (pode escolher várias)
        <input ref={arquivo} type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(e) => void enviar(e.target.files)} disabled={Boolean(progresso)} /></label>
      {progresso && <div className={ed.progresso} role="status"><span>Enviando {progresso.atual} de {progresso.total}…</span><progress value={progresso.atual - 1} max={progresso.total} /></div>}
    </div>}
    {erros.length > 0 && <div className={styles.aviso} role="alert"><strong>Algumas fotos não foram enviadas:</strong><ul>{erros.map((e) => <li key={e}>{e}</li>)}</ul></div>}
    {imagens.length === 0 ? <p className={styles.vazio}>Nenhuma foto enviada. Sem fotos, a abertura usa as cores da marca.</p> : <div className={ed.fotos}>
      {ordenadas.map((i, n) => {
        const p = pos(i.id);
        return <figure key={i.id} className={ed.foto} data-capa={p === 0}>
          <img src={urlImagemAdmin(i.id)} alt={i.descricao ?? `Foto ${n + 1}`} loading="lazy" />
          <div className={ed.selos}>
            {p === 0 && <span className={styles.seloVioleta}>capa</span>}
            {p > 0 && <span className={styles.seloAtivo}>galeria #{p + 1}</span>}
            {p < 0 && <span className={styles.selo}>fora do site</span>}
            {conteudo.identidade.logoImagemId === i.id && <span className={styles.seloVioleta}>logo</span>}
            {conteudo.pacotes.some((x) => x.imagemId === i.id) && <span className={styles.selo}>foto de pacote</span>}
          </div>
          {podeEditar && <div className={ed.botoes}>
            {p !== 0 && <button type="button" className={styles.secundario} onClick={() => capa(i.id)}>Usar como capa</button>}
            <button type="button" className={styles.fantasma} onClick={() => editar((c) => ({ ...c, galeria: p >= 0 ? c.galeria.filter((g) => g.imagemId !== i.id) : [...c.galeria, { imagemId: i.id, legenda: '' }].slice(0, 12) }))}>{p >= 0 ? 'Tirar do site' : 'Pôr na galeria'}</button>
            {p > 0 && <button type="button" className={styles.fantasma} aria-label="Mover para antes" onClick={() => mover(i.id, -1)}>←</button>}
            {p >= 0 && p < conteudo.galeria.length - 1 && <button type="button" className={styles.fantasma} aria-label="Mover para depois" onClick={() => mover(i.id, 1)}>→</button>}
            <button type="button" className={styles.fantasma} onClick={() => void remover(i.id)}>Remover</button>
          </div>}
          {p >= 0 && <input aria-label={`Legenda da foto ${n + 1}`} placeholder="Legenda (ajuda quem usa leitor de tela)" maxLength={140} value={conteudo.galeria[p]?.legenda ?? ''} className={styles.link}
            onChange={(e) => editar((c) => ({ ...c, galeria: c.galeria.map((g) => (g.imagemId === i.id ? { ...g, legenda: e.target.value } : g)) }))} />}
        </figure>;
      })}
    </div>}
  </Secao>;
}

function AbaConteudo({ conteudo, editar }: { conteudo: ConteudoSite; editar: Editar }) {
  return <>
    <Secao titulo="Abertura e apresentação" descricao="O título abre a página; o texto aparece em “Sobre”. Separe parágrafos com uma linha em branco.">
      <Campo rotulo="Título da abertura"><input maxLength={120} value={conteudo.apresentacao.titulo} placeholder={conteudo.identidade.nome} onChange={(e) => editar((c) => ({ ...c, apresentacao: { ...c.apresentacao, titulo: e.target.value } }))} /></Campo>
      <Campo rotulo={`Texto de apresentação (${conteudo.apresentacao.texto.length}/2000)`}><textarea rows={7} maxLength={2000} value={conteudo.apresentacao.texto} onChange={(e) => editar((c) => ({ ...c, apresentacao: { ...c.apresentacao, texto: e.target.value } }))} /></Campo>
    </Secao>
    <Secao titulo="Estrutura e diferenciais" descricao="Cada item vira um bloco no site. Escreva só o que o espaço realmente oferece.">
      <Campo rotulo="Capacidade (texto livre)"><input maxLength={80} value={conteudo.estrutura.capacidade} placeholder="ex.: até 120 convidados" onChange={(e) => editar((c) => ({ ...c, estrutura: { ...c.estrutura, capacidade: e.target.value } }))} /></Campo>
      <Campo rotulo="Itens (um por linha, até 20)"><textarea rows={6} value={conteudo.estrutura.itens.join('\n')} placeholder={'Salão climatizado\nBrinquedoteca monitorada\nEstacionamento'} onChange={(e) => editar((c) => ({ ...c, estrutura: { ...c.estrutura, itens: e.target.value.split('\n').map((l) => l.slice(0, 80)).slice(0, 20) } }))} /></Campo>
    </Secao>
    <Secao titulo="Localização">
      <label className={styles.check}><input type="checkbox" checked={conteudo.localizacao.mostrar} onChange={(e) => editar((c) => ({ ...c, localizacao: { ...c.localizacao, mostrar: e.target.checked } }))} /> Mostrar endereço no site</label>
      <div className={styles.grade3}>
        {(['endereco', 'bairro', 'cidade', 'uf', 'cep', 'referencia'] as const).map((k) => <Campo key={k} rotulo={{ endereco: 'Endereço', bairro: 'Bairro', cidade: 'Cidade', uf: 'UF', cep: 'CEP', referencia: 'Referência' }[k]}>
          <input value={conteudo.localizacao[k]} maxLength={k === 'uf' ? 2 : k === 'cep' ? 9 : 200} onChange={(e) => editar((c) => ({ ...c, localizacao: { ...c.localizacao, [k]: e.target.value } }))} /></Campo>)}
        <Campo rotulo="Link do mapa (https://…)"><input value={conteudo.localizacao.linkMapa} maxLength={500} onChange={(e) => editar((c) => ({ ...c, localizacao: { ...c.localizacao, linkMapa: e.target.value } }))} /></Campo>
      </div>
    </Secao>
    <Secao titulo="Contato e formulário">
      <div className={styles.grade2}>
        <Campo rotulo="WhatsApp (com DDD)"><input value={conteudo.contato.whatsapp} maxLength={20} onChange={(e) => editar((c) => ({ ...c, contato: { ...c.contato, whatsapp: e.target.value } }))} /></Campo>
        <Campo rotulo="Telefone"><input value={conteudo.contato.telefone} maxLength={20} onChange={(e) => editar((c) => ({ ...c, contato: { ...c.contato, telefone: e.target.value } }))} /></Campo>
        <Campo rotulo="E-mail"><input value={conteudo.contato.email} maxLength={254} onChange={(e) => editar((c) => ({ ...c, contato: { ...c.contato, email: e.target.value } }))} /></Campo>
        <Campo rotulo="Instagram (https://instagram.com/…)"><input value={conteudo.contato.instagram} maxLength={500} onChange={(e) => editar((c) => ({ ...c, contato: { ...c.contato, instagram: e.target.value } }))} /></Campo>
      </div>
      <label className={styles.check}><input type="checkbox" checked={conteudo.contato.botaoWhatsapp} onChange={(e) => editar((c) => ({ ...c, contato: { ...c.contato, botaoWhatsapp: e.target.checked } }))} /> Botão “Falar no WhatsApp” (o clique é contado separado de contato recebido)</label>
      <label className={styles.check}><input type="checkbox" checked={conteudo.formulario.ativo} onChange={(e) => editar((c) => ({ ...c, formulario: { ...c.formulario, ativo: e.target.checked } }))} /> Formulário de orçamento (pedidos chegam em Origens dos contatos)</label>
      <label className={styles.check}><input type="checkbox" checked={conteudo.formulario.mostrarDatasLivres} onChange={(e) => editar((c) => ({ ...c, formulario: { ...c.formulario, mostrarDatasLivres: e.target.checked } }))} /> Mostrar algumas datas livres da agenda (sem garantir reserva)</label>
    </Secao>
  </>;
}

function AbaPacotes({ conteudo, editar, disponiveis, imagens }: { conteudo: ConteudoSite; editar: Editar; disponiveis: PacoteDisponivel[]; imagens: Imagem[] }) {
  const alterar = (codigo: string, f: (p: ConteudoSite['pacotes'][number]) => ConteudoSite['pacotes'][number]) =>
    editar((c) => ({ ...c, pacotes: c.pacotes.map((x) => (x.codigo === codigo ? f(x) : x)) }));
  return <Secao titulo="Pacotes divulgados" descricao="Escolha os pacotes vigentes que aparecem no site. Nome, descrição, capacidade e duração vêm do cadastro do pacote. O preço “a partir de” é opcional e congela o valor da tabela de hoje no momento da publicação.">
    {disponiveis.length === 0 ? <p className={styles.vazio}>Nenhum pacote vigente cadastrado.</p> : disponiveis.map((p) => {
      const escolhido = conteudo.pacotes.find((x) => x.codigo === p.codigo);
      return <div key={p.codigo} className={ed.pacoteEditor} data-incluido={Boolean(escolhido)}>
        <label className={styles.check}><input type="checkbox" checked={Boolean(escolhido)} onChange={(e) => editar((c) => ({ ...c, pacotes: e.target.checked
          ? [...c.pacotes, { codigo: p.codigo, destaque: '', mostrarPreco: false, imagemId: null }] : c.pacotes.filter((x) => x.codigo !== p.codigo) }))} /> <strong>{p.nome}</strong></label>
        {escolhido && <>
          <div className={styles.grade2}>
            <Campo rotulo="Destaque (opcional)"><input maxLength={140} placeholder="ex.: Mais pedido" value={escolhido.destaque} onChange={(e) => alterar(p.codigo, (x) => ({ ...x, destaque: e.target.value }))} /></Campo>
            <label className={styles.check} style={{ alignSelf: 'end' }}><input type="checkbox" checked={escolhido.mostrarPreco} onChange={(e) => alterar(p.codigo, (x) => ({ ...x, mostrarPreco: e.target.checked }))} /> Mostrar “a partir de”</label>
          </div>
          <div>
            <p className={styles.muted} style={{ margin: '0 0 6px' }}>Foto deste pacote (opcional — use só uma foto que mostre de fato este pacote):</p>
            <div className={ed.miniaturas} role="group" aria-label={`Foto do pacote ${p.nome}`}>
              <button type="button" className={ed.miniatura} aria-pressed={!escolhido.imagemId} onClick={() => alterar(p.codigo, (x) => ({ ...x, imagemId: null }))}>Sem foto</button>
              {imagens.map((i, n) => <button key={i.id} type="button" className={ed.miniatura} aria-pressed={escolhido.imagemId === i.id} aria-label={`Vincular foto ${n + 1} ao pacote ${p.nome}`}
                onClick={() => alterar(p.codigo, (x) => ({ ...x, imagemId: i.id }))}><img src={urlImagemAdmin(i.id)} alt="" /></button>)}
            </div>
          </div>
        </>}
      </div>;
    })}
  </Secao>;
}

function AbaPublicacao({ dados, conteudo, editar, podeEditar, slug, setSlug, versaoRascunho, ocupado, acao, unidadeId, nomeUnidade, rastrear, aoMudarDominios }: {
  dados: Dados; conteudo: ConteudoSite; editar: Editar; podeEditar: boolean; slug: string; setSlug: (v: string) => void; versaoRascunho: number; ocupado: boolean;
  acao: (corpo: Record<string, unknown>, sucesso: string) => Promise<boolean>; unidadeId: string; nomeUnidade: string; rastrear: Rastrear; aoMudarDominios: (siteId: string, d: Dominio[]) => void;
}) {
  const site = dados.site!;
  const pode = (c: string) => dados.capacidades.includes(c);
  return <>
    <Secao titulo={`Situação do site da ${nomeUnidade}`}>
      <p><span className={site.estado === 'PUBLICADO' ? styles.seloAtivo : styles.selo}>{ROTULO_ESTADO_SITE[site.estado]}</span>
        {site.alteracoesNaoPublicadas && site.versaoPublicada && <> <span className={styles.seloAlerta}>rascunho diferente do publicado</span></>}</p>
      <p className={styles.muted}>{site.versaoPublicada ? `Versão ${site.versaoPublicada.numero} publicada em ${dataHoraBr(site.versaoPublicada.publicadoEm)}.` : 'Ainda não publicado.'}
        {site.estado === 'DESPUBLICADO' && ` Despublicado em ${dataHoraBr(site.despublicadoEm)}.`} Salvar o rascunho nunca altera a página publicada: publique quando conferir a prévia.</p>
      {dados.enderecos && <p>Endereço: <code className={styles.link}>{dados.enderecos.plataforma}</code>{site.estado === 'PUBLICADO' && dados.ambiente.sitesPublicos && <> <a href={dados.enderecos.plataforma} target="_blank" rel="noopener">Abrir página publicada</a></>}</p>}
      {dados.enderecos && <p className={styles.muted}>Endereço canônico (SEO): {dados.enderecos.canonical} · Sitemap: {dados.enderecos.sitemap}</p>}
      {!site.versaoPublicada && podeEditar && <div className={styles.filtros}>
        <label>Trocar endereço (só antes da 1ª publicação)<input value={slug} pattern="[a-z][a-z0-9-]{1,62}[a-z0-9]" onChange={(e) => setSlug(e.target.value.toLowerCase())} /></label>
        <button type="button" className={styles.secundario} disabled={ocupado || slug === site.slug} onClick={() => void acao({ acao: 'endereco', siteId: site.id, rascunhoVersao: versaoRascunho, slug }, 'Endereço alterado.')}>Salvar endereço</button>
      </div>}
      {site.pendencias.length > 0 && <div className={styles.aviso}><strong>Antes de publicar:</strong><ul>{site.pendencias.map((p) => <li key={p}>{p}</li>)}</ul></div>}
      {dados.previa && dados.previa.avisos.length > 0 && <div className={styles.aviso}><strong>Na publicação:</strong><ul>{dados.previa.avisos.map((p) => <li key={p}>{p}</li>)}</ul></div>}
      {pode('MARKETING_SITE_PUBLICAR') && site.estado === 'PUBLICADO' && <button type="button" className={styles.fantasma} disabled={ocupado}
        onClick={() => { if (window.confirm('Despublicar? A página deixa de abrir para visitantes (e sai do sitemap).')) void acao({ acao: 'despublicar', siteId: site.id }, 'Site despublicado.'); }}>Despublicar</button>}
    </Secao>

    <fieldset disabled={!podeEditar} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Secao titulo="SEO e compartilhamento">
        <Campo rotulo={`Título para buscadores (${conteudo.seo.titulo.length}/70)`}><input maxLength={70} value={conteudo.seo.titulo} onChange={(e) => editar((c) => ({ ...c, seo: { ...c.seo, titulo: e.target.value } }))} /></Campo>
        <Campo rotulo={`Descrição (${conteudo.seo.descricao.length}/170)`}><textarea rows={3} maxLength={170} value={conteudo.seo.descricao} onChange={(e) => editar((c) => ({ ...c, seo: { ...c.seo, descricao: e.target.value } }))} /></Campo>
        <label className={styles.check}><input type="checkbox" checked={conteudo.seo.indexavel} onChange={(e) => editar((c) => ({ ...c, seo: { ...c.seo, indexavel: e.target.checked } }))} /> Permitir buscadores (só vale para a página publicada no endereço canônico)</label>
        <div className={styles.card} aria-label="Como pode aparecer no buscador"><strong style={{ color: '#8ab4f8' }}>{conteudo.seo.titulo || conteudo.identidade.nome}</strong>
          <span className={styles.muted}>{dados.enderecos?.canonical}</span><span>{conteudo.seo.descricao || 'Sem descrição.'}</span></div>
        <p className={styles.muted}>Nenhuma posição no Google é garantida. Rascunho e prévia nunca são indexados.</p>
      </Secao>
    </fieldset>

    <Dominios siteId={site.id} dominios={dados.dominios ?? []} ambiente={dados.ambiente} pode={pode('MARKETING_DOMINIO_CONFIGURAR')} rastrear={rastrear} aoMudar={(dominios) => aoMudarDominios(site.id, dominios)} />

    {(dados.versoes ?? []).length > 0 && <Secao titulo="Versões publicadas">
      <ul className={styles.historico}>{dados.versoes!.map((v) => <li key={v.id}>Versão {v.numero} · {dataHoraBr(v.publicadoEm)}{v.publicadoPor ? ` · ${v.publicadoPor}` : ''}</li>)}</ul>
    </Secao>}
    <p className={styles.muted}>Prévia em tela cheia do rascunho salvo: <a href={`/admin/marketing/site/previa${unidadeId ? `?unidadeId=${unidadeId}` : ''}`} target="_blank" rel="noopener">abrir</a>.</p>
  </>;
}

function Dominios({ siteId, dominios, ambiente, pode, aoMudar, rastrear }: {
  siteId: string; dominios: Dominio[]; ambiente: Dados['ambiente']; pode: boolean; aoMudar: (d: Dominio[]) => void; rastrear: Rastrear;
}) {
  const [host, setHost] = useState('');
  const [www, setWww] = useState(false);
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  async function acao(corpo: Record<string, unknown>) {
    setOcupado(true); setErro('');
    try { const r = await rastrear(() => enviarMarketing<{ dominios: Dominio[]; resultado: { status?: string; verificacao?: { detalhe: string } } }>('/api/admin/marketing/dominios', corpo)); aoMudar(r.dominios);
      if (r.resultado?.status === 'FALHOU') setErro(r.resultado.verificacao?.detalhe ?? 'Verificação não encontrou os registros.'); }
    catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível concluir.'); }
    finally { setOcupado(false); }
  }
  return <section className={styles.cartao} aria-label="Domínio">
    <h2>Domínio personalizado <span className={styles.seloSimulado}>provedor simulado</span></h2>
    <p className={styles.muted}>Fluxo de demonstração local: as instruções de DNS são reais no formato, mas a verificação e o HTTPS são SIMULADOS — nenhum DNS é consultado ou alterado e nenhum certificado é emitido. A compra e a renovação do domínio continuam com o buffet.</p>
    {!ambiente.dominiosPersonalizados && <p className={styles.aviso}>Domínios personalizados estão desligados neste servidor (MARKETING_DOMINIOS_PERSONALIZADOS). O cadastro pode ser exercitado, mas nenhum Host é atendido.</p>}
    {dominios.length === 0 && <p className={styles.vazio}>Nenhum domínio. O site continua no endereço da plataforma.</p>}
    {dominios.map((d) => <article key={d.id} className={styles.card}>
      <p><strong>{d.host}</strong> {d.principal && <span className={styles.seloVioleta}>principal</span>} <span className={d.status === 'ATIVO' ? styles.seloSimulado : d.status === 'FALHOU' ? styles.seloAlerta : styles.selo}>{rotuloDominio(d.status, d.simulado)}</span></p>
      {d.status !== 'REMOVIDO' && d.status !== 'ATIVO' && <div className={styles.muted}>
        <p>1. Registro {d.instrucoes.verificacao.tipo} <code>{d.instrucoes.verificacao.nome}</code> = <code>{d.instrucoes.verificacao.valor}</code></p>
        <p>2. Registro {d.instrucoes.apontamento.tipo} <code>{d.instrucoes.apontamento.nome}</code> → <code>{d.instrucoes.apontamento.valor}</code>. {d.instrucoes.apontamento.observacao}</p>
        <p>Não altere registros de e-mail (MX/SPF/DKIM). Propagação pode levar horas no DNS real.</p>
      </div>}
      {d.status === 'ATIVO' && d.simulado && <p className={styles.muted}>{ambiente.dominioSimuladoServido ? `Atendido localmente pelo Host ${d.host} (demonstração; noindex).` : 'Ativo apenas como simulação: este servidor não atende domínio simulado.'}</p>}
      {pode && d.status !== 'REMOVIDO' && <div className={styles.acoes}>
        {d.status !== 'ATIVO' && <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => void acao({ acao: 'simular-dns', id: d.id })}>Simular DNS configurado</button>}
        <button type="button" className={styles.secundario} disabled={ocupado} onClick={() => void acao({ acao: 'verificar', id: d.id })}>{d.status === 'ATIVO' ? 'Reverificar' : 'Verificar'}</button>
        {!d.principal && <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => void acao({ acao: 'principal', id: d.id })}>Tornar principal</button>}
        <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => { if (window.confirm(`Remover ${d.host}? Deixa de abrir o site na hora; para voltar, cadastre e verifique de novo.`)) void acao({ acao: 'remover', id: d.id }); }}>Remover</button>
      </div>}
    </article>)}
    {pode && <form className={styles.filtros} onSubmit={(e) => { e.preventDefault(); if (host.trim()) void acao({ acao: 'solicitar', siteId, host: host.trim(), incluirWww: www }).then(() => setHost('')); }}>
      <label>Domínio<input value={host} placeholder="festas.seubuffet.com.br" onChange={(e) => setHost(e.target.value)} /></label>
      <label className={styles.check}><input type="checkbox" checked={www} onChange={(e) => setWww(e.target.checked)} /> Incluir também www (apelido que redireciona)</label>
      <button type="submit" className={styles.secundario} disabled={ocupado}>Adicionar domínio</button>
    </form>}
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
  </section>;
}
