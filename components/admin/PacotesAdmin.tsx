'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './workspace.module.css';
import visual from './visual.module.css';
import overlay from './catalogo-editor.module.css';
import { DurationField } from './DurationField';
import { formatarDuracao, juntarDuracao, separarDuracao } from '@/lib/comercial/duracao';
import { AjudaCampo } from './AjudaCampo';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import { ConfirmarPrecosPacote } from './ConfirmarPrecosPacote';
import { AVISO_COMBINADO } from './SaloesCombinados';
import { erroDosPontos, PrecosPorQuantidade, pontosDaTela, valorDigitado, type PontoForm } from './PrecosPorQuantidade';
import type { PontoPreco } from '@/lib/comercial/modelo-preco';

type Pacote = {
  id: string;
  nome: string;
  descricao: string | null;
  duracaoMinutos: number | null;
  convidadosMinimos: number | null;
  convidadosMaximos: number | null;
  diasPermitidos: number[];
  ativo: boolean;
  arquivadoEm: string | null;
};

type Horario = { id: string; nome: string; inicio: string; fim: string; dias?: number[] | null };
/** 098: combinado = "salão inteiro" (membros pelo nome). A e B liberados não liberam o combinado. */
type Salao = { id: string; nome: string; unidade: string | null; combinado?: boolean; membros?: string[] };
type Categoria = { id: string; nome: string };
type ItemBuffet = { id: string; nome: string; categoria_id: string | null };
type FaixaForm = { convidadosMin: string; convidadosMax: string; valor: string };
type GradeLeitura = { categoria: string; porConvidado: boolean; faixas: { convidadosMin: number; convidadosMax: number | null; valor: string }[] };
const NOME_GRADE: Record<string, string> = { PADRAO: 'Horário promocional', NOBRE: 'Horário nobre', GERAL: 'Todos os horários' };
const textoFaixa = (min: number, max: number | null) => max == null ? `a partir de ${min}` : min === max ? String(min) : `${min} a ${max}`;
const reais = (v: string) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
type ParDisponibilidade = { dia: number; horarioId: string };
type Painel = {
  pacote: Pacote;
  disponibilidade: ParDisponibilidade[];
  categorias: { categoriaId: string; escolhas: number; ativo: boolean }[];
  itens?: string[];
  saloes?: string[];
  faixas: {
    editavel: boolean;
    faixas: { convidadosMin: number; convidadosMax: number | null; valor: string }[];
    /** 092: preço por quantidades cheias. */
    pontos?: PontoPreco[];
    /** Faixas antigas: o pacote cobra por elas até o buffet confirmar a conversão (proposta). */
    aConfirmar?: boolean;
    proposta?: PontoPreco[];
    aviso: string | null;
    grades?: GradeLeitura[];
  };
};

const DIAS = [
  [1, 'Seg'], [2, 'Ter'], [3, 'Qua'], [4, 'Qui'], [5, 'Sex'], [6, 'Sáb'], [7, 'Dom'],
] as const;

const vazio = { nome: '', descricao: '', horas: '', minutos: '', minimo: '', maximo: '' };

function horaCurta(valor: string) {
  return valor.slice(0, 5);
}

function faixaConvidados(minimo: number | null, maximo: number | null) {
  if (minimo && maximo) return `${minimo} a ${maximo} convidados`;
  if (minimo) return `A partir de ${minimo} convidados`;
  if (maximo) return `Até ${maximo} convidados`;
  return 'Convidados não definidos';
}

function minutosDoHorario(horario: Horario) {
  const [hi, mi] = horario.inicio.split(':').map(Number);
  const [hf, mf] = horario.fim.split(':').map(Number);
  return ((hf ?? 0) * 60 + (mf ?? 0)) - ((hi ?? 0) * 60 + (mi ?? 0));
}

function diasTexto(dias: number[]) {
  const nomes = DIAS.filter(([valor]) => dias.includes(valor)).map(([, rotulo]) => rotulo);
  return nomes.length ? nomes.join(' ') : 'Dias não definidos';
}

export type VitrinePacotes = {
  pacotes: Pacote[];
  horarios: Horario[];
  saloes?: Salao[];
  categorias: Categoria[];
  itens?: ItemBuffet[];
  filtro?: 'todos' | 'ativos' | 'arquivados';
  edicao?: Painel | null;
  precosAConfirmar?: string[];
};

const pontosDoPainel = (pontos?: PontoPreco[]): PontoForm[] => (pontos ?? []).map((p) => ({ convidados: String(p.convidados), valor: valorDigitado(p.valor) }));

export default function PacotesAdmin({ vitrine }: { vitrine?: VitrinePacotes }) {
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState<'todos' | 'ativos' | 'arquivados'>(vitrine?.filtro ?? 'todos');
  const [pacotes, setPacotes] = useState<Pacote[] | null>(vitrine?.pacotes ?? null);
  const [horarios, setHorarios] = useState<Horario[]>(vitrine?.horarios ?? []);
  const [saloes, setSaloes] = useState<Salao[]>(vitrine?.saloes ?? []);
  const [saloesEscolhidos, setSaloesEscolhidos] = useState<string[]>(vitrine?.edicao?.saloes ?? []);
  const [categorias, setCategorias] = useState<Categoria[]>(vitrine?.categorias ?? []);
  const [itensBuffet, setItensBuffet] = useState<ItemBuffet[]>(vitrine?.itens ?? []);
  const edicao = vitrine?.edicao;
  const [itensEscolhidos, setItensEscolhidos] = useState<string[]>(edicao?.itens ?? []);
  const [incluirAberto, setIncluirAberto] = useState(false);
  const [abaIncluir, setAbaIncluir] = useState<'categorias' | 'itens'>('categorias');
  const [buscaIncluir, setBuscaIncluir] = useState('');
  const [form, setForm] = useState(edicao ? {
    nome: edicao.pacote.nome,
    descricao: edicao.pacote.descricao ?? '',
    ...separarDuracao(edicao.pacote.duracaoMinutos),
    minimo: edicao.pacote.convidadosMinimos == null ? '' : String(edicao.pacote.convidadosMinimos),
    maximo: edicao.pacote.convidadosMaximos == null ? '' : String(edicao.pacote.convidadosMaximos),
  } : vazio);
  const [pares, setPares] = useState<ParDisponibilidade[]>(edicao?.disponibilidade ?? []);
  const [faixas, setFaixas] = useState<FaixaForm[]>(edicao?.faixas.faixas.length ? edicao.faixas.faixas.map((faixa) => ({
    convidadosMin: String(faixa.convidadosMin),
    convidadosMax: faixa.convidadosMax == null ? '' : String(faixa.convidadosMax),
    valor: Number(faixa.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  })) : [{ convidadosMin: '', convidadosMax: '', valor: '' }]);
  const [faixasEditaveis, setFaixasEditaveis] = useState(edicao?.faixas.editavel ?? true);
  const [pontos, setPontos] = useState<PontoForm[]>(pontosDoPainel(edicao?.faixas.pontos));
  const [conversao, setConversao] = useState<{ faixas: Painel['faixas']['faixas']; proposta: PontoPreco[] } | null>(
    edicao?.faixas.aConfirmar ? { faixas: edicao.faixas.faixas, proposta: edicao.faixas.proposta ?? [] } : null,
  );
  const [confirmando, setConfirmando] = useState(false);
  const [aConfirmar, setAConfirmar] = useState<string[]>(vitrine?.precosAConfirmar ?? []);
  const [avisoFaixas, setAvisoFaixas] = useState('');
  const [gradesLeitura, setGradesLeitura] = useState<GradeLeitura[]>([]);
  const [inclusos, setInclusos] = useState<Record<string, { incluso: boolean; escolhas: string }>>(() => {
    const proximo: Record<string, { incluso: boolean; escolhas: string }> = {};
    for (const categoria of vitrine?.categorias ?? []) {
      const regra = edicao?.categorias.find((item) => item.categoriaId === categoria.id && item.ativo);
      proximo[categoria.id] = { incluso: Boolean(regra), escolhas: String(regra?.escolhas ?? 1) };
    }
    return proximo;
  });
  const [selecionado, setSelecionado] = useState<string | null>(edicao?.pacote.id ?? null);
  const [carregando, setCarregando] = useState(!vitrine);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');

  async function ler(response: Response) {
    const body = await response.json();
    if (!response.ok || body.ok === false) throw new Error(body.erro || 'Não foi possível concluir a operação.');
    return body;
  }

  const carregar = useCallback(async () => {
    const lista = await adminFetch('/api/admin/configuracoes/pacotes');
    const json = await ler(lista);
    setPacotes(json.data.pacotes);
    setAConfirmar(json.data.precosAConfirmar ?? []);
    setHorarios(json.data.horarios);
    setSaloes(json.data.saloes ?? []);
    setCategorias(json.data.categorias);
    setItensBuffet(json.data.itens ?? []);
    setInclusos((atual) => {
      const proximo = { ...atual };
      for (const categoria of json.data.categorias as Categoria[]) {
        if (!proximo[categoria.id]) proximo[categoria.id] = { incluso: false, escolhas: '1' };
      }
      return proximo;
    });
  }, []);

  useEffect(() => {
    if (vitrine) return;
    let ativo = true;
    adminFetch('/api/admin/configuracoes/pacotes')
      .then(async (lista) => {
        const json = await ler(lista);
        if (!ativo) return;
        setPacotes(json.data.pacotes);
        setAConfirmar(json.data.precosAConfirmar ?? []);
        setHorarios(json.data.horarios);
        setSaloes(json.data.saloes ?? []);
        setCategorias(json.data.categorias);
        setItensBuffet(json.data.itens ?? []);
        setInclusos((atual) => {
          const proximo = { ...atual };
          for (const categoria of json.data.categorias as Categoria[]) {
            if (!proximo[categoria.id]) proximo[categoria.id] = { incluso: false, escolhas: '1' };
          }
          return proximo;
        });
      })
      .catch((error) => { if (ativo) setErro(error instanceof Error ? error.message : 'Falha ao carregar.'); })
      .finally(() => { if (ativo) setCarregando(false); });
    return () => { ativo = false; };
  }, [vitrine]);

  function limpar() {
    setSelecionado(null);
    setForm(vazio);
    setPares([]);
    setFaixas([{ convidadosMin: '', convidadosMax: '', valor: '' }]);
    setPontos([]);
    setSaloesEscolhidos([]);
    setConversao(null);
    setConfirmando(false);
    setFaixasEditaveis(true);
    setAvisoFaixas('');
    setInclusos((atual) => Object.fromEntries(Object.entries(atual).map(([id, valor]) => [id, { ...valor, incluso: false, escolhas: '1' }])));
    setItensEscolhidos([]);
    setErro('');
  }

  async function editar(id: string) {
    setErro('');
    setAviso('');
    setCarregando(true);
    try {
      const resposta = await adminFetch(`/api/admin/configuracoes/pacotes/${id}`);
      const json = await ler(resposta);
      const painel = json.data as Painel;
      setSelecionado(id);
      setForm({
        nome: painel.pacote.nome,
        descricao: painel.pacote.descricao ?? '',
        ...separarDuracao(painel.pacote.duracaoMinutos),
        minimo: painel.pacote.convidadosMinimos == null ? '' : String(painel.pacote.convidadosMinimos),
        maximo: painel.pacote.convidadosMaximos == null ? '' : String(painel.pacote.convidadosMaximos),
      });
      setPares(painel.disponibilidade);
      setSaloesEscolhidos(painel.saloes ?? []);
      setFaixasEditaveis(painel.faixas.editavel);
      setPontos(pontosDoPainel(painel.faixas.pontos));
      setConversao(painel.faixas.aConfirmar ? { faixas: painel.faixas.faixas, proposta: painel.faixas.proposta ?? [] } : null);
      setConfirmando(false);
      setAvisoFaixas(painel.faixas.aviso ?? '');
      setGradesLeitura(painel.faixas.grades ?? []);
      setFaixas(painel.faixas.faixas.length
        ? painel.faixas.faixas.map((faixa) => ({
          convidadosMin: String(faixa.convidadosMin),
          convidadosMax: faixa.convidadosMax == null ? '' : String(faixa.convidadosMax),
          valor: Number(faixa.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        }))
        : [{ convidadosMin: '', convidadosMax: '', valor: '' }]);
      setInclusos((atual) => {
        const proximo = { ...atual };
        for (const categoria of categorias) {
          const regra = painel.categorias.find((item) => item.categoriaId === categoria.id && item.ativo);
          proximo[categoria.id] = { incluso: Boolean(regra), escolhas: String(regra?.escolhas ?? 1) };
        }
        return proximo;
      });
      setItensEscolhidos(painel.itens ?? []);
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao abrir o pacote.');
    } finally {
      setCarregando(false);
    }
  }

  function precosParaEnvio(confirmados?: PontoPreco[]) {
    if (confirmados) return { faixas: null, pontos: confirmados, conversao: true };
    if (!faixasEditaveis || conversao) return { faixas: null };
    return { faixas: null, pontos: pontosDaTela(pontos) };
  }

  async function salvar(event: FormEvent | null, confirmados?: PontoPreco[]) {
    event?.preventDefault();
    if (pares.some((par) => !par.horarioId)) {
      setErro('Escolha o horário de cada dia marcado.');
      return;
    }
    const erroPontos = !confirmados && faixasEditaveis && !conversao ? erroDosPontos(pontos, Number(form.minimo), Number(form.maximo)) : null;
    if (erroPontos) {
      setErro(erroPontos);
      return;
    }
    setErro('');
    setAviso('');
    setCarregando(true);
    try {
      const resposta = await adminFetch('/api/admin/configuracoes/pacotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          acao: 'salvar',
          ...(selecionado ? { id: selecionado } : {}),
          nome: form.nome,
          descricao: form.descricao.trim() || null,
          duracaoMinutos: juntarDuracao(form.horas, form.minutos),
          convidadosMinimos: Number(form.minimo),
          convidadosMaximos: Number(form.maximo),
          disponibilidade: pares.filter((par) => par.horarioId),
          ...precosParaEnvio(confirmados),
          categorias: categorias.filter((categoria) => inclusos[categoria.id]?.incluso).map((categoria) => ({
            categoriaId: categoria.id,
            escolhas: Number(inclusos[categoria.id]?.escolhas || 1),
          })),
          itens: itensEscolhidos,
          ...(saloes.length > 0 ? { saloes: saloesEscolhidos } : {}),
        }),
      });
      const json = await ler(resposta);
      setAviso(confirmados ? 'Novos preços confirmados.' : selecionado ? 'Alterações salvas.' : 'Pacote salvo.');
      const id = json.data.pacote?.id ?? selecionado;
      setSelecionado(id);
      await carregar();
      if (id && (confirmados || selecionado)) await editar(id);
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao salvar.');
    } finally {
      setCarregando(false);
    }
  }

  async function duplicar(id: string) {
    setErro('');
    setAviso('');
    setCarregando(true);
    try {
      const resposta = await adminFetch('/api/admin/configuracoes/pacotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: 'duplicar', origemId: id }),
      });
      await ler(resposta);
      setAviso('Cópia criada.');
      await carregar();
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao duplicar.');
    } finally {
      setCarregando(false);
    }
  }

  async function situacao(id: string, acao: 'arquivar' | 'ativar' | 'desativar') {
    if (acao === 'arquivar' && !window.confirm('Arquivar este pacote? Ele deixa de valer para festas novas e continua em Arquivados.')) return;
    setCarregando(true);
    setErro('');
    try {
      const resposta = await adminFetch(`/api/admin/configuracoes/pacotes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao }),
      });
      await ler(resposta);
      if (selecionado === id && acao === 'arquivar') limpar();
      setAviso(acao === 'arquivar' ? 'Pacote arquivado.' : 'Pacote atualizado.');
      await carregar();
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao atualizar.');
    } finally {
      setCarregando(false);
    }
  }

  async function excluir(id: string) {
    if (!window.confirm('Excluir definitivamente este pacote?\n\nEsta ação não poderá ser desfeita.')) return;
    setCarregando(true);
    setErro('');
    try {
      const resposta = await adminFetch(`/api/admin/configuracoes/pacotes/${id}`, { method: 'DELETE' });
      await ler(resposta);
      if (selecionado === id) limpar();
      setAviso('Pacote excluído.');
      await carregar();
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao excluir.');
    } finally {
      setCarregando(false);
    }
  }

  function alternarDia(dia: number) {
    setPares((atual) => atual.some((par) => par.dia === dia)
      ? atual.filter((par) => par.dia !== dia)
      : [...atual, { dia, horarioId: '' }]);
  }

  function alternarHorario(dia: number, horarioId: string) {
    setPares((atual) => {
      const semVazio = atual.filter((par) => !(par.dia === dia && par.horarioId === ''));
      const existe = semVazio.some((par) => par.dia === dia && par.horarioId === horarioId);
      return existe
        ? semVazio.filter((par) => !(par.dia === dia && par.horarioId === horarioId))
        : [...semVazio, { dia, horarioId }];
    });
  }

  const visiveis = (pacotes ?? []).filter((pacote) => {
    const nome = pacote.nome.toLocaleLowerCase('pt-BR').includes(busca.toLocaleLowerCase('pt-BR'));
    const estado = filtro === 'todos' || (filtro === 'arquivados' ? Boolean(pacote.arquivadoEm) : pacote.ativo && !pacote.arquivadoEm);
    return nome && estado;
  });
  const atual = pacotes?.find((pacote) => pacote.id === selecionado) ?? null;
  const duracaoPacote = (() => { try { return juntarDuracao(form.horas, form.minutos) ?? 0; } catch { return 0; } })();

  return <main className={styles.page} data-admin-workspace aria-busy={carregando}>
    <header className={styles.header}>
      <h1>Pacotes</h1>
      <div className={styles.actions}>
        <label className={styles.search}><span className={styles.srOnly}>Buscar pacote</span><input type="search" placeholder="Buscar pacote…" value={busca} onChange={(e) => setBusca(e.target.value)} /></label>
        <a className={visual.secundario} href="/admin/configuracoes/importar-documentos?documento=tabela"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8 }}><path d="M12 15V3m0 12-4-4m4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>Importar tabela</a>
        <AdminPrimaryButton onClick={limpar}>Novo pacote</AdminPrimaryButton>
      </div>
    </header>
    <div className={styles.content}>
      {erro && <p role="alert" className={styles.error}>{erro}</p>}
      {aviso && <p role="status" className={styles.notice}>{aviso}</p>}
      {aConfirmar.length > 0 && !confirmando && <p role="status" className={styles.notice} data-aviso-precos-a-confirmar>{aConfirmar.length === 1 ? '1 pacote tem' : `${aConfirmar.length} pacotes têm`} preços a confirmar. Abra o pacote marcado na lista para revisar a conversão para quantidades cheias.</p>}
      <div className={styles.layout}>
        {confirmando && conversao && <div className={styles.principal}>
          <ConfirmarPrecosPacote
            nome={form.nome}
            faixas={conversao.faixas}
            proposta={conversao.proposta}
            minimo={Number(form.minimo)}
            maximo={Number(form.maximo)}
            posicao={aConfirmar.length > 0 ? `Pacote ${Math.max(1, aConfirmar.indexOf(selecionado ?? '') + 1)} de ${aConfirmar.length} com preços a confirmar` : undefined}
            carregando={carregando}
            onVoltar={() => setConfirmando(false)}
            onConfirmar={(confirmados) => void salvar(null, confirmados)}
          />
        </div>}
        <form className={styles.principal} hidden={confirmando && Boolean(conversao)} onSubmit={(event) => void salvar(event)}>
          <section className={styles.card}>
            <h2 className={styles.secaoTitulo}>1. Informações básicas</h2>
            <label htmlFor="pacote-nome">Nome do pacote *<input id="pacote-nome" value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} maxLength={160} required /></label>
            <label htmlFor="pacote-descricao">Descrição<textarea id="pacote-descricao" value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} maxLength={2000} rows={3} /></label>
            <div className={styles.grid}>
              <div><span className={styles.rotulo}>Convidados mínimos *<AjudaCampo texto="Menor quantidade de convidados que pode contratar este pacote." /></span><label htmlFor="pacote-min"><span className={styles.srOnly}>Convidados mínimos</span><input id="pacote-min" type="number" min={1} required value={form.minimo} onChange={(e) => setForm({ ...form, minimo: e.target.value })} /></label></div>
              <div><span className={styles.rotulo}>Convidados máximos *<AjudaCampo texto="Maior quantidade atendida por este pacote." /></span><label htmlFor="pacote-max"><span className={styles.srOnly}>Convidados máximos</span><input id="pacote-max" type="number" min={1} required value={form.maximo} onChange={(e) => setForm({ ...form, maximo: e.target.value })} /></label></div>
            </div>
            <DurationField horas={form.horas} minutos={form.minutos} ajuda="Tempo total reservado para a festa." onChange={(value) => setForm({ ...form, ...value })} />
          </section>
          <section className={styles.card}>
            <h2>2. Disponibilidade</h2>
            <p className={styles.intro}>Dias permitidos</p>
            <div className={styles.dias} role="group" aria-label="Dias permitidos">
              {DIAS.map(([valor, rotulo]) => <button key={valor} type="button" aria-pressed={pares.some((par) => par.dia === valor)} onClick={() => alternarDia(valor)}>{rotulo}</button>)}
            </div>
            {DIAS.filter(([valor]) => pares.some((par) => par.dia === valor)).map(([valor, rotulo]) => <div key={valor}>
              <p className={styles.intro}>Horários de {rotulo}</p>
              <div className={styles.dias} role="group" aria-label={`Horários de ${rotulo}`}>
                {horarios.filter((horario) => !horario.dias || horario.dias.includes(valor)).map((horario) => {
                  const marcado = pares.some((par) => par.dia === valor && par.horarioId === horario.id);
                  const naoCabe = duracaoPacote > 0 && minutosDoHorario(horario) < duracaoPacote;
                  return <button key={horario.id} type="button" aria-pressed={marcado} disabled={naoCabe && !marcado} title={naoCabe ? 'O horário é mais curto que a duração do pacote.' : undefined} onClick={() => alternarHorario(valor, horario.id)}>{horario.nome} · {horaCurta(horario.inicio)}–{horaCurta(horario.fim)}{naoCabe ? ' · não cabe' : ''}</button>;
                })}
              </div>
            </div>)}
            {saloes.length > 0 && <>
              <p className={styles.intro}>Salões permitidos <span className={styles.muted}>· nenhum marcado = todos</span></p>
              <div className={styles.dias} role="group" aria-label="Salões permitidos">
                {saloes.map((salao) => <button key={salao.id} type="button" aria-pressed={saloesEscolhidos.includes(salao.id)} onClick={() => setSaloesEscolhidos((atual) => atual.includes(salao.id) ? atual.filter((id) => id !== salao.id) : [...atual, salao.id])}>{salao.nome}{salao.combinado && salao.membros?.length ? ` = ${salao.membros.join(' + ')}` : ''}{salao.unidade ? ` (${salao.unidade})` : ''}</button>)}
              </div>
              {saloes.some((s) => s.combinado) && <p className={styles.muted} data-aviso-combinado>{AVISO_COMBINADO}</p>}
            </>}
          </section>
          <section className={styles.card}>
            <h2>3. Preços</h2>
            {(!faixasEditaveis || conversao) && <p className={styles.intro}>Defina quanto custa este pacote para cada quantidade de convidados.</p>}
            {avisoFaixas && <p>{avisoFaixas}</p>}
            {!faixasEditaveis && gradesLeitura.length > 0 && <div className={styles.grid}>
              {gradesLeitura.map((g) => <div key={g.categoria}>
                <h3>{NOME_GRADE[g.categoria] ?? g.categoria}</h3>
                <table><tbody>{g.faixas.map((f) => <tr key={f.convidadosMin}><td>{g.porConvidado ? `por convidado (mín. ${f.convidadosMin})` : `${textoFaixa(f.convidadosMin, f.convidadosMax)} convidados`}</td><td>{reais(f.valor)}</td></tr>)}</tbody></table>
              </div>)}
              <p>Para mudar estes preços, importe a tabela de novo em <a href="/admin/configuracoes/importar-documentos?documento=tabela">Importar documentos</a>.</p>
            </div>}
            {faixasEditaveis && conversao && <div className={styles.notice} data-precos-a-confirmar>
              <div>
                <h2>Preços a confirmar</h2>
                <p>Este pacote ainda cobra pelas faixas antigas ({faixas.map((f) => f.convidadosMax.trim() ? `${f.convidadosMin} a ${f.convidadosMax}` : `a partir de ${f.convidadosMin}`).join(', ')}). Agora o preço é informado só nas quantidades cheias. Revise a proposta e confirme; até lá nada muda.</p>
              </div>
              <AdminPrimaryButton type="button" onClick={() => setConfirmando(true)}>Revisar e confirmar</AdminPrimaryButton>
            </div>}
            {faixasEditaveis && !conversao && <PrecosPorQuantidade pontos={pontos} onChange={setPontos} minimo={Number(form.minimo)} maximo={Number(form.maximo)} />}
          </section>
          <section className={styles.card}>
            <div className={styles.actions}>
              <h2>4. O que está incluído</h2>
              <button type="button" onClick={() => { setBuscaIncluir(''); setAbaIncluir('categorias'); setIncluirAberto(true); }}>+ Adicionar</button>
            </div>
            <p className={styles.intro}>Categorias</p>
            <div className={styles.filters}>
              {categorias.filter((categoria) => inclusos[categoria.id]?.incluso).map((categoria) => <button key={categoria.id} type="button" onClick={() => setInclusos({ ...inclusos, [categoria.id]: { ...inclusos[categoria.id], incluso: false } })}>{categoria.nome} ×</button>)}
            </div>
            <p className={styles.intro}>Itens específicos</p>
            <div className={styles.filters}>
              {itensBuffet.filter((item) => itensEscolhidos.includes(item.id)).map((item) => <button key={item.id} type="button" onClick={() => setItensEscolhidos(itensEscolhidos.filter((id) => id !== item.id))}>{item.nome} ×</button>)}
            </div>
            {incluirAberto && <div className={overlay.overlay} role="dialog" aria-label="Adicionar ao pacote">
              <div className={overlay.painel}>
              <div className={styles.filters} role="tablist">
                <button type="button" aria-pressed={abaIncluir === 'categorias'} onClick={() => setAbaIncluir('categorias')}>Categorias</button>
                <button type="button" aria-pressed={abaIncluir === 'itens'} onClick={() => setAbaIncluir('itens')}>Itens</button>
              </div>
              <label>Busca<input type="search" value={buscaIncluir} onChange={(evento) => setBuscaIncluir(evento.target.value)} /></label>
              {abaIncluir === 'categorias' && categorias.filter((categoria) => categoria.nome.toLocaleLowerCase('pt-BR').includes(buscaIncluir.trim().toLocaleLowerCase('pt-BR'))).map((categoria) => {
                const marcado = Boolean(inclusos[categoria.id]?.incluso);
                return <label key={categoria.id}><input type="checkbox" checked={marcado} onChange={() => setInclusos({ ...inclusos, [categoria.id]: { incluso: !marcado, escolhas: inclusos[categoria.id]?.escolhas || '1' } })} /> {categoria.nome}</label>;
              })}
              {abaIncluir === 'itens' && itensBuffet.filter((item) => item.nome.toLocaleLowerCase('pt-BR').includes(buscaIncluir.trim().toLocaleLowerCase('pt-BR'))).map((item) => <label key={item.id}><input type="checkbox" checked={itensEscolhidos.includes(item.id)} onChange={() => setItensEscolhidos(itensEscolhidos.includes(item.id) ? itensEscolhidos.filter((id) => id !== item.id) : [...itensEscolhidos, item.id])} /> {item.nome}</label>)}
              <button type="button" onClick={() => setIncluirAberto(false)}>Concluir</button>
              </div>
            </div>}
          </section>
          <div className={styles.actions}>
            {erro && <p className={styles.error} data-erro-junto-do-salvar>{erro}</p>}
            <AdminPrimaryButton type="submit" disabled={carregando}>{atual ? 'Salvar alterações' : 'Salvar pacote'}</AdminPrimaryButton>
          </div>
        </form>
        <aside className={styles.lateral} aria-label="Pacotes já criados">
          <div className={styles.filters}>
            {(['todos', 'ativos', 'arquivados'] as const).map((item) => <button key={item} type="button" aria-pressed={filtro === item} onClick={() => setFiltro(item)}>{item === 'todos' ? 'Todos' : item === 'ativos' ? 'Ativos' : 'Arquivados'}</button>)}
          </div>
          <h2>Pacotes já criados</h2>
          {carregando && pacotes === null && <p role="status">Carregando pacotes…</p>}
          {pacotes && !visiveis.length && <p className={styles.muted}>Nenhum pacote nesta lista.</p>}
          {visiveis.map((pacote) => <article className={`${styles.card} ${styles.pacoteCard}`} key={pacote.id}>
            <h3>{pacote.nome}</h3>
            <span className={styles.badge} data-active={pacote.ativo && !pacote.arquivadoEm}>{pacote.arquivadoEm ? 'Arquivado' : pacote.ativo ? 'Ativo' : 'Inativo'}</span>
            {aConfirmar.includes(pacote.id) && <span className={styles.badge} data-precos-a-confirmar style={{ marginLeft: 6, color: '#fdba74', background: 'rgba(249,115,22,.12)' }}>Preços a confirmar</span>}
            <p>{faixaConvidados(pacote.convidadosMinimos, pacote.convidadosMaximos)}</p>
            <p>{formatarDuracao(pacote.duracaoMinutos)}</p>
            <p>{diasTexto(pacote.diasPermitidos)}</p>
            <div className={styles.rowActions}>
              {!pacote.arquivadoEm && <button type="button" onClick={() => void editar(pacote.id)}>Editar</button>}
              <button type="button" onClick={() => void duplicar(pacote.id)}>Duplicar</button>
              <details className={styles.menu}>
                <summary aria-label={`Mais ações de ${pacote.nome}`}>...</summary>
                <div>
                  {!pacote.arquivadoEm && <button type="button" onClick={() => void situacao(pacote.id, 'arquivar')}>Arquivar</button>}
                  {!pacote.arquivadoEm && <button type="button" onClick={() => void situacao(pacote.id, pacote.ativo ? 'desativar' : 'ativar')}>{pacote.ativo ? 'Desativar' : 'Ativar'}</button>}
                  {pacote.arquivadoEm && <button className={styles.danger} type="button" onClick={() => void excluir(pacote.id)}>Excluir definitivamente</button>}
                </div>
              </details>
            </div>
          </article>)}
        </aside>
      </div>
    </div>
  </main>;
}
