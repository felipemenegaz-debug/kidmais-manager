'use client';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './workspace.module.css';
import editor from './catalogo-editor.module.css';
import { AdminPrimaryButton } from './AdminPrimaryButton';

const contagemItens = (total: number) => `${total} ${total === 1 ? 'item' : 'itens'}`;

type Registro = { id: string; nome: string; ativo: boolean; categoria_id?: string | null };
type Catalogo = { categorias: Registro[]; itens: Registro[] };
type Formulario = { id?: string; nome: string; ativo: boolean; categoriaId: string };

const pagina = 12;

export default function CatalogoEditor({ vitrine }: { vitrine?: Catalogo & { secao?: 'categorias' | 'itens' } }) {
  const [dados, setDados] = useState<Catalogo | null>(vitrine ?? null);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [secao, setSecao] = useState<'categorias' | 'itens'>(vitrine?.secao ?? 'categorias');
  const [busca, setBusca] = useState('');
  const [filtroCategoria, setFiltroCategoria] = useState('');
  const [paginaAtual, setPaginaAtual] = useState(0);
  const [formulario, setFormulario] = useState<Formulario | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [excluindo, setExcluindo] = useState<Registro | null>(null);

  async function carregar() {
    const resposta = await adminFetch('/api/admin/configuracoes/catalogo');
    const body = await resposta.json();
    if (!resposta.ok || body.ok === false) throw Error(body.erro || 'Falha ao carregar o buffet.');
    setDados({ categorias: body.data.categorias, itens: body.data.itens });
  }

  useEffect(() => {
    if (vitrine) return;
    let ativo = true;
    adminFetch('/api/admin/configuracoes/catalogo')
      .then(async (resposta) => {
        const body = await resposta.json();
        if (!ativo) return;
        if (!resposta.ok || body.ok === false) throw Error(body.erro || 'Falha ao carregar o buffet.');
        setDados({ categorias: body.data.categorias, itens: body.data.itens });
      })
      .catch((e) => { if (ativo) setErro(e instanceof Error ? e.message : 'Falha ao carregar o buffet.'); });
    return () => { ativo = false; };
  }, [vitrine]);

  const nomeCategoria = (id?: string | null) => dados?.categorias.find((categoria) => categoria.id === id)?.nome ?? '—';
  const linhas = useMemo(() => {
    const termo = busca.trim().toLocaleLowerCase('pt-BR');
    const categorias = dados?.categorias ?? [];
    const itens = dados?.itens ?? [];
    if (secao === 'categorias') {
      return categorias.filter((categoria) => !termo || categoria.nome.toLocaleLowerCase('pt-BR').includes(termo));
    }
    return itens.filter((item) => {
      const categoria = categorias.find((atual) => atual.id === item.categoria_id)?.nome ?? '—';
      const texto = `${item.nome} ${categoria}`.toLocaleLowerCase('pt-BR');
      return (!termo || texto.includes(termo)) && (!filtroCategoria || item.categoria_id === filtroCategoria || (filtroCategoria === 'sem' && !item.categoria_id));
    });
  }, [dados, secao, busca, filtroCategoria]);
  const ultimaPagina = Math.max(0, Math.ceil(linhas.length / pagina) - 1);
  const paginaSegura = Math.min(paginaAtual, ultimaPagina);
  const visiveis = linhas.slice(paginaSegura * pagina, paginaSegura * pagina + pagina);

  async function gravar(evento: FormEvent) {
    evento.preventDefault();
    if (!formulario) return;
    setErro('');
    const acao = secao === 'categorias'
      ? (formulario.id ? { acao: 'categoria', id: formulario.id, nome: formulario.nome, ativo: formulario.ativo } : { acao: 'nova_categoria', nome: formulario.nome, ativo: formulario.ativo })
      : (formulario.id
        ? { acao: 'item', id: formulario.id, nome: formulario.nome, ativo: formulario.ativo, categoriaId: formulario.categoriaId || null }
        : { acao: 'novo_item', nome: formulario.nome, categoriaId: formulario.categoriaId || null, ativo: formulario.ativo });
    const resposta = await adminFetch('/api/admin/configuracoes/catalogo', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(acao),
    });
    const body = await resposta.json();
    if (!resposta.ok || body.ok === false) {
      setErro(body.erro || 'Não foi possível salvar.');
      return;
    }
    setFormulario(null);
    setAviso('Alterações salvas.');
    await carregar();
  }

  async function excluir() {
    if (!excluindo) return;
    const resposta = await adminFetch('/api/admin/configuracoes/catalogo', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acao: secao === 'categorias' ? 'excluir_categoria' : 'excluir_item', id: excluindo.id }),
    });
    const body = await resposta.json();
    if (!resposta.ok || body.ok === false) {
      setErro(body.erro || 'Não foi possível excluir.');
      setExcluindo(null);
      return;
    }
    setExcluindo(null);
    setAviso('Excluído.');
    await carregar();
  }

  return <main className={styles.page} data-admin-workspace>
    <header className={styles.header}>
      <h1>Itens do Buffet</h1>
      <AdminPrimaryButton onClick={() => { setErro(''); setFormulario({ nome: '', ativo: true, categoriaId: filtroCategoria && filtroCategoria !== 'sem' ? filtroCategoria : '' }); }}>{secao === 'categorias' ? '+ Nova categoria' : '+ Novo item'}</AdminPrimaryButton>
    </header>
    <div className={styles.content}>
      <div className={editor.toolbar}>
        <div className={editor.sections} aria-label="Seções do buffet">
          <button type="button" aria-pressed={secao === 'categorias'} onClick={() => { setSecao('categorias'); setBusca(''); setPaginaAtual(0); }}>Categorias</button>
          <button type="button" aria-pressed={secao === 'itens'} onClick={() => { setSecao('itens'); setBusca(''); setPaginaAtual(0); }}>Itens</button>
        </div>
        <div className={styles.filters}>
          <label>Busca<input type="search" value={busca} onChange={(evento) => { setBusca(evento.target.value); setPaginaAtual(0); }} /></label>
          {secao === 'itens' && <label>Categoria<select value={filtroCategoria} onChange={(evento) => { setFiltroCategoria(evento.target.value); setPaginaAtual(0); }}>
            <option value="">Todas</option>
            <option value="sem">Sem categoria</option>
            {dados?.categorias.map((categoria) => <option key={categoria.id} value={categoria.id}>{categoria.nome}</option>)}
          </select></label>}
        </div>
        {erro && <p role="alert">{erro}</p>}
        {aviso && <p>{aviso}</p>}
      </div>
      <div className={editor.lista}>
        <table className={editor.tabela}>
          <thead><tr>{secao === 'categorias' ? <><th>Categoria</th><th>Nº de itens</th><th>Status</th></> : <><th>Item</th><th>Categoria</th><th>Status</th></>}<th></th></tr></thead>
          <tbody>
            {visiveis.map((linha) => <tr key={linha.id}>
              <td data-label={secao === 'categorias' ? 'Categoria' : 'Item'}>{linha.nome}</td>
              <td data-label={secao === 'categorias' ? 'Nº de itens' : 'Categoria'}>{secao === 'categorias' ? dados?.itens.filter((item) => item.categoria_id === linha.id).length ?? 0 : nomeCategoria(linha.categoria_id)}</td>
              <td data-label="Status">{linha.ativo ? 'Ativo' : 'Inativo'}</td>
              <td>
                <button type="button" aria-label={`Ações de ${linha.nome}`} aria-expanded={menu === linha.id} onClick={() => setMenu(menu === linha.id ? null : linha.id)}>...</button>
                {menu === linha.id && <div className={editor.menu} role="menu">
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); setFormulario({ id: linha.id, nome: linha.nome, ativo: linha.ativo, categoriaId: linha.categoria_id ?? '' }); }}>Editar</button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(null); setExcluindo(linha); }}>Excluir</button>
                </div>}
              </td>
            </tr>)}
          </tbody>
        </table>
        <div className={editor.cards}>
          {visiveis.map((linha) => <article key={linha.id}>
            <strong>{linha.nome}</strong>
            <span>{secao === 'categorias' ? contagemItens(dados?.itens.filter((item) => item.categoria_id === linha.id).length ?? 0) : nomeCategoria(linha.categoria_id)}</span>
            <span>{linha.ativo ? 'Ativo' : 'Inativo'}</span>
            <button type="button" onClick={() => setFormulario({ id: linha.id, nome: linha.nome, ativo: linha.ativo, categoriaId: linha.categoria_id ?? '' })}>Editar</button>
            <button type="button" onClick={() => setExcluindo(linha)}>Excluir</button>
          </article>)}
        </div>
        {dados && !linhas.length && <p>Nenhum resultado.</p>}
        {linhas.length > pagina && <div className={styles.filters}>
          <button type="button" disabled={paginaSegura === 0} onClick={() => setPaginaAtual(paginaSegura - 1)}>Anterior</button>
          <button type="button" disabled={(paginaSegura + 1) * pagina >= linhas.length} onClick={() => setPaginaAtual(paginaSegura + 1)}>Próxima</button>
        </div>}
      </div>
      {formulario && <div className={editor.overlay} role="dialog" aria-label={secao === 'categorias' ? 'Categoria' : 'Item'}>
        <form className={editor.painel} onSubmit={gravar}>
          <label>Nome *<input required value={formulario.nome} onChange={(evento) => setFormulario({ ...formulario, nome: evento.target.value })} /></label>
          {secao === 'itens' && <label>Categoria<select value={formulario.categoriaId} onChange={(evento) => setFormulario({ ...formulario, categoriaId: evento.target.value })}>
            <option value="">Sem categoria</option>
            {dados?.categorias.map((categoria) => <option key={categoria.id} value={categoria.id}>{categoria.nome}</option>)}
          </select></label>}
          <label>Status<select value={formulario.ativo ? 'ativo' : 'inativo'} onChange={(evento) => setFormulario({ ...formulario, ativo: evento.target.value === 'ativo' })}>
            <option value="ativo">Ativo</option>
            <option value="inativo">Inativo</option>
          </select></label>
          <div className={styles.actions}>
            <AdminPrimaryButton type="submit">{formulario.id ? 'Salvar alterações' : 'Salvar'}</AdminPrimaryButton>
            <button type="button" onClick={() => setFormulario(null)}>Cancelar</button>
          </div>
        </form>
      </div>}
      {excluindo && <div className={editor.overlay} role="dialog" aria-label="Confirmar exclusão">
        <div className={editor.painel}>
        <p>Excluir {excluindo.nome}?</p>
        <div className={styles.actions}>
          <button type="button" onClick={() => void excluir()}>Excluir</button>
          <button type="button" onClick={() => setExcluindo(null)}>Cancelar</button>
        </div>
        </div>
      </div>}
    </div>
  </main>;
}
