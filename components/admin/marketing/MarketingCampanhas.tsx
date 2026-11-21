'use client';
import { dialogo } from '@/components/JanelaConfirmacao';
import type { LinhaPainel } from '@/lib/marketing/metricas';
import { useEffect, useRef, useState } from 'react';
import { hojeSaoPaulo } from '@/lib/marketing/utm';
import type { Campanha, CanalCampanha } from '@/lib/marketing/campanhas';
import type { OpcaoOrigem } from '@/lib/marketing/origens';
import { CANAIS_CAMPANHA_UI, ROTULO_CANAL_UI, linkDaCampanha, baixarQrCampanha } from '@/lib/marketing/campanhas-ui';
import { centavosDeTexto, dataBr, reais, receitaContratadaTexto, ROTULO_STATUS_CAMPANHA } from '@/lib/marketing/apresentacao';
import { AdminPrimaryButton } from '../AdminPrimaryButton';
import { AtribuicaoExplicada } from './AtribuicaoExplicada';
import { CabecalhoMarketing, EstadoCarga, enviarMarketing, useMarketing } from './comum';
import styles from './marketing.module.css';

type Dados = {
  resultados: LinhaPainel[]; campanhas: Campanha[]; origens: OpcaoOrigem[]; sites: Array<{ id: string; slug: string; unidadeId: string | null; estado: string }>;
  unidades: Array<{ id: string; nome: string }>; padraoPorCanal: Record<CanalCampanha, { utmSource: string; utmMedium: string; origem: string }>;
  origemPlataforma: string; capacidades: string[];
};

type Formulario = {
  id: string | null; versao: number; codigo: string; nome: string; canal: CanalCampanha; origemCodigo: string; objetivo: string; inicio: string; fim: string;
  orcamento: string; utmSource: string; utmMedium: string; unidadeId: string; siteId: string;
};

function slugDe(nome: string) {
  const base = nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const sufixo = new Date().toISOString().slice(2, 7).replace('-', '');
  return `${base || 'campanha'}-${sufixo}`.replace(/-+/g, '-');
}

function novoFormulario(dados: Dados, dataLivre?: string): Formulario {
  const p = dados.padraoPorCanal.INSTAGRAM;
  return { id: null, versao: 1, codigo: '', nome: dataLivre ? `Data livre ${dataBr(dataLivre)}` : '', canal: 'INSTAGRAM', origemCodigo: p.origem, objetivo: '', inicio: hojeSaoPaulo(), fim: dataLivre ?? '',
    orcamento: '', utmSource: p.utmSource, utmMedium: p.utmMedium, unidadeId: '', siteId: dados.sites[0]?.id ?? '' };
}

export default function MarketingCampanhas({ dataInicial }: { dataInicial?: string } = {}) {
  const [arquivadas, setArquivadas] = useState(false);
  const { dados, falha, carregando, recarregar, setDados } = useMarketing<Dados>(`/api/admin/marketing/campanhas${arquivadas ? '?arquivadas=1' : ''}`);
  const [form, setForm] = useState<Formulario | null>(null);
  const [aviso, setAviso] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [arquivando, setArquivando] = useState<string | null>(null);
  const [copiado, setCopiado] = useState<string | null>(null);
  const podeEditar = dados?.capacidades.includes('MARKETING_CAMPANHAS_EDITAR') ?? false;
  const atalhoConsumido = useRef(false);

  useEffect(() => {
    if (!dataInicial || !dados || !podeEditar || atalhoConsumido.current) return;
    atalhoConsumido.current = true;
    // Abre uma vez após os dados e a permissão externos chegarem; cancelar não reabre o atalho.
    setForm(novoFormulario(dados, dataInicial));
  }, [dataInicial, dados, podeEditar]);

  function nova() {
    if (!dados) return;
    setAviso('');
    setForm(novoFormulario(dados));
  }
  function editar(c: Campanha) {
    setAviso('');
    setForm({ id: c.id, versao: c.versao, codigo: c.codigo, nome: c.nome, canal: c.canal, origemCodigo: c.origemCodigo, objetivo: c.objetivo ?? '', inicio: c.inicio, fim: c.fim ?? '',
      orcamento: c.orcamentoCentavos === null ? '' : String(c.orcamentoCentavos / 100).replace('.', ','), utmSource: c.utmSource, utmMedium: c.utmMedium,
      unidadeId: c.unidadeId ?? '', siteId: c.siteId ?? '' });
  }
  function trocarCanal(valor: string) {
    if (!dados || !form) return;
    const [canal, origem] = valor.split('|') as [CanalCampanha,string];
    const p = dados.padraoPorCanal[canal];
    setForm({ ...form, canal, utmSource: p.utmSource, utmMedium: p.utmMedium, origemCodigo: origem || p.origem });
  }

  async function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    if (!form || enviando) return;
    const orcamentoCentavos = form.orcamento.trim() ? centavosDeTexto(form.orcamento) : null;
    if (form.orcamento.trim() && orcamentoCentavos === null) { setAviso('Orçamento inválido. Use um valor em reais, por exemplo 1500,00.'); return; }
    const comuns = { nome: form.nome, canal: form.canal, origemCodigo: form.origemCodigo, objetivo: form.objetivo || null, inicio: form.inicio, fim: form.fim || null,
      orcamentoCentavos, utmSource: form.utmSource, utmMedium: form.utmMedium, unidadeId: form.unidadeId || null, siteId: form.siteId || null };
    setEnviando(true); setAviso('');
    try {
      await enviarMarketing('/api/admin/marketing/campanhas', form.id
        ? { acao: 'editar', id: form.id, versao: form.versao, ...comuns }
        : { acao: 'criar', codigo: form.codigo || slugDe(form.nome), ...comuns });
      setForm(null); recarregar();
    } catch (e) { setAviso(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
    finally { setEnviando(false); }
  }

  async function mudarEstado(c: Campanha, acao: 'pausar' | 'reativar' | 'arquivar') {
    setAviso('');
    try {
      const { campanha } = await enviarMarketing<{ campanha: Campanha }>('/api/admin/marketing/campanhas', { acao, id: c.id, versao: c.versao });
      if (acao === 'arquivar') {
        setDados(atual => ({
          ...atual,
          campanhas: atual.campanhas.flatMap(linha => linha.id !== c.id ? [linha] : arquivadas ? [campanha] : []),
        }));
      }
      recarregar();
    }
    catch (e) { setAviso(e instanceof Error ? e.message : 'Não foi possível concluir.'); }
  }

  async function arquivar(c: Campanha, gatilho: HTMLButtonElement) {
    if (arquivando === c.id) return;
    await dialogo.confirmar('Arquivar campanha', `Arquivar “${c.nome}”? O link continua levando ao site, mas não atribui novos contatos; a campanha não poderá ser editada.`, async () => {
      setArquivando(c.id);
      try { await mudarEstado(c, 'arquivar'); }
      finally { setArquivando(null); }
    }, gatilho);
  }

  async function copiar(texto: string, id: string) {
    try { await navigator.clipboard.writeText(texto); setCopiado(id); window.setTimeout(() => setCopiado(null), 2000); } catch { setCopiado(null); }
  }

  const siteDe = (c: Campanha) => dados?.sites.find((s) => s.id === c.siteId) ?? dados?.sites.find((s) => s.unidadeId === c.unidadeId) ?? dados?.sites[0] ?? null;
  return <main className={styles.pagina}>
    <CabecalhoMarketing titulo="Campanhas" descricao="Cada campanha gera um link rastreável para o site do buffet. Quem chega pelo link e pede orçamento fica atribuído à campanha."
      acao={podeEditar ? <AdminPrimaryButton type="button" onClick={nova}>+ Nova campanha</AdminPrimaryButton> : undefined} />
    <div className={styles.filtros}><label className={styles.check}><input type="checkbox" checked={arquivadas} onChange={(e) => setArquivadas(e.target.checked)} /> Mostrar arquivadas</label></div>
    {aviso && !form && <p className={styles.aviso} role="alert">{aviso}</p>}
    <EstadoCarga carregando={carregando && !dados} falha={falha} aoTentar={recarregar} />
    {dados && <section className={styles.cartao} aria-label="Da campanha ao contrato"><AtribuicaoExplicada /></section>}
    {dados && <>
      {dados.sites.length === 0 && <p className={styles.info}>Ainda não há site publicado para receber os links. Monte o site em <a href="/admin/marketing/site">Site do buffet</a>; a campanha pode ser criada antes.</p>}
      {dados.campanhas.length === 0 ? <section className={styles.cartao}><p className={styles.vazio}>Nenhuma campanha {arquivadas ? '' : 'ativa ou pausada '}ainda.</p></section>
        : dados.campanhas.map((c) => {
          const resultado = dados.resultados.find(l=>l.campanhaId===c.id);
          const site = siteDe(c);
          const link = site ? linkDaCampanha(dados.origemPlataforma, site.slug, c.codigo) : null;
          return <section key={c.id} className={styles.cartao} aria-labelledby={`camp-${c.id}`}>
            <div className={`${styles.topo} ${styles.cabecalhoCampanha}`}>
              <div><h2 id={`camp-${c.id}`}>{c.nome} <span className={c.status === 'ATIVA' ? styles.seloAtivo : c.status === 'PAUSADA' ? styles.seloAlerta : styles.selo}>{ROTULO_STATUS_CAMPANHA[c.status]}</span></h2>
                <p className={styles.muted}>{ROTULO_CANAL_UI[c.canal]} · {dataBr(c.inicio)}{c.fim ? ` a ${dataBr(c.fim)}` : ' em diante'} · origem: {dados.origens.find((o) => o.codigo === c.origemCodigo)?.rotulo ?? c.origemCodigo}
                  {c.orcamentoCentavos !== null ? ` · orçamento informado ${reais(c.orcamentoCentavos)}` : ''}{c.unidadeId ? ` · ${dados.unidades.find((u) => u.id === c.unidadeId)?.nome ?? 'unidade'}` : ''}</p>
                {c.objetivo && <p>{c.objetivo}</p>}</div>
              {podeEditar && c.status !== 'ARQUIVADA' && <div className={`${styles.acoes} ${styles.acoesCampanha}`}>
                <button type="button" className={styles.secundario} disabled={arquivando === c.id} onClick={() => editar(c)}>Editar</button>
                {c.status === 'ATIVA' ? <button type="button" className={styles.secundario} disabled={arquivando === c.id} onClick={() => void mudarEstado(c, 'pausar')}>Pausar</button>
                  : <button type="button" className={styles.secundario} disabled={arquivando === c.id} onClick={() => void mudarEstado(c, 'reativar')}>Reativar</button>}
                <button type="button" className={styles.fantasma} disabled={arquivando === c.id} onClick={(evento) => void arquivar(c, evento.currentTarget)}>Arquivar</button>
              </div>}
            </div>
            <p>{resultado?.contatos ?? 0} pedidos · {resultado?.contratos ?? 0} contratos · Receita: {resultado ? receitaContratadaTexto(resultado) : reais(0)}</p><p className={styles.muted}>Resultados acumulados até hoje.</p>
            {link ? <div className={styles.acoes}><code className={styles.link}>{link}</code>
              <button type="button" className={styles.secundario} onClick={() => void copiar(link, c.id)}>{copiado === c.id ? 'Copiado!' : 'Copiar link'}</button><button type="button" className={styles.secundario} onClick={()=>void baixarQrCampanha(link,c.codigo).catch(()=>setAviso('Não foi possível baixar o QR code.'))}>Baixar QR code</button></div>
              : <p className={styles.muted}>Link disponível depois que o site existir.</p>}
            <p className={styles.muted}>Pausar ou passar da data de fim não quebra o link: contatos continuam sendo atribuídos; só arquivar deixa de atribuir.</p>
          </section>;
        })}
    </>}
    {form && dados && <div className={styles.dialogo} role="dialog" aria-modal="true" aria-labelledby="t-form-campanha">
      <form onSubmit={salvar}>
        <h2 id="t-form-campanha">{form.id ? 'Editar campanha' : 'Nova campanha'}</h2>
        <label>Nome<input required minLength={2} maxLength={120} value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} /></label>
        <label>Onde vai divulgar<select value={form.canal+'|'+form.origemCodigo} onChange={e=>trocarCanal(e.target.value)}>
          {CANAIS_CAMPANHA_UI.map(c=><option key={c} value={c+'|'+dados.padraoPorCanal[c].origem}>{ROTULO_CANAL_UI[c]}</option>)}
          {dados.origens.filter(o=>o.personalizada && o.ativa).map(o=><option key={o.codigo} value={'OUTRO|'+o.codigo}>{o.rotulo}</option>)}
          {!CANAIS_CAMPANHA_UI.some(c=>c===form.canal && dados.padraoPorCanal[c].origem===form.origemCodigo) && !dados.origens.some(o=>o.personalizada&&o.ativa&&form.canal==='OUTRO'&&o.codigo===form.origemCodigo) && <option value={form.canal+'|'+form.origemCodigo}>{ROTULO_CANAL_UI[form.canal]} · {dados.origens.find(o=>o.codigo===form.origemCodigo)?.rotulo ?? form.origemCodigo}</option>}
        </select></label>
          {dados.sites.length > 0 && <label>Site de destino<select value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}><option value="">Automático</option>{dados.sites.map((s) => <option key={s.id} value={s.id}>/s/{s.slug}</option>)}</select></label>}
        {dados.sites.length===0 && <label>Site<select disabled><option>Crie primeiro o site do buffet</option></select></label>}
        <details className={styles.definicoes}><summary>Mais opções</summary><div className={styles.grade2}>
        {!form.id && <label>Identificador do link (não muda depois)<input value={form.codigo} placeholder={slugDe(form.nome || 'campanha')} pattern="[a-z0-9][a-z0-9-]{2,46}[a-z0-9]" onChange={(e) => setForm({ ...form, codigo: e.target.value.toLowerCase() })} /></label>}
          <label>Início<input type="date" required value={form.inicio} onChange={(e) => setForm({ ...form, inicio: e.target.value })} /></label>
          <label>Fim (opcional)<input type="date" value={form.fim} min={form.inicio} onChange={(e) => setForm({ ...form, fim: e.target.value })} /></label>
          <label>utm_source<input required value={form.utmSource} pattern="[a-z0-9][a-z0-9._-]{0,59}" onChange={(e) => setForm({ ...form, utmSource: e.target.value.toLowerCase() })} /></label>
          <label>utm_medium<input required value={form.utmMedium} pattern="[a-z0-9][a-z0-9._-]{0,59}" onChange={(e) => setForm({ ...form, utmMedium: e.target.value.toLowerCase() })} /></label>
          <label>Orçamento (opcional, R$)<input inputMode="decimal" value={form.orcamento} placeholder="ex.: 800,00" onChange={(e) => setForm({ ...form, orcamento: e.target.value })} /></label>
          {dados.unidades.length > 0 && <label>Unidade (opcional)<select value={form.unidadeId} onChange={(e) => setForm({ ...form, unidadeId: e.target.value })}><option value="">Empresa toda</option>{dados.unidades.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select></label>}
        <label>Objetivo (opcional)<textarea maxLength={500} value={form.objetivo} onChange={(e) => setForm({ ...form, objetivo: e.target.value })} /></label>
        </div><p className={styles.muted}>Início e fim organizam a lista e não limitam a atribuição: quem usar o link depois do fim ainda conta para esta campanha. Para encerrar, arquive.</p></details>
        {aviso && <p className={styles.erro} role="alert">{aviso}</p>}
        <div className={styles.acoes}><button type="button" className={styles.fantasma} onClick={() => setForm(null)} disabled={enviando}>Cancelar</button><AdminPrimaryButton type="submit" carregando={enviando}>Salvar</AdminPrimaryButton></div>
      </form>
    </div>}
  </main>;
}
