'use client';

import { useState, type FormEvent } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './admin.module.css';

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

const vazio = { codigo: '', nome: '', descricao: '', duracao: '' };

export default function PacotesAdmin() {
  const [empresaId, setEmpresaId] = useState('');
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
  const [carregando, setCarregando] = useState(false);
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

  async function carregar(event?: FormEvent) {
    event?.preventDefault();
    setCarregando(true);
    setErro('');
    setAviso('');
    setPacotes(null);
    try {
      const [lista, itens] = await Promise.all([
        adminFetch(`/api/admin/configuracoes/pacotes?empresaId=${encodeURIComponent(empresaId)}`),
        adminFetch('/api/admin/configuracoes/catalogo'),
      ]);
      const pacote = await ler(lista);
      const catalogoJson = await ler(itens);
      setPacotes(pacote.data);
      setCatalogo({ adicionais: catalogoJson.data.adicionais, categorias: catalogoJson.data.categorias });
      if (!pacote.data.length) setAviso('Nenhum pacote nesta empresa.');
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao carregar.');
    } finally {
      setCarregando(false);
    }
  }

  async function enviar(acao: string, extra: Record<string, unknown>) {
    setCarregando(true);
    setErro('');
    setAviso('');
    try {
      const response = await adminFetch('/api/admin/configuracoes/pacotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao, empresaId, motivo, ...extra }),
      });
      await ler(response);
      setAviso('Pacote salvo.');
      setForm(vazio);
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
        body: JSON.stringify({ acao, empresaId, motivo, ...extra }),
      });
      await ler(response);
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
      const response = await adminFetch(`/api/admin/configuracoes/pacotes/${id}/historico?empresaId=${encodeURIComponent(empresaId)}`);
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
        body: JSON.stringify({ empresaId, ...corpo }),
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

  return (
    <main className={styles.page}>
      <h1>Pacotes</h1>
      <p>Administre os pacotes desta empresa. A tabela em PDF continua em Tabela de pacotes e preços.</p>
      <p role="alert">{erro}</p>
      <p role="status">{aviso}</p>
      <form onSubmit={carregar}>
        <label htmlFor="empresa">Empresa
          <input id="empresa" value={empresaId} onChange={(event) => setEmpresaId(event.target.value)} required autoComplete="off" />
        </label>
        <button type="submit" disabled={carregando}>{carregando ? 'Carregando…' : 'Listar pacotes'}</button>
      </form>

      {pacotes && pacotes.length === 0 && <p>Nenhum pacote nesta empresa. Crie o primeiro abaixo.</p>}
      {pacotes && pacotes.length > 0 && (
        <ul>
          {pacotes.map((pacote) => (
            <li key={pacote.id}>
              <button type="button" onClick={() => { setSelecionado(pacote.id); setForm({ codigo: pacote.codigo, nome: pacote.nome, descricao: pacote.descricao ?? '', duracao: pacote.duracaoMinutos?.toString() ?? '' }); }}>
                {pacote.nome} ({pacote.codigo}) {pacote.ativo ? 'ativo' : 'inativo'} {pacote.utilizado ? '— utilizado' : ''}
              </button>
            </li>
          ))}
        </ul>
      )}

      <h2>{atual ? 'Editar pacote' : 'Criar pacote'}</h2>
      {atual?.utilizado && <p>Este pacote já foi utilizado. Uma mudança futura cria uma revisão e preserva a anterior.</p>}
      <form onSubmit={(event) => {
        event.preventDefault();
        const descricao = form.descricao.trim() ? form.descricao.trim() : null;
        const duracaoMinutos = form.duracao.trim() ? Number(form.duracao) : null;
        if (atual?.utilizado) void alterar(atual.id, 'revisar', { nome: form.nome, descricao, duracaoMinutos });
        else if (atual) void alterar(atual.id, 'editar', { nome: form.nome, descricao, duracaoMinutos });
        else void enviar('criar', { codigo: form.codigo, nome: form.nome, descricao, duracaoMinutos });
      }}>
        {!atual && <label htmlFor="codigo">Código<input id="codigo" value={form.codigo} onChange={(event) => setForm({ ...form, codigo: event.target.value.toUpperCase() })} required /></label>}
        <label htmlFor="nome">Nome<input id="nome" value={form.nome} onChange={(event) => setForm({ ...form, nome: event.target.value })} required /></label>
        <label htmlFor="descricao">Descrição<textarea id="descricao" value={form.descricao} onChange={(event) => setForm({ ...form, descricao: event.target.value })} /></label>
        <label htmlFor="duracao">Duração em minutos<input id="duracao" inputMode="numeric" value={form.duracao} onChange={(event) => setForm({ ...form, duracao: event.target.value })} /></label>
        <label htmlFor="motivo">Motivo<input id="motivo" value={motivo} onChange={(event) => setMotivo(event.target.value)} required minLength={3} /></label>
        <button type="submit" disabled={carregando || !empresaId}>{atual?.utilizado ? 'Criar revisão' : 'Salvar'}</button>
        {atual && <button type="button" onClick={() => { setSelecionado(null); setForm(vazio); }}>Novo pacote</button>}
        {atual && <button type="button" onClick={() => void enviar('duplicar', { origemId: atual.id, codigo: `${atual.codigo}_COPIA` })}>Duplicar</button>}
        {atual && !atual.arquivadoEm && <button type="button" onClick={() => void alterar(atual.id, atual.ativo ? 'desativar' : 'ativar')}>{atual.ativo ? 'Desativar' : 'Ativar'}</button>}
        {atual && !atual.arquivadoEm && <button type="button" onClick={() => { if (window.confirm('Arquivar este pacote? Ele deixa de ser a revisão vigente.')) void alterar(atual.id, 'arquivar'); }}>Arquivar</button>}
        {atual && <button type="button" onClick={() => void abrirHistorico(atual.id)}>Histórico</button>}
      </form>

      {historico && (
        <section aria-label="Histórico">
          <h2>Histórico</h2>
          <ul>{historico.map((item) => <li key={item.id}>{item.nome} {item.vigente ? '(vigente)' : '(anterior)'}</li>)}</ul>
        </section>
      )}

      {atual && catalogo && (
        <section aria-label="Composição">
          <h2>Composição</h2>
          <form onSubmit={(event) => { event.preventDefault(); void salvarComposicao(atual.id, { acao: 'vinculo', adicionalId, modalidade }); }}>
            <label htmlFor="adicional">Item
              <select id="adicional" value={adicionalId} onChange={(event) => setAdicionalId(event.target.value)} required>
                <option value="">Selecione</option>
                {catalogo.adicionais.map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}
              </select>
            </label>
            <label htmlFor="modalidade">Modalidade
              <select id="modalidade" value={modalidade} onChange={(event) => setModalidade(event.target.value as typeof modalidade)}>
                <option value="INCLUSO">Incluso</option>
                <option value="EXTRA">Extra pago</option>
                <option value="INDISPONIVEL">Indisponível</option>
              </select>
            </label>
            <button type="submit" disabled={carregando}>Salvar vínculo</button>
          </form>
          <form onSubmit={(event) => { event.preventDefault(); void salvarComposicao(atual.id, { acao: 'buffet', categoriaId, ativo: true, escolhasMin: Number(escolhasMin), escolhasMax: Number(escolhasMax) }); }}>
            <label htmlFor="categoria">Categoria de buffet
              <select id="categoria" value={categoriaId} onChange={(event) => setCategoriaId(event.target.value)} required>
                <option value="">Selecione</option>
                {catalogo.categorias.map((item) => <option key={item.id} value={item.id}>{item.nome}</option>)}
              </select>
            </label>
            <label htmlFor="min">Mínimo<input id="min" inputMode="numeric" value={escolhasMin} onChange={(event) => setEscolhasMin(event.target.value)} /></label>
            <label htmlFor="max">Máximo<input id="max" inputMode="numeric" value={escolhasMax} onChange={(event) => setEscolhasMax(event.target.value)} /></label>
            <button type="submit" disabled={carregando}>Salvar limite</button>
          </form>
        </section>
      )}
    </main>
  );
}
