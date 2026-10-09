'use client';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './workspace.module.css';
import editor from './catalogo-editor.module.css';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import { formularioAdicional, pedidoAdicional, precoNaLista, UNIDADES, type AdicionaisAdmin, type AdicionalAdmin, type FormularioAdicional } from './catalogo-adicionais';

const contagemItens = (total: number) => `${total} ${total === 1 ? 'item' : 'itens'}`;

type Registro = { id: string; nome: string; ativo: boolean; categoria_id?: string | null };
type Catalogo = { categorias: Registro[]; itens: Registro[] };
type Formulario = { id?: string; nome: string; ativo: boolean; categoriaId: string };
type Secao = 'categorias' | 'itens' | 'outros';

const pagina = 12;

export default function CatalogoEditor({ vitrine }: { vitrine?: Catalogo & { secao?: 'categorias' | 'itens' } }) {
  const [dados, setDados] = useState<Catalogo | null>(vitrine ?? null);
  const [adicionais, setAdicionais] = useState<AdicionaisAdmin | null>(null);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [secao, setSecao] = useState<Secao>(vitrine?.secao ?? 'categorias');
  const [busca, setBusca] = useState('');
  const [filtroCategoria, setFiltroCategoria] = useState('');
  const [paginaAtual, setPaginaAtual] = useState(0);
  const [formulario, setFormulario] = useState<Formulario | null>(null);
  const [formAdicional, setFormAdicional] = useState<FormularioAdicional | null>(null);
  const [salvandoAdicional, setSalvandoAdicional] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [excluindo, setExcluindo] = useState<Registro | null>(null);
  const [excluindoAdicional, setExcluindoAdicional] = useState<{ id: string; nome: string; pacotes: number } | null>(null);
  const [excluindoEmCurso, setExcluindoEmCurso] = useState(false);

  async function carregar() {
    const resposta = await adminFetch('/api/admin/configuracoes/catalogo');
    const body = await resposta.json();
    if (!resposta.ok || body.ok === false) throw Error(body.erro || 'Falha ao carregar o buffet.');
    setDados({ categorias: body.data.categorias, itens: body.data.itens });
  }

  async function carregarAdicionais() {
    const resposta = await adminFetch('/api/admin/configuracoes/adicionais');
    const body = await resposta.json();
    if (!resposta.ok || body.ok === false) throw Error(body.erro || 'Falha ao carregar os adicionais.');
    setAdicionais(body.data);
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
    adminFetch('/api/admin/configuracoes/adicionais')
      .then(async (resposta) => {
        const body = await resposta.json();
        if (!ativo) return;
        if (!resposta.ok || body.ok === false) throw Error(body.erro || 'Falha ao carregar os adicionais.');
        setAdicionais(body.data);
      })
      .catch((e) => { if (ativo) setErro(e instanceof Error ? e.message : 'Falha ao carregar os adicionais.'); });
    return () => { ativo = false; };
  }, [vitrine]);

  const adicionalDaOrigem = (tipo: 'ITEM' | 'CATEGORIA', id: string) =>
    adicionais?.adicionais.find((a) => a.origem?.tipo === tipo && a.origem.id === id) ?? null;
  const outros = useMemo(() => (adicionais?.adicionais ?? []).filter((a) => a.origem === null), [adicionais]);

  const nomeCategoria = (id?: string | null) => dados?.categorias.find((categoria) => categoria.id === id)?.nome ?? '—';
  const linhas = useMemo((): Registro[] => {
    const termo = busca.trim().toLocaleLowerCase('pt-BR');
    const categorias = dados?.categorias ?? [];
    const itens = dados?.itens ?? [];
    if (secao === 'categorias') {
      return categorias.filter((categoria) => !termo || categoria.nome.toLocaleLowerCase('pt-BR').includes(termo));
    }
    if (secao === 'outros') {
      return outros
        .filter((a) => !termo || a.nome.toLocaleLowerCase('pt-BR').includes(termo))
        .map((a) => ({ id: a.id, nome: a.nome, ativo: a.ativo }));
    }
    return itens.filter((item) => {
      const categoria = categorias.find((atual) => atual.id === item.categoria_id)?.nome ?? '—';
      const texto = `${item.nome} ${categoria}`.toLocaleLowerCase('pt-BR');
      return (!termo || texto.includes(termo)) && (!filtroCategoria || item.categoria_id === filtroCategoria || (filtroCategoria === 'sem' && !item.categoria_id));
    });
  }, [dados, secao, busca, filtroCategoria, outros]);
  const ultimaPagina = Math.max(0, Math.ceil(linhas.length / pagina) - 1);
  const paginaSegura = Math.min(paginaAtual, ultimaPagina);
  const visiveis = linhas.slice(paginaSegura * pagina, paginaSegura * pagina + pagina);

  /** Adicional da linha: o do item/categoria do buffet, ou o próprio adicional na aba "Outros adicionais". */
  function adicionalDaLinha(linha: Registro): AdicionalAdmin | null {
    if (secao === 'outros') return outros.find((a) => a.id === linha.id) ?? null;
    return adicionalDaOrigem(secao === 'categorias' ? 'CATEGORIA' : 'ITEM', linha.id);
  }

  function abrirAdicional(linha: Registro | null) {
    if (!adicionais) return;
    setErro('');
    setMenu(null);
    if (secao === 'outros') {
      setFormAdicional(formularioAdicional(linha ? adicionalDaLinha(linha) : null, null, adicionais));
      return;
    }
    const tipo = secao === 'categorias' ? 'CATEGORIA' : 'ITEM';
    setFormAdicional(formularioAdicional(adicionalDaOrigem(tipo, linha!.id), { tipo, id: linha!.id, nome: linha!.nome }, adicionais));
  }

  async function gravarAdicional(evento: FormEvent) {
    evento.preventDefault();
    if (!formAdicional || !adicionais) return;
    const pedido = pedidoAdicional(formAdicional);
    if (typeof pedido === 'string') { setErro(pedido); return; }
    setErro('');
    setSalvandoAdicional(true);
    try {
      const resposta = await adminFetch('/api/admin/configuracoes/adicionais', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pedido),
      });
      const body = await resposta.json();
      if (!resposta.ok || body.ok === false) {
        setErro(body.erro || 'Não foi possível salvar o adicional.');
        // O cadastro e o preço podem ter sido salvos antes de um pacote falhar: a lista reflete o que ficou.
        if (body.detalhes?.adicionalId) {
          setFormAdicional(null);
          await carregarAdicionais().catch(() => undefined);
        }
        return;
      }
      setFormAdicional(null);
      setAviso('Adicional salvo.');
      await carregarAdicionais();
    } catch {
      setErro('Não foi possível salvar o adicional.');
    } finally {
      setSalvandoAdicional(false);
    }
  }

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

  /** Exclui (sem histórico) ou arquiva (com histórico): quem decide é o servidor, que devolve o que aconteceu. */
  async function excluirAdicional() {
    if (!excluindoAdicional) return;
    setExcluindoEmCurso(true);
    setErro('');
    try {
      const resposta = await adminFetch(`/api/admin/configuracoes/adicionais?id=${encodeURIComponent(excluindoAdicional.id)}`, { method: 'DELETE' });
      const body = await resposta.json();
      if (!resposta.ok || body.ok === false) { setErro(body.erro || 'Não foi possível excluir o adicional.'); return; }
      const r = body.data as { resultado: 'EXCLUIDO' | 'ARQUIVADO'; festas: number };
      setAviso(r.resultado === 'EXCLUIDO'
        ? `“${excluindoAdicional.nome}” foi excluído.`
        : `“${excluindoAdicional.nome}” foi arquivado${r.festas ? `: já aparece em ${r.festas} ${r.festas === 1 ? 'festa' : 'festas'}` : ': já tem preço publicado ou histórico'}. Ele não aparece mais no fechamento.`);
      setExcluindoAdicional(null);
      setFormAdicional(null);
      await carregarAdicionais();
    } catch {
      setErro('Não foi possível excluir o adicional.');
    } finally {
      setExcluindoEmCurso(false);
    }
  }

  const comAdicionais = Boolean(adicionais);
  const rotuloAdicional = (linha: Registro) => {
    const adicional = adicionalDaLinha(linha);
    return adicional && adicional.ativo ? precoNaLista(adicional) : '—';
  };
  const paraExcluir = (linha: Registro) => ({
    id: linha.id, nome: linha.nome,
    pacotes: Object.values(adicionalDaLinha(linha)?.pacotes ?? {}).filter((m) => m === 'EXTRA').length,
  });
  const textoNovo =secao === 'categorias' ? '+ Nova categoria' : secao === 'itens' ? '+ Novo item' : '+ Novo adicional';

  return <main className={styles.page} data-admin-workspace>
    <header className={styles.header}>
      <h1>Itens do Buffet</h1>
      <AdminPrimaryButton disabled={secao === 'outros' && !adicionais} onClick={() => {
        setErro('');
        if (secao === 'outros') { abrirAdicional(null); return; }
        setFormulario({ nome: '', ativo: true, categoriaId: filtroCategoria && filtroCategoria !== 'sem' ? filtroCategoria : '' });
      }}>{textoNovo}</AdminPrimaryButton>
    </header>
    <div className={styles.content}>
      <div className={editor.toolbar}>
        <div className={editor.sections} aria-label="Seções do buffet">
          <button type="button" aria-pressed={secao === 'categorias'} onClick={() => { setSecao('categorias'); setBusca(''); setPaginaAtual(0); }}>Categorias</button>
          <button type="button" aria-pressed={secao === 'itens'} onClick={() => { setSecao('itens'); setBusca(''); setPaginaAtual(0); }}>Itens</button>
          {!vitrine && <button type="button" aria-pressed={secao === 'outros'} onClick={() => { setSecao('outros'); setBusca(''); setPaginaAtual(0); }}>Outros adicionais</button>}
        </div>
        <div className={styles.filters}>
          <label>Busca<input type="search" value={busca} onChange={(evento) => { setBusca(evento.target.value); setPaginaAtual(0); }} /></label>
          {secao === 'itens' && <label>Categoria<select value={filtroCategoria} onChange={(evento) => { setFiltroCategoria(evento.target.value); setPaginaAtual(0); }}>
            <option value="">Todas</option>
            <option value="sem">Sem categoria</option>
            {dados?.categorias.map((categoria) => <option key={categoria.id} value={categoria.id}>{categoria.nome}</option>)}
          </select></label>}
        </div>
        {erro && !formAdicional && <p role="alert">{erro}</p>}
        {aviso && <p>{aviso}</p>}
        {adicionais?.migracaoPendente && <p className={editor.aviso}>Adicionais do buffet aguardam a atualização do banco (070).</p>}
        {adicionais && !adicionais.migracaoPendente && !adicionais.tabelaCorrente && <p className={editor.aviso}>Não há tabela de preços publicada: publique os preços dos pacotes para dar valor aos adicionais.</p>}
        {adicionais?.aviso && <p className={editor.aviso}>{adicionais.aviso}</p>}
      </div>
      <div className={editor.lista}>
        <table className={editor.tabela}>
          <thead><tr>
            {secao === 'categorias' ? <><th>Categoria</th><th>Nº de itens</th></> : secao === 'itens' ? <><th>Item</th><th>Categoria</th></> : <><th>Adicional</th><th>Pacotes</th></>}
            {comAdicionais && <th>{secao === 'outros' ? 'Preço' : 'Adicional'}</th>}
            <th>Status</th><th></th>
          </tr></thead>
          <tbody>
            {visiveis.map((linha) => <tr key={linha.id}>
              <td data-label={secao === 'categorias' ? 'Categoria' : secao === 'itens' ? 'Item' : 'Adicional'}>{linha.nome}</td>
              <td data-label={secao === 'categorias' ? 'Nº de itens' : secao === 'itens' ? 'Categoria' : 'Pacotes'}>{secao === 'categorias' ? dados?.itens.filter((item) => item.categoria_id === linha.id).length ?? 0 : secao === 'itens' ? nomeCategoria(linha.categoria_id) : Object.values(adicionalDaLinha(linha)?.pacotes ?? {}).filter((m) => m === 'EXTRA').length}</td>
              {comAdicionais && <td data-label="Adicional">{rotuloAdicional(linha)}</td>}
              <td data-label="Status">{linha.ativo ? 'Ativo' : 'Inativo'}</td>
              <td>
                <button type="button" aria-label={`Ações de ${linha.nome}`} aria-expanded={menu === linha.id} onClick={() => setMenu(menu === linha.id ? null : linha.id)}>...</button>
                {menu === linha.id && <div className={editor.menu} role="menu">
                  {secao !== 'outros' && <button type="button" role="menuitem" onClick={() => { setMenu(null); setFormulario({ id: linha.id, nome: linha.nome, ativo: linha.ativo, categoriaId: linha.categoria_id ?? '' }); }}>Editar</button>}
                  {comAdicionais && <button type="button" role="menuitem" onClick={() => abrirAdicional(linha)}>{secao === 'outros' ? 'Editar' : 'Vender como adicional'}</button>}
                  {secao !== 'outros' && <button type="button" role="menuitem" onClick={() => { setMenu(null); setExcluindo(linha); }}>Excluir</button>}
                  {secao === 'outros' && <button type="button" role="menuitem" onClick={() => { setMenu(null); setExcluindoAdicional(paraExcluir(linha)); }}>Excluir</button>}
                </div>}
              </td>
            </tr>)}
          </tbody>
        </table>
        <div className={editor.cards}>
          {visiveis.map((linha) => <article key={linha.id}>
            <strong>{linha.nome}</strong>
            <span>{secao === 'categorias' ? contagemItens(dados?.itens.filter((item) => item.categoria_id === linha.id).length ?? 0) : secao === 'itens' ? nomeCategoria(linha.categoria_id) : 'Outro adicional'}</span>
            {comAdicionais && <span>Adicional: {rotuloAdicional(linha)}</span>}
            <span>{linha.ativo ? 'Ativo' : 'Inativo'}</span>
            {secao !== 'outros' && <button type="button" onClick={() => setFormulario({ id: linha.id, nome: linha.nome, ativo: linha.ativo, categoriaId: linha.categoria_id ?? '' })}>Editar</button>}
            {comAdicionais && <button type="button" onClick={() => abrirAdicional(linha)}>{secao === 'outros' ? 'Editar' : 'Vender como adicional'}</button>}
            {secao !== 'outros' && <button type="button" onClick={() => setExcluindo(linha)}>Excluir</button>}
            {secao === 'outros' && <button type="button" onClick={() => setExcluindoAdicional(paraExcluir(linha))}>Excluir</button>}
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
      {formAdicional && adicionais && <div className={`${editor.overlay} ${editor.overlayGaveta}`} role="dialog" aria-label="Adicional">
        <form className={`${editor.painel} ${editor.painelAdicional}`} onSubmit={gravarAdicional}>
          <header className={editor.painelTopo}>
            <h2>{formAdicional.origem ? `${formAdicional.origem.nome} como adicional` : formAdicional.id ? 'Editar adicional' : 'Novo adicional'}</h2>
            <button type="button" className={editor.fechar} aria-label="Fechar" onClick={() => { setFormAdicional(null); setErro(''); }}>×</button>
          </header>
          <div className={editor.painelCorpo}>
          {formAdicional.origem?.tipo === 'CATEGORIA' && <p className={editor.ajuda}>Um adicional único da categoria: o cliente escolhe as opções entre os itens ativos dela.</p>}
          <label className={editor.linhaCheck}><input type="checkbox" checked={formAdicional.ativo} onChange={(e) => setFormAdicional({ ...formAdicional, ativo: e.target.checked })} />{formAdicional.origem ? 'Vender como adicional' : 'Ativo (aparece no fechamento)'}</label>
          <label>Nome no fechamento *<input required maxLength={160} value={formAdicional.nome} onChange={(e) => setFormAdicional({ ...formAdicional, nome: e.target.value })} /></label>
          <div className={editor.duasColunas}>
            {!formAdicional.origem && <label>Grupo<select value={formAdicional.categoria} onChange={(e) => setFormAdicional({ ...formAdicional, categoria: e.target.value })}>
              {adicionais.categorias.map((c) => <option key={c.codigo} value={c.codigo}>{c.nome}</option>)}
            </select></label>}
            <label>Cobrança<select value={formAdicional.unidadeCobranca} onChange={(e) => setFormAdicional({ ...formAdicional, unidadeCobranca: e.target.value as FormularioAdicional['unidadeCobranca'] })}>
              {UNIDADES.map((u) => <option key={u.valor} value={u.valor}>{u.rotulo}</option>)}
            </select></label>
          </div>
          <div className={editor.modo} role="group" aria-label="Forma de preço">
            <button type="button" aria-pressed={formAdicional.modo === 'UNICO'} onClick={() => setFormAdicional({ ...formAdicional, modo: 'UNICO' })}>Preço único</button>
            <button type="button" aria-pressed={formAdicional.modo === 'FAIXAS'} onClick={() => setFormAdicional({ ...formAdicional, modo: 'FAIXAS' })}>Por faixa de convidados</button>
          </div>
          {formAdicional.modo === 'UNICO' && <label>Preço (R$)<input inputMode="decimal" placeholder="Sem preço: não é oferecido" value={formAdicional.preco} disabled={!adicionais.tabelaCorrente} onChange={(e) => setFormAdicional({ ...formAdicional, preco: e.target.value })} /></label>}
          {formAdicional.modo === 'UNICO' && formAdicional.faixasPreco > 1 && <p className={editor.ajuda}>Hoje há {formAdicional.faixasPreco} faixas de preço por convidados. Ao salvar um valor único, ele passa a valer para qualquer número de convidados.</p>}
          {formAdicional.modo === 'FAIXAS' && <div className={editor.faixas}>
            {formAdicional.faixas.map((f, i) => <div key={i} className={editor.faixaLinha}>
              <label>De<input inputMode="numeric" value={f.min} onChange={(e) => setFormAdicional({ ...formAdicional, faixas: formAdicional.faixas.map((x, k) => k === i ? { ...x, min: e.target.value } : x) })} /></label>
              <label>Até<input inputMode="numeric" placeholder="sem fim" value={f.max} onChange={(e) => setFormAdicional({ ...formAdicional, faixas: formAdicional.faixas.map((x, k) => k === i ? { ...x, max: e.target.value } : x) })} /></label>
              <label>Rótulo<input placeholder="ex.: Pequena" value={f.rotulo} onChange={(e) => setFormAdicional({ ...formAdicional, faixas: formAdicional.faixas.map((x, k) => k === i ? { ...x, rotulo: e.target.value } : x) })} /></label>
              <label>Preço<input inputMode="decimal" value={f.valor} disabled={!adicionais.tabelaCorrente} onChange={(e) => setFormAdicional({ ...formAdicional, faixas: formAdicional.faixas.map((x, k) => k === i ? { ...x, valor: e.target.value } : x) })} /></label>
              <button type="button" aria-label="Remover faixa" onClick={() => setFormAdicional({ ...formAdicional, faixas: formAdicional.faixas.filter((_, k) => k !== i) })}>×</button>
            </div>)}
            <button type="button" onClick={() => { const u = formAdicional.faixas.at(-1); const proximo = u?.max ? String(Number(u.max) + 1) : ''; setFormAdicional({ ...formAdicional, faixas: [...formAdicional.faixas, { min: proximo, max: '', rotulo: '', valor: '' }] }); }}>+ Adicionar faixa</button>
            <p className={editor.ajuda}>O cliente vê só o preço da faixa dos convidados dele.</p>
          </div>}
          {formAdicional.origem?.tipo === 'CATEGORIA' && <label>Máximo de opções que o cliente escolhe<input type="number" min={1} max={30} step={1} placeholder="Sem limite" value={formAdicional.escolhasMax} onChange={(e) => setFormAdicional({ ...formAdicional, escolhasMax: e.target.value })} /></label>}
          <fieldset className={editor.pacotes}>
            <legend>Oferecer nos pacotes</legend>
            {adicionais.pacotes.length === 0 && <p>Nenhum pacote vigente.</p>}
            {adicionais.pacotes.map((p) => {
              const modalidade = formAdicional.pacotes[p.id] ?? 'INDISPONIVEL';
              return <label key={p.id} className={editor.linhaCheck}>
                <input type="checkbox" checked={modalidade !== 'INDISPONIVEL'} disabled={modalidade === 'INCLUSO'}
                  onChange={(e) => setFormAdicional({ ...formAdicional, pacotes: { ...formAdicional.pacotes, [p.id]: e.target.checked ? 'EXTRA' : 'INDISPONIVEL' } })} />
                {p.nome}{modalidade === 'INCLUSO' ? ' (incluso no pacote)' : ''}
              </label>;
            })}
          </fieldset>
          {erro && <p role="alert">{erro}</p>}
          </div>
          <footer className={editor.painelRodape}>
            {formAdicional.id ? <button type="button" className={editor.perigo} onClick={() => setExcluindoAdicional({ id: formAdicional.id!, nome: formAdicional.nome, pacotes: Object.values(formAdicional.pacotes).filter((m) => m === 'EXTRA').length })}>Excluir adicional</button> : <span />}
            <div className={editor.rodapeAcoes}>
              <button type="button" onClick={() => { setFormAdicional(null); setErro(''); }}>Cancelar</button>
              <AdminPrimaryButton type="submit" disabled={salvandoAdicional || adicionais.migracaoPendente}>{salvandoAdicional ? 'Salvando…' : 'Salvar'}</AdminPrimaryButton>
            </div>
          </footer>
        </form>
      </div>}
      {excluindoAdicional && <div className={`${editor.overlay} ${editor.overlayCentro}`} role="dialog" aria-label="Confirmar exclusão do adicional">
        <div className={`${editor.painel} ${editor.confirmacao}`}>
          <h2>Excluir “{excluindoAdicional.nome}”?</h2>
          <p>Ele sai do fechamento{excluindoAdicional.pacotes === 1 ? ' e do pacote que o oferece' : excluindoAdicional.pacotes > 1 ? ` e dos ${excluindoAdicional.pacotes} pacotes que o oferecem` : ''}.</p>
          <p className={editor.avisoArquivo}>Se ele já tiver histórico (preço publicado, festa ou contrato), será <b>arquivado</b>: some das novas festas, mas continua nas festas e contratos que já o têm. Dá para reativá-lo depois em Outros adicionais.</p>
          {erro && <p role="alert">{erro}</p>}
          <div className={editor.rodapeAcoes}>
            <button type="button" onClick={() => setExcluindoAdicional(null)}>Cancelar</button>
            <button type="button" className={editor.botaoExcluir} disabled={excluindoEmCurso} onClick={() => void excluirAdicional()}>{excluindoEmCurso ? 'Excluindo…' : 'Excluir'}</button>
          </div>
        </div>
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
