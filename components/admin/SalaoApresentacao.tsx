'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Apresentacao, ItemInformado } from '@/lib/agenda/salao-apresentacao';
import type { ItemGarantido, OpcaoCardapio } from '@/lib/agenda/salao-pacotes';
import {
  EXCLUSIVOS, GRUPOS_ITEM, MAX_DESTAQUES, NOMES_EXCLUSIVO, NOMES_GRUPO, normalizarTexto, type Exclusivo, type GrupoItem,
} from '@/lib/agenda/salao-apresentacao-regras';
import { adminFetch } from '@/lib/http/admin-fetch';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import { ler } from './AssistenteAgenda';
import css from './salao-apresentacao.module.css';
import ws from './workspace.module.css';

/**
 * Configurações › Salões › salão (102): como o salão aparece para o cliente. Plano rev. 4 (25/10/2026):
 *   * nome, máximo de convidados e ativo são da Agenda (só leitura aqui, link para editar lá);
 *   * fotos e legendas gravam na hora; campos e itens gravam em "Salvar"; toda gravação leva a versão vista;
 *   * a declaração só é possível com tudo salvo e o resto pronto; qualquer mudança depois a anula (no banco).
 */
type Dados = {
  gestao: boolean;
  apresentacao: Apresentacao;
  pacotes: { pacotes: number; emTodos: ItemGarantido[]; garantidos: ItemGarantido[]; opcoes: OpcaoCardapio[] };
  site: { disponivel: boolean; imagens: { id: string; descricao: string | null; largura: number; altura: number }[] };
};
type Campos = {
  convidadosMinimo: string; convidadosSentados: string; areaM2: string; idadeMin: string; idadeMax: string; frase: string;
  outraFestaSimultanea: boolean | null; exclusivos: Exclusivo[]; fotosReferencia: string;
};
type ItemForm = ItemInformado & { chave: string; nome: string };

const numeroOuNulo = (t: string) => (t.trim() === '' ? null : Number(t));
const camposDe = (a: Apresentacao): Campos => ({
  convidadosMinimo: a.campos.convidadosMinimo?.toString() ?? '', convidadosSentados: a.campos.convidadosSentados?.toString() ?? '',
  areaM2: a.campos.areaM2?.toString() ?? '', idadeMin: a.campos.idadeMin?.toString() ?? '', idadeMax: a.campos.idadeMax?.toString() ?? '',
  frase: a.campos.frase ?? '', outraFestaSimultanea: a.campos.outraFestaSimultanea, exclusivos: [...a.campos.exclusivos],
  fotosReferencia: a.campos.fotosReferencia ?? '',
});
const itensDe = (a: Apresentacao): ItemForm[] => a.itens.map((i) => ({
  chave: i.id, id: i.id, grupo: i.grupo, codigo: i.codigo, proprio: i.proprio, detalhe: i.detalhe, destaque: i.destaque, nome: i.nome,
}));
const urlSalao = (id: string) => `/api/admin/configuracoes/saloes/${id}`;
const urlFoto = (id: string, fotoId: string) => `/api/admin/configuracoes/saloes/${id}/fotos/${fotoId}`;

export default function SalaoApresentacao({ salaoId }: { salaoId: string }) {
  const [dados, setDados] = useState<Dados | null>(null);
  const [campos, setCampos] = useState<Campos | null>(null);
  const [itens, setItens] = useState<ItemForm[]>([]);
  const [alterado, setAlterado] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [mensagem, setMensagem] = useState('');
  const [novos, setNovos] = useState<Record<GrupoItem, string>>({ BRINCADEIRAS: '', ADULTOS: '', CONFORTO: '', ESPACO: '' });
  const [legendaNova, setLegendaNova] = useState('');
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [verSite, setVerSite] = useState(false);
  const [confirmo, setConfirmo] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const d = (await ler(await adminFetch(urlSalao(salaoId), { cache: 'no-store' }))).data as Dados;
      setErro('');
      setDados(d);
      setCampos(camposDe(d.apresentacao));
      setItens(itensDe(d.apresentacao));
      setAlterado(false);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível carregar o salão.');
    }
  }, [salaoId]);
  useEffect(() => {
    let ativo = true;
    void (async () => {
      try {
        const d = (await ler(await adminFetch(urlSalao(salaoId), { cache: 'no-store' }))).data as Dados;
        if (!ativo) return;
        setDados(d);
        setCampos(camposDe(d.apresentacao));
        setItens(itensDe(d.apresentacao));
      } catch (e) {
        if (ativo) setErro(e instanceof Error ? e.message : 'Não foi possível carregar o salão.');
      }
    })();
    return () => { ativo = false; };
  }, [salaoId]);

  /** Ação que grava na hora (fotos, declaração): atualiza a versão e a lista sem perder campos/itens não salvos. */
  async function acao(corpo: Record<string, unknown>, sucesso: string): Promise<boolean> {
    if (!dados) return false;
    setOcupado(true); setErro(''); setMensagem('');
    try {
      const a = (await ler(await adminFetch(urlSalao(salaoId), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...corpo, versao: dados.apresentacao.conteudoVersao }) }))).data as Apresentacao;
      setDados({ ...dados, apresentacao: a });
      if (!alterado) { setCampos(camposDe(a)); setItens(itensDe(a)); }
      setMensagem(sucesso);
      return true;
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível concluir.');
      return false;
    } finally {
      setOcupado(false);
    }
  }

  async function salvar() {
    if (!dados || !campos) return;
    const corpo = {
      acao: 'salvar',
      campos: {
        convidadosMinimo: numeroOuNulo(campos.convidadosMinimo), convidadosSentados: numeroOuNulo(campos.convidadosSentados),
        areaM2: numeroOuNulo(campos.areaM2), idadeMin: numeroOuNulo(campos.idadeMin), idadeMax: numeroOuNulo(campos.idadeMax),
        frase: campos.frase.trim() === '' ? null : campos.frase, outraFestaSimultanea: campos.outraFestaSimultanea,
        exclusivos: campos.exclusivos, fotosReferencia: campos.fotosReferencia || null,
      },
      itens: itens.map(({ id, grupo, codigo, proprio, detalhe, destaque }) => ({ id, grupo, codigo: codigo ?? null, proprio: proprio ?? null, detalhe: detalhe || null, destaque })),
    };
    // Só recarrega (e descarta o formulário) quando gravou; na falha as edições continuam na tela.
    if (await acao(corpo, 'Salão salvo.')) await carregar();
  }

  async function enviarFoto() {
    if (!dados || !arquivo) return;
    setOcupado(true); setErro(''); setMensagem('');
    try {
      const form = new FormData();
      form.set('arquivo', arquivo);
      const q = new URLSearchParams({ versao: String(dados.apresentacao.conteudoVersao), legenda: legendaNova });
      const a = (await ler(await adminFetch(`${urlSalao(salaoId)}/fotos?${q}`, { method: 'POST', body: form }))).data as Apresentacao;
      setDados({ ...dados, apresentacao: a });
      setArquivo(null); setLegendaNova('');
      setMensagem('Foto enviada.');
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível enviar a foto.');
    } finally {
      setOcupado(false);
    }
  }

  const a = dados?.apresentacao;
  const catalogoPorGrupo = useMemo(() => {
    const m = new Map<GrupoItem, Apresentacao['catalogo']>();
    for (const g of GRUPOS_ITEM) m.set(g, (a?.catalogo ?? []).filter((c) => c.grupo === g));
    return m;
  }, [a?.catalogo]);
  if (!a || !campos || !dados) return <main className={ws.page} data-admin-workspace><div className={ws.content}>{erro ? <p role="alert">{erro}</p> : <p className={ws.muted}>Carregando…</p>}</div></main>;

  const bloqueado = !dados.gestao || ocupado;
  const alterarCampos = (p: Partial<Campos>) => { setCampos({ ...campos, ...p }); setAlterado(true); };
  const alterarItens = (lista: ItemForm[]) => { setItens(lista); setAlterado(true); };
  const destaques = itens.filter((i) => i.destaque).length;
  const marcado = (codigo: string) => itens.find((i) => i.codigo === codigo);
  const alternarCatalogo = (c: Apresentacao['catalogo'][number]) => {
    const atual = marcado(c.codigo);
    alterarItens(atual ? itens.filter((i) => i !== atual) : [...itens, { chave: `novo-${c.codigo}`, grupo: c.grupo, codigo: c.codigo, nome: c.nome, destaque: false }]);
  };
  const alternarDestaque = (item: ItemForm) => {
    if (!item.destaque && destaques >= MAX_DESTAQUES) { setErro(`Escolha no máximo ${MAX_DESTAQUES} destaques.`); return; }
    alterarItens(itens.map((i) => (i === item ? { ...i, destaque: !i.destaque } : i)));
  };
  const adicionarProprio = (grupo: GrupoItem) => {
    const texto = normalizarTexto(novos[grupo]);
    if (!texto) return;
    alterarItens([...itens, { chave: `novo-${grupo}-${texto}`, grupo, proprio: texto, nome: texto, destaque: false }]);
    setNovos({ ...novos, [grupo]: '' });
  };
  const fotos = a.fotos;
  const mover = (indice: number, delta: number) => {
    const ids = fotos.map((f) => f.id);
    const alvo = indice + delta;
    if (alvo < 0 || alvo >= ids.length) return;
    [ids[indice], ids[alvo]] = [ids[alvo], ids[indice]];
    void acao({ acao: 'reordenar', fotos: ids }, 'Ordem das fotos salva.');
  };
  const sugestao = a.idadeSugerida;
  const destaquesPrevia = itens.filter((i) => i.destaque).map((i) => (i.detalhe ? `${i.nome} (${i.detalhe})` : i.nome));
  const numerosPrevia = [
    a.salao.capacidadeConvidados ? `Até ${a.salao.capacidadeConvidados} convidados` : null,
    campos.convidadosSentados ? `${campos.convidadosSentados} sentados` : null,
    campos.idadeMin && campos.idadeMax ? `${campos.idadeMin} a ${campos.idadeMax} anos` : sugestao ? `${sugestao.min} a ${sugestao.max} anos` : null,
  ].filter(Boolean).join(' · ');

  return <main className={ws.page} data-admin-workspace>
    <header className={ws.header}>
      <div>
        <Link className={css.voltar} href="/admin/configuracoes/saloes">← Salões</Link>
        <h1>{a.salao.nome}{a.salao.unidade ? ` · ${a.salao.unidade}` : ''}</h1>
      </div>
      <div className={css.barra}>
        {alterado && <span className={ws.muted}>Alterações não salvas</span>}
        <button type="button" disabled={bloqueado || !alterado} onClick={() => { setCampos(camposDe(a)); setItens(itensDe(a)); setAlterado(false); }}>Descartar</button>
        <AdminPrimaryButton carregando={ocupado} disabled={bloqueado || !alterado} onClick={() => void salvar()}>Salvar salão</AdminPrimaryButton>
      </div>
    </header>
    <div className={ws.content}>
      {!dados.gestao && <p className={css.aviso}>Somente quem tem Gestão pode alterar a apresentação dos salões.</p>}
      {erro && <p role="alert">{erro}</p>}
      {mensagem && <p className={css.sucesso} role="status">{mensagem}</p>}
      <div className={css.layout}>
        <div className={css.principal}>
          <section className={ws.card} aria-labelledby="salao-apresentacao">
            <h2 id="salao-apresentacao">1. Apresentação</h2>
            <div className={css.grade2}>
              <div>
                <label>Nome<span className={css.somenteLeitura}>{a.salao.nome}<Link href="/admin/configuracoes/agenda">Editar na Agenda</Link></span></label>
              </div>
              <div className={css.grade2}>
                <label>Idade: de<input type="number" min={0} max={17} value={campos.idadeMin} placeholder={sugestao ? String(sugestao.min) : ''} disabled={bloqueado} onChange={(e) => alterarCampos({ idadeMin: e.target.value })} /></label>
                <label>até<input type="number" min={0} max={17} value={campos.idadeMax} placeholder={sugestao ? String(sugestao.max) : ''} disabled={bloqueado} onChange={(e) => alterarCampos({ idadeMax: e.target.value })} /></label>
              </div>
            </div>
            {sugestao && <p className={css.dica}><span className={css.sugerida}>Sugerida pelos itens: {sugestao.min} a {sugestao.max} anos.</span> Deixe em branco para usar a sugestão, ou ajuste.</p>}
            <label>Frase curta · {campos.frase.length}/80<input maxLength={80} value={campos.frase} disabled={bloqueado} placeholder="Ex.: Mais espaço para correr, com o brinquedão maior da casa." onChange={(e) => alterarCampos({ frase: e.target.value })} /></label>
          </section>

          <section className={ws.card} aria-labelledby="salao-capacidade">
            <h2 id="salao-capacidade">2. Capacidade e tamanho</h2>
            <div className={css.grade4}>
              <label>Máximo de convidados<span className={css.somenteLeitura}>{a.salao.capacidadeConvidados ?? '—'}</span></label>
              <label>Sentados<input type="number" min={1} value={campos.convidadosSentados} disabled={bloqueado} onChange={(e) => alterarCampos({ convidadosSentados: e.target.value })} /></label>
              <label>Mínimo · opcional<input type="number" min={1} value={campos.convidadosMinimo} disabled={bloqueado} onChange={(e) => alterarCampos({ convidadosMinimo: e.target.value })} /></label>
              <label>Área (m²) · opcional<input type="number" min={1} max={5000} value={campos.areaM2} disabled={bloqueado} onChange={(e) => alterarCampos({ areaM2: e.target.value })} /></label>
            </div>
            <p className={css.dica}>O máximo vem da Agenda. Sentados e mínimo não podem passar dele. Estes números serão usados no cartão e na comparação dos salões quando a página pública for ligada.</p>
          </section>

          <section className={ws.card} aria-labelledby="salao-fotos">
            <h2 id="salao-fotos">3. Fotos · {fotos.length} de {a.limites.fotos}</h2>
            <div className={css.fotos}>
              {fotos.map((f, i) => <div className={css.foto} key={f.id}>
                {/* eslint-disable-next-line @next/next/no-img-element -- prévia privada do painel, sem otimização */}
                <img src={urlFoto(salaoId, f.id)} alt={f.legenda} />
                {i === 0 && <span className={css.capa}>Capa</span>}
                <div className={css.fotoCorpo}>
                  <label>Legenda<input defaultValue={f.legenda} maxLength={60} disabled={bloqueado}
                    onBlur={(e) => { const v = normalizarTexto(e.target.value); if (v && v !== f.legenda) void acao({ acao: 'legenda', fotoId: f.id, legenda: v }, 'Legenda salva.'); }} /></label>
                  <div className={css.fotoAcoes}>
                    <button type="button" aria-label={`Mover ${f.legenda} para trás`} disabled={bloqueado || i === 0} onClick={() => mover(i, -1)}>←</button>
                    <button type="button" aria-label={`Mover ${f.legenda} para frente`} disabled={bloqueado || i === fotos.length - 1} onClick={() => mover(i, 1)}>→</button>
                    <button type="button" className="danger" disabled={bloqueado} onClick={() => void acao({ acao: 'remover_foto', fotoId: f.id }, 'Foto removida.')}>Remover</button>
                  </div>
                </div>
              </div>)}
            </div>
            {fotos.length < a.limites.fotos && <div className={css.grade2}>
              <label>Nova foto (PNG, JPEG ou WebP até 8 MB)<input type="file" accept="image/png,image/jpeg,image/webp" disabled={bloqueado} onChange={(e) => setArquivo(e.target.files?.[0] ?? null)} /></label>
              <label>Legenda (nome do ambiente)<input value={legendaNova} maxLength={60} disabled={bloqueado} placeholder="Ex.: Brinquedão" onChange={(e) => setLegendaNova(e.target.value)} /></label>
            </div>}
            <div className={css.barra}>
              {dados.site.disponivel && dados.site.imagens.length > 0 && fotos.length < a.limites.fotos &&
                <button type="button" disabled={bloqueado} onClick={() => setVerSite(!verSite)}>Usar fotos do site da unidade</button>}
              {fotos.length < a.limites.fotos && <button type="button" disabled={bloqueado || !arquivo || !normalizarTexto(legendaNova)} onClick={() => void enviarFoto()}>Enviar foto</button>}
            </div>
            {verSite && <>
              <p className={css.dica}>Escolha uma imagem do site. A legenda usada é a descrição da imagem (ajuste depois, se precisar).</p>
              <div className={css.seletorSite}>
                {dados.site.imagens.map((img) => <button type="button" key={img.id} disabled={bloqueado} aria-label={`Copiar ${img.descricao ?? 'imagem do site'}`}
                  onClick={() => void acao({ acao: 'copiar_do_site', imagemId: img.id, legenda: normalizarTexto(img.descricao ?? '') || 'Foto do site' }, 'Foto copiada do site.')}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- prévia privada do painel */}
                  <img src={`/api/admin/marketing/site/imagens/${img.id}`} alt={img.descricao ?? 'Imagem do site'} />
                </button>)}
              </div>
            </>}
            <p className={css.dica}>Ordem sugerida: salão montado → brinquedão → espaço baby → adultos → fraldário e banheiros → entrada. Mínimo de 6 fotos com legenda para o salão ficar pronto para o cliente.</p>
            <label>Fotos tiradas em<input type="month" value={campos.fotosReferencia} disabled={bloqueado} onChange={(e) => alterarCampos({ fotosReferencia: e.target.value })} /></label>
            {a.avisos.map((t) => <p className={css.aviso} key={t}>{t}</p>)}
          </section>

          <section className={ws.card} aria-labelledby="salao-itens">
            <h2 id="salao-itens">4. O que o salão tem (estrutura física)</h2>
            <p className={css.dica}>★ = destaque no cartão · {destaques} de {MAX_DESTAQUES}. O que depende do pacote (cardápio, monitores, decoração) fica no pacote.</p>
            {GRUPOS_ITEM.map((g) => <div className={css.grupo} key={g}>
              <h3>{NOMES_GRUPO[g]}</h3>
              <div className={css.chips}>
                {(catalogoPorGrupo.get(g) ?? []).filter((c) => c.ativo || marcado(c.codigo)).map((c) => {
                  const item = marcado(c.codigo);
                  return <span className={css.chip} aria-pressed={Boolean(item)} key={c.codigo}>
                    <button type="button" disabled={bloqueado} aria-pressed={Boolean(item)} onClick={() => alternarCatalogo(c)}>{item ? '✓ ' : ''}{c.nome}</button>
                    {item && <button type="button" className={css.estrela} aria-pressed={item.destaque} aria-label={`Destaque: ${c.nome}`} disabled={bloqueado} onClick={() => alternarDestaque(item)}>{item.destaque ? '★' : '☆'}</button>}
                    {item && c.pedeDetalhe && <input className={css.detalhe} aria-label={`Detalhe de ${c.nome}`} maxLength={40} placeholder={c.codigo === 'ESTACIONAMENTO' ? 'nº de vagas' : 'detalhe'} value={item.detalhe ?? ''} disabled={bloqueado}
                      onChange={(e) => alterarItens(itens.map((i) => (i === item ? { ...i, detalhe: e.target.value } : i)))} />}
                  </span>;
                })}
                {itens.filter((i) => i.grupo === g && i.proprio).map((item) => <span className={css.chip} aria-pressed key={item.chave}>
                  <span>✓ {item.proprio}</span>
                  <button type="button" className={css.estrela} aria-pressed={item.destaque} aria-label={`Destaque: ${item.proprio}`} disabled={bloqueado} onClick={() => alternarDestaque(item)}>{item.destaque ? '★' : '☆'}</button>
                  <button type="button" aria-label={`Remover ${item.proprio}`} disabled={bloqueado} onClick={() => alterarItens(itens.filter((i) => i !== item))}>×</button>
                </span>)}
              </div>
              <div className={css.novoItem}>
                <input aria-label={`Item próprio em ${NOMES_GRUPO[g]}`} maxLength={60} placeholder="+ item próprio" value={novos[g]} disabled={bloqueado}
                  onChange={(e) => setNovos({ ...novos, [g]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); adicionarProprio(g); } }} />
                <button type="button" disabled={bloqueado || !novos[g].trim()} onClick={() => adicionarProprio(g)}>Adicionar</button>
              </div>
            </div>)}
          </section>

          <section className={ws.card} aria-labelledby="salao-pacotes">
            <h2 id="salao-pacotes">Nos pacotes deste salão · só leitura</h2>
            {dados.pacotes.pacotes === 0
              ? <p className={ws.muted}>Nenhum pacote ligado a este salão. <Link href="/admin/configuracoes/pacotes">Ir para Pacotes</Link></p>
              : <>
                <p className={css.dica}>{dados.pacotes.pacotes} pacote(s) ligado(s). Antes de o cliente escolher o pacote, só aparece o que está em todos eles.</p>
                <div className={css.lista}>
                  {dados.pacotes.garantidos.map((g) => <div className={css.linha} key={g.chave}><span>{g.nome}</span>
                    {g.pacotes === dados.pacotes.pacotes ? <span className={css.emTodos}>em todos → será mostrado ao cliente</span>
                      : <span className={css.parcial}>em {g.pacotes} de {dados.pacotes.pacotes} → &quot;varia conforme o pacote&quot;</span>}</div>)}
                  {dados.pacotes.garantidos.length === 0 && <div className={css.linha}><span className={ws.muted}>Nenhum item fixo nem adicional incluso nos pacotes.</span></div>}
                </div>
                {dados.pacotes.opcoes.length > 0 && <p className={css.dica}>Cardápio de escolha (não aparece como garantido): {dados.pacotes.opcoes.map((o) => `${o.pacote}: ${o.categoria} (${o.escolhasMin === 0 ? 'opcional' : `escolhe ${o.escolhasMin}`}${o.escolhasMax > o.escolhasMin ? ` a ${o.escolhasMax}` : ''})`).join(' · ')}.</p>}
                <p className={css.dica}>Para mudar, edite os pacotes. Monitores e recreação entram como adicionais da categoria Serviços. <Link href="/admin/configuracoes/pacotes">Ir para Pacotes</Link></p>
              </>}
          </section>

          <section className={ws.card} aria-labelledby="salao-convivencia">
            <h2 id="salao-convivencia">5. Quando há festa no outro salão</h2>
            <p className={css.dica}>O outro salão pode ter festa no mesmo horário?</p>
            <div className={css.chips}>
              <button type="button" className={css.chip} aria-pressed={campos.outraFestaSimultanea === true} disabled={bloqueado} onClick={() => alterarCampos({ outraFestaSimultanea: true })}>Sim</button>
              <button type="button" className={css.chip} aria-pressed={campos.outraFestaSimultanea === false} disabled={bloqueado} onClick={() => alterarCampos({ outraFestaSimultanea: false, exclusivos: [] })}>Não, uma festa por vez</button>
            </div>
            {campos.outraFestaSimultanea && <>
              <p className={css.dica}>Só da festa deste salão:</p>
              <div className={css.chips}>
                {EXCLUSIVOS.map((e) => {
                  const ativo = campos.exclusivos.includes(e);
                  return <button type="button" key={e} className={css.chip} aria-pressed={ativo} disabled={bloqueado}
                    onClick={() => alterarCampos({ exclusivos: ativo ? campos.exclusivos.filter((x) => x !== e) : [...campos.exclusivos, e] })}>{ativo ? '✓ ' : ''}{NOMES_EXCLUSIVO[e]}</button>;
                })}
              </div>
              <p className={css.dica}>A tela do cliente sempre mostra que o outro salão pode receber outra festa. Isso não pode ser escondido.</p>
            </>}
          </section>
        </div>

        <aside className={css.lateral} aria-labelledby="salao-pronto">
          <section className={ws.card}>
            <h2 id="salao-pronto">Pronto para o cliente?</h2>
            <ul className={css.checklist}>
              {a.publicavel.ok ? <li className={css.ok}>✓ Pronto. O salão vai aparecer ao cliente quando a página pública dos salões for ligada.</li>
                : a.publicavel.pendencias.map((p) => <li className={css.falta} key={p.codigo}>! {p.texto}</li>)}
            </ul>
            {!a.publicavel.ok && a.publicavel.pendencias.length === 1 && a.publicavel.pendencias[0].codigo === 'SEM_DECLARACAO' && <>
              <label className={css.declaracao}><input type="checkbox" checked={confirmo} disabled={bloqueado || alterado} onChange={(e) => setConfirmo(e.target.checked)} />
                <span>Confirmo que fotos, capacidade e itens mostram o salão como ele está hoje. O que for mostrado ao cliente vale como oferta (CDC, art. 30).</span></label>
              {alterado && <p className={css.dica}>Salve as alterações antes de confirmar.</p>}
              <AdminPrimaryButton carregando={ocupado} disabled={bloqueado || alterado || !confirmo} onClick={() => { setConfirmo(false); void acao({ acao: 'declarar' }, 'Salão confirmado.'); }}>Confirmar salão</AdminPrimaryButton>
            </>}
            <h3>Prévia: como o cliente vai ver</h3>
            <article className={css.previa} aria-label="Prévia do cartão do salão">
              {fotos[0]
                // eslint-disable-next-line @next/next/no-img-element -- prévia privada do painel
                ? <img src={urlFoto(salaoId, fotos[0].id)} alt={fotos[0].legenda} />
                : <div className={css.previaSemFoto} />}
              <strong>{a.salao.nome}</strong>
              {numerosPrevia && <span className={css.previaNumeros}>{numerosPrevia}</span>}
              {campos.frase.trim() && <p className={css.previaFrase}>{campos.frase.trim()}</p>}
              {destaquesPrevia.length > 0 && <ul>{destaquesPrevia.map((d) => <li key={d}>{d}</li>)}</ul>}
              {campos.fotosReferencia && <span className={css.previaPequena}>Fotos de {campos.fotosReferencia.split('-').reverse().join('/')}</span>}
            </article>
          </section>
        </aside>
      </div>
    </div>
  </main>;
}
