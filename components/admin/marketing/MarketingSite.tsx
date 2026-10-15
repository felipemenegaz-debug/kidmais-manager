'use client';
/* eslint-disable @next/next/no-img-element -- Miniaturas da prévia servidas pela rota administrativa (WebP já reprocessado), sem otimizador remoto. */
import { useEffect, useRef, useState } from 'react';
import type { ConteudoSite } from '@/lib/marketing/site/conteudo';
import type { SiteAdmin } from '@/lib/marketing/site/servico';
import type { Dominio } from '@/lib/marketing/dominios/servico';
import { adminFetch } from '@/lib/http/admin-fetch';
import { dataHoraBr, ROTULO_ESTADO_SITE, rotuloDominio } from '@/lib/marketing/apresentacao';
import { AdminPrimaryButton } from '../AdminPrimaryButton';
import { CabecalhoMarketing, EstadoCarga, enviarMarketing, useMarketing } from './comum';
import styles from './marketing.module.css';

type Imagem = { id: string; largura: number; altura: number; bytes: number; descricao: string | null; criadoEm: string };
type Dados = {
  site: SiteAdmin | null; unidades: Array<{ id: string; nome: string }>; imagens?: Imagem[]; versoes?: Array<{ id: string; numero: number; publicadoEm: string; publicadoPor: string | null }>;
  dominios?: Dominio[]; pacotesDisponiveis?: Array<{ codigo: string; nome: string }>; enderecos?: { plataforma: string; canonical: string; sitemap: string };
  previa?: { avisos: string[] }; ambiente: { sitesPublicos: boolean; dominiosPersonalizados: boolean; dominioSimuladoServido: boolean }; capacidades: string[]; avisos?: string[];
};

export default function MarketingSite() {
  const [unidadeId, setUnidadeId] = useState('');
  const url = `/api/admin/marketing/site${unidadeId ? `?unidadeId=${unidadeId}` : ''}`;
  const { dados, falha, carregando, recarregar, setDados } = useMarketing<Dados>(url);
  // Edição local amarrada à versão do rascunho no servidor: salvou/recarregou (nova versão) = edição local descartada.
  const [edicao, setEdicao] = useState<{ chave: string; conteudo: ConteudoSite } | null>(null);
  const [slugEditado, setSlugEditado] = useState<{ chave: string; slug: string } | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const chave = dados?.site ? `${dados.site.id}:${dados.site.rascunhoVersao}` : 'novo';
  const sujo = edicao?.chave === chave;
  const conteudo: ConteudoSite | null = dados?.site ? (sujo ? edicao!.conteudo : dados.site.rascunho) : null;
  const versaoRascunho = dados?.site?.rascunhoVersao ?? 0;
  const slug = slugEditado?.chave === chave ? slugEditado.slug : dados?.site?.slug ?? '';
  const setSlug = (valor: string) => setSlugEditado({ chave, slug: valor });
  useEffect(() => {
    if (!sujo) return;
    const sair = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', sair);
    return () => window.removeEventListener('beforeunload', sair);
  }, [sujo]);

  const pode = (c: string) => dados?.capacidades.includes(c) ?? false;
  const editar = (alteracao: (c: ConteudoSite) => ConteudoSite) => { if (conteudo) setEdicao({ chave, conteudo: alteracao(conteudo) }); };

  async function acao(corpo: Record<string, unknown>, sucesso: string) {
    setOcupado(true); setAviso(null);
    try {
      const novo = await enviarMarketing<Dados>('/api/admin/marketing/site', corpo);
      setDados({ ...novo, capacidades: dados?.capacidades ?? [] });
      setAviso({ tipo: 'ok', texto: [sucesso, ...(novo.avisos ?? [])].join(' ') });
    } catch (e) { setAviso({ tipo: 'erro', texto: e instanceof Error ? e.message : 'Não foi possível concluir.' }); }
    finally { setOcupado(false); }
  }
  const salvar = () => conteudo && dados?.site && acao({ acao: 'salvar', siteId: dados.site.id, rascunhoVersao: versaoRascunho, conteudo }, 'Rascunho salvo. Nada mudou no site publicado.');

  return <main className={styles.pagina}>
    <CabecalhoMarketing titulo="Site e SEO" descricao="Site público do buffet: rascunho com prévia, publicação e despublicação. Só o que está publicado aparece para os visitantes." />
    {dados && dados.unidades.length > 0 && <div className={styles.filtros}><label>Unidade<select value={unidadeId} onChange={(e) => { if (!sujo || window.confirm('Descartar alterações não salvas?')) setUnidadeId(e.target.value); }}>
      <option value="">Empresa (sem unidade)</option>{dados.unidades.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select></label></div>}
    <EstadoCarga carregando={carregando && !dados} falha={falha} aoTentar={recarregar} />
    {dados && !dados.ambiente.sitesPublicos && <p className={styles.aviso}>A publicação está desligada neste ambiente (MARKETING_SITES_PUBLICOS). Você pode editar e publicar, mas a página pública só abre quando o servidor ligar o recurso.</p>}
    {aviso && <p className={aviso.tipo === 'ok' ? styles.info : styles.aviso} role={aviso.tipo === 'ok' ? 'status' : 'alert'}>{aviso.texto}</p>}
    {dados && !dados.site && <section className={styles.cartao}>
      <h2>Criar o site</h2>
      <p>O rascunho começa com o nome comercial, endereço e contatos do cadastro aplicado da empresa. Você escolhe o que publicar.</p>
      {pode('MARKETING_SITE_EDITAR') ? <div className={styles.filtros}>
        <label>Endereço (opcional)<input value={slug} placeholder="ex.: buffet-alegria" pattern="[a-z][a-z0-9-]{1,62}[a-z0-9]" onChange={(e) => setSlug(e.target.value.toLowerCase())} /></label>
        <AdminPrimaryButton type="button" carregando={ocupado} onClick={() => void acao({ acao: 'criar', unidadeId: unidadeId || null, ...(slug ? { slug } : {}) }, 'Site criado como rascunho.')}>Criar rascunho</AdminPrimaryButton>
      </div> : <p className={styles.muted}>Seu acesso não inclui editar o site.</p>}
    </section>}
    {dados?.site && conteudo && <div className={styles.editor}>
      <section className={styles.cartao} aria-labelledby="t-situacao">
        <h2 id="t-situacao">Situação <span className={dados.site.estado === 'PUBLICADO' ? styles.seloAtivo : styles.selo}>{ROTULO_ESTADO_SITE[dados.site.estado]}</span>
          {dados.site.alteracoesNaoPublicadas && dados.site.versaoPublicada && <> <span className={styles.seloAlerta}>alterações não publicadas</span></>}</h2>
        <p className={styles.muted}>{dados.site.versaoPublicada ? `Versão ${dados.site.versaoPublicada.numero} publicada em ${dataHoraBr(dados.site.versaoPublicada.publicadoEm)}.` : 'Ainda não publicado.'}
          {dados.site.estado === 'DESPUBLICADO' && ` Despublicado em ${dataHoraBr(dados.site.despublicadoEm)}.`}</p>
        {dados.enderecos && <p>Endereço local: <code className={styles.link}>{dados.enderecos.plataforma}</code>{dados.site.estado === 'PUBLICADO' && dados.ambiente.sitesPublicos && <> <a href={dados.enderecos.plataforma} target="_blank" rel="noopener">Abrir</a></>}</p>}
        {dados.enderecos && <p className={styles.muted}>Endereço canônico (SEO): {dados.enderecos.canonical} · Sitemap: {dados.enderecos.sitemap}</p>}
        {!dados.site.versaoPublicada && pode('MARKETING_SITE_EDITAR') && <div className={styles.filtros}>
          <label>Trocar endereço (só antes da 1ª publicação)<input value={slug} pattern="[a-z][a-z0-9-]{1,62}[a-z0-9]" onChange={(e) => setSlug(e.target.value.toLowerCase())} /></label>
          <button type="button" className={styles.secundario} disabled={ocupado || slug === dados.site.slug} onClick={() => void acao({ acao: 'endereco', siteId: dados.site!.id, rascunhoVersao: versaoRascunho, slug }, 'Endereço alterado.')}>Salvar endereço</button>
        </div>}
        {dados.site.pendencias.length > 0 && <div className={styles.aviso}><strong>Antes de publicar:</strong><ul>{dados.site.pendencias.map((p) => <li key={p}>{p}</li>)}</ul></div>}
        {dados.previa && dados.previa.avisos.length > 0 && <div className={styles.aviso}><strong>Na publicação:</strong><ul>{dados.previa.avisos.map((p) => <li key={p}>{p}</li>)}</ul></div>}
      </section>

      <Secao titulo="Identidade">
        <div className={styles.grade2}>
          <Campo rotulo="Nome do buffet"><input maxLength={80} value={conteudo.identidade.nome} onChange={(e) => editar((c) => ({ ...c, identidade: { ...c.identidade, nome: e.target.value } }))} /></Campo>
          <Campo rotulo="Frase de destaque"><input maxLength={120} value={conteudo.identidade.slogan} onChange={(e) => editar((c) => ({ ...c, identidade: { ...c.identidade, slogan: e.target.value } }))} /></Campo>
          <Campo rotulo="Cor principal"><input type="color" value={conteudo.identidade.corPrimaria} onChange={(e) => editar((c) => ({ ...c, identidade: { ...c.identidade, corPrimaria: e.target.value } }))} /></Campo>
          <Campo rotulo="Cor de apoio"><input type="color" value={conteudo.identidade.corSecundaria} onChange={(e) => editar((c) => ({ ...c, identidade: { ...c.identidade, corSecundaria: e.target.value } }))} /></Campo>
          <Campo rotulo="Logo (imagem enviada)"><select value={conteudo.identidade.logoImagemId ?? ''} onChange={(e) => editar((c) => ({ ...c, identidade: { ...c.identidade, logoImagemId: e.target.value || null } }))}>
            <option value="">Sem logo</option>{(dados.imagens ?? []).map((i, n) => <option key={i.id} value={i.id}>Imagem {n + 1}{i.descricao ? ` — ${i.descricao}` : ''}</option>)}</select></Campo>
        </div>
      </Secao>

      <Secao titulo="Apresentação">
        <Campo rotulo="Título da página"><input maxLength={120} value={conteudo.apresentacao.titulo} onChange={(e) => editar((c) => ({ ...c, apresentacao: { ...c.apresentacao, titulo: e.target.value } }))} /></Campo>
        <Campo rotulo={`Texto (${conteudo.apresentacao.texto.length}/2000) — parágrafos separados por linha em branco`}><textarea rows={6} maxLength={2000} value={conteudo.apresentacao.texto} onChange={(e) => editar((c) => ({ ...c, apresentacao: { ...c.apresentacao, texto: e.target.value } }))} /></Campo>
      </Secao>

      <Imagens siteId={dados.site.id} imagens={dados.imagens ?? []} conteudo={conteudo} editar={editar} podeEditar={pode('MARKETING_SITE_EDITAR')}
        aoMudar={(imagens) => setDados({ ...dados, imagens })} />

      <Secao titulo="Estrutura">
        <Campo rotulo="Capacidade (texto livre)"><input maxLength={80} value={conteudo.estrutura.capacidade} placeholder="ex.: até 120 convidados" onChange={(e) => editar((c) => ({ ...c, estrutura: { ...c.estrutura, capacidade: e.target.value } }))} /></Campo>
        <Campo rotulo="Itens da estrutura (um por linha, até 20)"><textarea rows={5} value={conteudo.estrutura.itens.join('\n')} onChange={(e) => editar((c) => ({ ...c, estrutura: { ...c.estrutura, itens: e.target.value.split('\n').map((l) => l.slice(0, 80)).slice(0, 20) } }))} /></Campo>
      </Secao>

      <Secao titulo="Pacotes divulgados">
        <p className={styles.muted}>Escolha os pacotes vigentes que aparecem no site. O preço “a partir de” é opcional e congela o valor da tabela de hoje no momento da publicação.</p>
        {(dados.pacotesDisponiveis ?? []).length === 0 ? <p className={styles.vazio}>Nenhum pacote vigente cadastrado.</p> : (dados.pacotesDisponiveis ?? []).map((p) => {
          const escolhido = conteudo.pacotes.find((x) => x.codigo === p.codigo);
          return <div key={p.codigo} className={styles.grade3} style={{ alignItems: 'center', marginBottom: 8 }}>
            <label className={styles.check}><input type="checkbox" checked={Boolean(escolhido)} onChange={(e) => editar((c) => ({ ...c, pacotes: e.target.checked ? [...c.pacotes, { codigo: p.codigo, destaque: '', mostrarPreco: false }] : c.pacotes.filter((x) => x.codigo !== p.codigo) }))} /> {p.nome}</label>
            {escolhido && <input aria-label={`Destaque de ${p.nome}`} maxLength={140} placeholder="Destaque (opcional)" value={escolhido.destaque} className={styles.link} onChange={(e) => editar((c) => ({ ...c, pacotes: c.pacotes.map((x) => x.codigo === p.codigo ? { ...x, destaque: e.target.value } : x) }))} />}
            {escolhido && <label className={styles.check}><input type="checkbox" checked={escolhido.mostrarPreco} onChange={(e) => editar((c) => ({ ...c, pacotes: c.pacotes.map((x) => x.codigo === p.codigo ? { ...x, mostrarPreco: e.target.checked } : x) }))} /> Mostrar “a partir de”</label>}
          </div>;
        })}
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

      <Secao titulo="SEO e compartilhamento">
        <Campo rotulo={`Título para buscadores (${conteudo.seo.titulo.length}/70)`}><input maxLength={70} value={conteudo.seo.titulo} onChange={(e) => editar((c) => ({ ...c, seo: { ...c.seo, titulo: e.target.value } }))} /></Campo>
        <Campo rotulo={`Descrição (${conteudo.seo.descricao.length}/170)`}><textarea rows={3} maxLength={170} value={conteudo.seo.descricao} onChange={(e) => editar((c) => ({ ...c, seo: { ...c.seo, descricao: e.target.value } }))} /></Campo>
        <label className={styles.check}><input type="checkbox" checked={conteudo.seo.indexavel} onChange={(e) => editar((c) => ({ ...c, seo: { ...c.seo, indexavel: e.target.checked } }))} /> Permitir buscadores (só vale para a página publicada no endereço canônico)</label>
        <div className={styles.card} aria-label="Como pode aparecer no buscador"><strong style={{ color: '#8ab4f8' }}>{conteudo.seo.titulo || conteudo.identidade.nome}</strong>
          <span className={styles.muted}>{dados.enderecos?.canonical}</span><span>{conteudo.seo.descricao || 'Sem descrição.'}</span></div>
        <p className={styles.muted}>Nenhuma posição no Google é garantida. Rascunho e prévia nunca são indexados.</p>
      </Secao>

      {dados.site && <Dominios siteId={dados.site.id} dominios={dados.dominios ?? []} ambiente={dados.ambiente} pode={pode('MARKETING_DOMINIO_CONFIGURAR')} aoMudar={(dominios) => setDados({ ...dados, dominios })} />}

      {(dados.versoes ?? []).length > 0 && <Secao titulo="Versões publicadas">
        <ul className={styles.historico}>{dados.versoes!.map((v) => <li key={v.id}>Versão {v.numero} · {dataHoraBr(v.publicadoEm)}{v.publicadoPor ? ` · ${v.publicadoPor}` : ''}</li>)}</ul>
      </Secao>}

      <div className={styles.barraFixa}>
        <span className={styles.muted}>{sujo ? 'Alterações não salvas.' : 'Rascunho salvo.'}</span>
        <div className={styles.acoes}>
          {pode('MARKETING_SITE_EDITAR') && <button type="button" className={styles.secundario} disabled={ocupado || !sujo} onClick={() => void salvar()}>Salvar rascunho</button>}
          <a className={styles.secundario} href={`/admin/marketing/site/previa${unidadeId ? `?unidadeId=${unidadeId}` : ''}`} target="_blank" rel="noopener" onClick={(e) => { if (sujo) { e.preventDefault(); setAviso({ tipo: 'erro', texto: 'Salve o rascunho para ver a prévia atualizada.' }); } }}>Abrir prévia</a>
          {pode('MARKETING_SITE_PUBLICAR') && dados.site.estado === 'PUBLICADO' && <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => { if (window.confirm('Despublicar? A página deixa de abrir para visitantes (e sai do sitemap).')) void acao({ acao: 'despublicar', siteId: dados.site!.id }, 'Site despublicado.'); }}>Despublicar</button>}
          {pode('MARKETING_SITE_PUBLICAR') && <AdminPrimaryButton type="button" carregando={ocupado} disabled={sujo || dados.site.pendencias.length > 0} title={sujo ? 'Salve antes de publicar' : undefined}
            onClick={() => { if (window.confirm('Publicar a versão atual do rascunho? Ela passa a ser a página pública.')) void acao({ acao: 'publicar', siteId: dados.site!.id, rascunhoVersao: versaoRascunho }, 'Site publicado.'); }}>Publicar</AdminPrimaryButton>}
        </div>
      </div>
    </div>}
  </main>;
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return <section className={styles.cartao} aria-label={titulo}><h2>{titulo}</h2>{children}</section>;
}
function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return <label className={styles.campo}>{rotulo}{children}</label>;
}

function Imagens({ siteId, imagens, conteudo, editar, podeEditar, aoMudar }: {
  siteId: string; imagens: Imagem[]; conteudo: ConteudoSite; editar: (f: (c: ConteudoSite) => ConteudoSite) => void; podeEditar: boolean; aoMudar: (i: Imagem[]) => void;
}) {
  const arquivo = useRef<HTMLInputElement>(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  async function enviar(lista: FileList | null) {
    const f = lista?.[0];
    if (!f) return;
    setEnviando(true); setErro('');
    try {
      const form = new FormData(); form.set('siteId', siteId); form.set('arquivo', f);
      const corpo = await (await adminFetch('/api/admin/marketing/site/imagens', { method: 'POST', body: form })).json();
      if (!corpo.ok) throw new Error(corpo.erro ?? 'Não foi possível enviar.');
      aoMudar(corpo.data.imagens);
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível enviar.'); }
    finally { setEnviando(false); if (arquivo.current) arquivo.current.value = ''; }
  }
  async function remover(id: string) {
    if (!window.confirm('Remover a imagem? Se estiver publicada, deixa de aparecer na hora.')) return;
    try {
      const r = await enviarMarketing<{ imagens: Imagem[] }>(`/api/admin/marketing/site/imagens/${id}`, { acao: 'remover', siteId });
      aoMudar(r.imagens);
      editar((c) => ({ ...c, identidade: { ...c.identidade, logoImagemId: c.identidade.logoImagemId === id ? null : c.identidade.logoImagemId }, galeria: c.galeria.filter((g) => g.imagemId !== id) }));
    } catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível remover.'); }
  }
  const naGaleria = (id: string) => conteudo.galeria.findIndex((g) => g.imagemId === id);
  return <section className={styles.cartao} aria-label="Galeria">
    <h2>Galeria e imagens</h2>
    <p className={styles.muted}>Imagens enviadas ficam privadas; só aparecem no site as escolhidas para a galeria ou logo na versão publicada. A 1ª da galeria abre a página. PNG, JPEG ou WebP até 8 MB (convertidas e sem dados de localização).</p>
    {podeEditar && <div className={styles.acoes}><input ref={arquivo} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Enviar imagem" onChange={(e) => void enviar(e.target.files)} disabled={enviando} />{enviando && <span role="status">Enviando…</span>}</div>}
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {imagens.length === 0 ? <p className={styles.vazio}>Nenhuma imagem enviada.</p> : <div className={styles.galeria} style={{ marginTop: 12 }}>
      {imagens.map((i) => {
        const pos = naGaleria(i.id);
        return <figure key={i.id}>
          <img src={`/api/admin/marketing/site/imagens/${i.id}`} alt={i.descricao ?? 'Imagem do site'} loading="lazy" />
          <figcaption>
            {pos >= 0 ? <span className={styles.seloAtivo}>galeria #{pos + 1}</span> : null}
            {conteudo.identidade.logoImagemId === i.id && <span className={styles.seloVioleta}>logo</span>}
            {podeEditar && <button type="button" className={styles.fantasma} style={{ minHeight: 30, padding: '0 8px' }} onClick={() => editar((c) => ({ ...c, galeria: pos >= 0 ? c.galeria.filter((g) => g.imagemId !== i.id) : [...c.galeria, { imagemId: i.id, legenda: '' }].slice(0, 12) }))}>{pos >= 0 ? 'Tirar da galeria' : 'Pôr na galeria'}</button>}
            {podeEditar && pos > 0 && <button type="button" className={styles.fantasma} style={{ minHeight: 30, padding: '0 8px' }} onClick={() => editar((c) => { const g = [...c.galeria]; [g[pos - 1], g[pos]] = [g[pos], g[pos - 1]]; return { ...c, galeria: g }; })}>↑</button>}
            {podeEditar && <button type="button" className={styles.fantasma} style={{ minHeight: 30, padding: '0 8px' }} onClick={() => void remover(i.id)}>Remover</button>}
          </figcaption>
          {pos >= 0 && podeEditar && <input aria-label="Legenda" placeholder="Legenda" maxLength={140} value={conteudo.galeria[pos]?.legenda ?? ''} className={styles.link}
            onChange={(e) => editar((c) => ({ ...c, galeria: c.galeria.map((g) => g.imagemId === i.id ? { ...g, legenda: e.target.value } : g) }))} />}
        </figure>;
      })}
    </div>}
  </section>;
}

function Dominios({ siteId, dominios, ambiente, pode, aoMudar }: {
  siteId: string; dominios: Dominio[]; ambiente: Dados['ambiente']; pode: boolean; aoMudar: (d: Dominio[]) => void;
}) {
  const [host, setHost] = useState('');
  const [www, setWww] = useState(false);
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  async function acao(corpo: Record<string, unknown>) {
    setOcupado(true); setErro('');
    try { const r = await enviarMarketing<{ dominios: Dominio[]; resultado: { status?: string; verificacao?: { detalhe: string } } }>('/api/admin/marketing/dominios', corpo); aoMudar(r.dominios);
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
