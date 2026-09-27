'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './workspace.module.css';
import { DurationField } from './DurationField';
import { formatarDuracao, juntarDuracao, separarDuracao } from '@/lib/comercial/duracao';
import { AdminIcon } from './AdminIcon';
import Link from 'next/link';

type Pacote = {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  duracaoMinutos: number | null;
  ativo: boolean;
  vigente: boolean;
  arquivadoEm: string | null;
  utilizado: boolean;
};

type Catalogo = {
  adicionais: { id: string; codigo: string; nome: string }[];
  categorias: { id: string; nome: string }[];
};

const vazio = { nome: '', descricao: '', horas: '', minutos: '' };

export default function PacotesAdmin() {
  const editorRef = useRef<HTMLDialogElement>(null);
  const [editorAberto, setEditorAberto] = useState(false);
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState<'todos' | 'ativos' | 'inativos'>('todos');
  const [aba, setAba] = useState<'dados' | 'composicao' | 'historico'>('dados');
  const [pacotes, setPacotes] = useState<Pacote[] | null>(null);
  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  const [form, setForm] = useState(vazio);
  const [motivo, setMotivo] = useState('');
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [historico, setHistorico] = useState<Pacote[] | null>(null);
  const [adicionalId, setAdicionalId] = useState('');
  const [modalidade, setModalidade] = useState<'INCLUSO' | 'EXTRA' | 'INDISPONIVEL'>('INCLUSO');
  const [categoriaId, setCategoriaId] = useState('');
  const [escolhasMin, setEscolhasMin] = useState('0');
  const [escolhasMax, setEscolhasMax] = useState('1');
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');

  async function ler(response: Response) {
    const body = await response.json();
    if (!response.ok || body.ok === false) {
      const falha = new Error(body.erro || 'Não foi possível concluir a operação.');
      (falha as Error & { status?: number }).status = response.status;
      throw falha;
    }
    return body;
  }

  const carregar = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    try {
      const [lista, itens] = await Promise.all([
        adminFetch('/api/admin/configuracoes/pacotes'),
        adminFetch('/api/admin/configuracoes/catalogo'),
      ]);
      const pacote = await ler(lista);
      const catalogoJson = await ler(itens);
      setErro('');
      setPacotes(pacote.data);
      setCatalogo({ adicionais: catalogoJson.data.adicionais, categorias: catalogoJson.data.categorias });
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao carregar.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    let ativo = true;
    Promise.all([adminFetch('/api/admin/configuracoes/pacotes'), adminFetch('/api/admin/configuracoes/catalogo')])
      .then(async ([lista, itens]) => {
        const pacote = await ler(lista), catalogoJson = await ler(itens);
        if (!ativo) return;
        setPacotes(pacote.data);
        setCatalogo({ adicionais: catalogoJson.data.adicionais, categorias: catalogoJson.data.categorias });
      }).catch(error => { if (ativo) setErro(error instanceof Error ? error.message : 'Falha ao carregar.'); })
      .finally(() => { if (ativo) setCarregando(false); });
    return () => { ativo = false; };
  }, []);

  async function enviar(acao: string, extra: Record<string, unknown>) {
    setCarregando(true);
    setErro('');
    setAviso('');
    try {
      const response = await adminFetch('/api/admin/configuracoes/pacotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao, ...(acao === 'criar' ? {} : { motivo }), ...extra }),
      });
      await ler(response);
      setAviso('Pacote salvo.');
      setForm(vazio);
      setSelecionado(null);
      editorRef.current?.close();
      await carregar();
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao salvar.');
    } finally {
      setCarregando(false);
    }
  }

  async function alterar(id: string, acao: string, extra: Record<string, unknown> = {}) {
    setCarregando(true);
    setErro('');
    setAviso('');
    try {
      const response = await adminFetch(`/api/admin/configuracoes/pacotes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao, motivo, ...extra }),
      });
      await ler(response);
      editorRef.current?.close();
      setSelecionado(null);
      setForm(vazio);
      setAviso(acao === 'revisar' ? 'Nova revisão criada. A anterior permanece.' : 'Pacote atualizado.');
      await carregar();
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao atualizar.');
    } finally {
      setCarregando(false);
    }
  }

  async function abrirHistorico(id: string) {
    setErro('');
    setHistorico(null);
    setSelecionado(id);
    try {
      const response = await adminFetch(`/api/admin/configuracoes/pacotes/${id}/historico`);
      setHistorico((await ler(response)).data);
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao abrir o histórico.');
    }
  }

  async function salvarComposicao(id: string, corpo: Record<string, unknown>) {
    setCarregando(true);
    setErro('');
    setAviso('');
    try {
      const response = await adminFetch(`/api/admin/configuracoes/pacotes/${id}/composicao`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ motivo, ...corpo }),
      });
      await ler(response);
      setAviso('Composição salva.');
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao salvar a composição.');
    } finally {
      setCarregando(false);
    }
  }

  const atual = pacotes?.find((pacote) => pacote.id === selecionado) ?? null;

  const visiveis = (pacotes ?? []).filter(p => p.nome.toLocaleLowerCase('pt-BR').includes(busca.toLocaleLowerCase('pt-BR')) && (filtro === 'todos' || p.ativo === (filtro === 'ativos')));
  function abrir(pacote: Pacote | null, destino: typeof aba = 'dados') {
    setSelecionado(pacote?.id ?? null);
    setForm(pacote ? { nome: pacote.nome, descricao: pacote.descricao ?? '', ...separarDuracao(pacote.duracaoMinutos) } : vazio);
    setMotivo(''); setErro(''); setHistorico(null); setAba(destino);
    editorRef.current?.showModal();
    setEditorAberto(true);
    if (destino === 'historico' && pacote) void abrirHistorico(pacote.id);
  }
  function comMotivo(action: () => void) {
    if (motivo.trim().length < 3) { setErro('Informe o motivo desta alteração (ao menos 3 caracteres).'); return; }
    action();
  }

  return <main className={styles.page} data-admin-workspace aria-busy={carregando}>
    <header className={styles.header}><h1>Gestão de Pacotes</h1><div className={styles.actions}>
      <label className={styles.search}><span className={styles.srOnly}>Buscar pacote</span><input type="search" placeholder="Buscar pacote…" value={busca} onChange={e => setBusca(e.target.value)} /></label>
      <button className={styles.primary} type="button" onClick={() => abrir(null)} disabled={carregando || pacotes === null}>+ Criar pacote</button>
    </div></header>
    <div className={styles.content}>
      {erro && !editorAberto && <p role="alert" className={styles.error}>{erro}<button type="button" onClick={() => void carregar()}>Tentar novamente</button></p>}
      {aviso && <p role="status" className={styles.notice}>{aviso}</p>}
      <div className={styles.toolbar}><div className={styles.filters} aria-label="Filtrar pacotes">{(['todos','ativos','inativos'] as const).map(f => <button key={f} type="button" aria-pressed={filtro === f} onClick={() => setFiltro(f)}>{f === 'todos' ? 'Todos' : f === 'ativos' ? 'Ativos' : 'Inativos'} ({(pacotes ?? []).filter(p => f === 'todos' || p.ativo === (f === 'ativos')).length})</button>)}</div><span>Ordem de exibição cadastrada</span></div>
      {carregando && pacotes === null && <p className={styles.empty} role="status">Carregando pacotes…</p>}
      {pacotes && !visiveis.length && <div className={styles.empty}><AdminIcon name="packages" size={32} /><h2>{busca ? 'Nenhum pacote encontrado' : 'Nenhum pacote nesta lista'}</h2><p>{busca ? 'Experimente outro nome ou filtro.' : 'Crie um pacote para começar.'}</p></div>}
      {visiveis.length > 0 && <div className={styles.tableCard}><table className={styles.packagesTable}><thead><tr><th>Pacote</th><th>Duração da festa</th><th>Status</th><th>Histórico</th><th>Ações</th></tr></thead><tbody>{visiveis.map(p => <tr key={p.id}>
        <td data-label="Pacote"><strong>{p.nome}</strong>{p.descricao && <p className={styles.muted}>{p.descricao}</p>}</td>
        <td data-label="Duração da festa">{formatarDuracao(p.duracaoMinutos)}</td>
        <td data-label="Status"><span className={styles.badge} data-active={p.ativo}>{p.arquivadoEm ? 'Arquivado' : p.ativo ? 'Ativo' : 'Inativo'}</span>{p.utilizado && <small className={styles.muted}>Com histórico de uso</small>}</td>
        <td data-label="Histórico"><button className={styles.textButton} type="button" onClick={() => abrir(p,'historico')}>Ver histórico</button></td>
        <td data-label="Ações"><div className={styles.rowActions}><button type="button" onClick={() => abrir(p)}>Editar</button><button type="button" onClick={() => abrir(p,'composicao')}>Composição</button></div></td>
      </tr>)}</tbody></table><p className={styles.tableFooter}>Mostrando {visiveis.length} de {pacotes?.length ?? 0} pacotes cadastrados</p></div>}
      <aside className={styles.notice}><AdminIcon name="pdf" /><div><h2>PDF de preços público</h2><p>Alterações em pacotes e preços não atualizam o PDF automaticamente. A revisão e publicação do documento são separadas.</p></div><Link href="/admin/configuracoes/tabela-pacotes">Revisar PDF</Link></aside>
    </div>
    <dialog ref={editorRef} onClose={() => setEditorAberto(false)} className={styles.dialog} aria-labelledby="pacote-editor-title"><div className={styles.dialogHeading}><h2 id="pacote-editor-title">{atual ? atual.nome : 'Criar pacote'}</h2><button type="button" aria-label="Fechar edição" onClick={() => editorRef.current?.close()}>×</button></div>
      {erro && <p role="alert" className={styles.error}>{erro}</p>}
      {aviso && <p role="status">{aviso}</p>}
      {atual && <div className={styles.filters}>{(['dados','composicao','historico'] as const).map(a => <button key={a} type="button" aria-pressed={aba === a} onClick={() => { setAba(a); if (a === 'historico') void abrirHistorico(atual.id); }}>{a === 'dados' ? 'Dados' : a === 'composicao' ? 'Composição' : 'Histórico'}</button>)}</div>}
      {aba === 'dados' && <form onSubmit={event => {
        event.preventDefault();
        try {
          const extra = { nome: form.nome, descricao: form.descricao.trim() || null, duracaoMinutos: juntarDuracao(form.horas, form.minutos) };
          if (atual) comMotivo(() => void alterar(atual.id, atual.utilizado ? 'revisar' : 'editar', extra));
          else void enviar('criar', extra);
        } catch (error) { setErro(error instanceof Error ? error.message : 'Duração inválida.'); }
      }}>
        {atual?.utilizado && <p className={styles.notice}>Uma alteração cria uma nova revisão e preserva o histórico deste pacote.</p>}
        <label htmlFor="pacote-nome">Nome do pacote *<input id="pacote-nome" value={form.nome} onChange={e => setForm({ ...form, nome:e.target.value })} maxLength={160} required /></label>
        <label htmlFor="pacote-descricao">Descrição<textarea id="pacote-descricao" value={form.descricao} onChange={e => setForm({ ...form, descricao:e.target.value })} maxLength={2000} rows={3} /></label>
        <DurationField horas={form.horas} minutos={form.minutos} onChange={value => setForm({ ...form, ...value })} />
        {atual && <label htmlFor="pacote-motivo">Motivo da alteração<input id="pacote-motivo" value={motivo} onChange={e => setMotivo(e.target.value)} required minLength={3} maxLength={500} /></label>}
        <div className={styles.actions}><button type="button" onClick={() => editorRef.current?.close()}>Cancelar</button><button className={styles.primary} type="submit" disabled={carregando}>{atual ? atual.utilizado ? 'Criar revisão' : 'Salvar alterações' : 'Criar pacote'}</button></div>
        {atual && <div className={styles.secondaryActions}><button type="button" disabled={carregando} onClick={() => comMotivo(() => void enviar('duplicar',{ origemId:atual.id }))}>Duplicar</button>
          {!atual.arquivadoEm && <><button type="button" disabled={carregando} onClick={() => comMotivo(() => void alterar(atual.id,atual.ativo ? 'desativar' : 'ativar'))}>{atual.ativo ? 'Desativar' : 'Reativar'}</button><button className={styles.danger} type="button" disabled={carregando} onClick={() => comMotivo(() => { if (window.confirm('Arquivar este pacote? Ele deixa de ser a revisão vigente.')) void alterar(atual.id,'arquivar'); })}>Arquivar</button></>}
        </div>}
      </form>}
      {atual && aba === 'historico' && <section aria-label="Histórico"><h3>Revisões do pacote</h3>{historico ? <ul className={styles.history}>{historico.map(item => <li key={item.id}><strong>{item.nome}</strong><span>{item.vigente ? 'Vigente' : 'Anterior'} · {formatarDuracao(item.duracaoMinutos)}</span></li>)}</ul> : <p role="status">Carregando histórico…</p>}</section>}
      {atual && aba === 'composicao' && catalogo && <section aria-label="Composição"><h3>Composição do pacote</h3><p className={styles.muted}>Preços são configurados separadamente. Alterações em pacotes utilizados preservam a revisão anterior.</p>
        <label htmlFor="composicao-motivo">Motivo da alteração<input id="composicao-motivo" value={motivo} onChange={e => setMotivo(e.target.value)} minLength={3} maxLength={500} required /></label>
        <form className={styles.card} onSubmit={event => { event.preventDefault(); comMotivo(() => void salvarComposicao(atual.id,{acao:'vinculo',adicionalId,modalidade})); }}>
          <label htmlFor="adicional">Item<select id="adicional" value={adicionalId} onChange={e => setAdicionalId(e.target.value)} required><option value="">Selecione um item do catálogo</option>{catalogo.adicionais.map(item => <option key={item.id} value={item.id}>{item.nome}</option>)}</select></label>
          <label htmlFor="modalidade">Modalidade<select id="modalidade" value={modalidade} onChange={e => setModalidade(e.target.value as typeof modalidade)}><option value="INCLUSO">Incluso</option><option value="EXTRA">Extra pago</option><option value="INDISPONIVEL">Indisponível</option></select></label>
          <button className={styles.primary} type="submit" disabled={carregando || !catalogo.adicionais.length}>Salvar vínculo</button>
        </form>
        <form className={styles.card} onSubmit={event => { event.preventDefault(); comMotivo(() => void salvarComposicao(atual.id,{acao:'buffet',categoriaId,ativo:true,escolhasMin:Number(escolhasMin),escolhasMax:Number(escolhasMax)})); }}>
          <label htmlFor="categoria">Categoria de buffet<select id="categoria" value={categoriaId} onChange={e => setCategoriaId(e.target.value)} required><option value="">Selecione uma categoria</option>{catalogo.categorias.map(item => <option key={item.id} value={item.id}>{item.nome}</option>)}</select></label>
          <div className={styles.grid}><label htmlFor="min">Mínimo de escolhas<input id="min" type="number" min="0" max="30" value={escolhasMin} onChange={e => setEscolhasMin(e.target.value)} /></label><label htmlFor="max">Máximo de escolhas<input id="max" type="number" min="0" max="30" value={escolhasMax} onChange={e => setEscolhasMax(e.target.value)} /></label></div>
          <button className={styles.primary} type="submit" disabled={carregando || !catalogo.categorias.length}>Salvar limite</button>
        </form>
      </section>}
    </dialog>
  </main>;
}
