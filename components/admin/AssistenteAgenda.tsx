'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AgendaEscopo, CapacidadeTipo, EscopoConfiguravel, HorarioAgenda, Modo } from '@/lib/agenda/configuracao-unidade';
import { adminFetch } from '@/lib/http/admin-fetch';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import css from './agenda-configuracao.module.css';
import ws from './workspace.module.css';

/** Formulário da agenda (tela e assistente): texto como digitado; o servidor valida de novo (salvarAgendaEscopo). */
export type SalaoForm = { chave: string; id?: string; nome: string; capacidade: string };
export type HorarioForm = { chave: string; id?: string; nome: string; inicio: string; fim: string; dias: number[]; capacidade: string; saloes: string[]; original?: HorarioAgenda };
/** combinados: nomes dos salões combinados ativos (098), escolhíveis nos horários; não são editados neste formulário. */
export type AgendaForm = { modo: Modo; capacidadeTipo: CapacidadeTipo; limite: string; intervalo: string; saloes: SalaoForm[]; horarios: HorarioForm[]; combinados?: string[] };

export const DIAS = [
  { n: 1, letra: 'S', nome: 'Seg' }, { n: 2, letra: 'T', nome: 'Ter' }, { n: 3, letra: 'Q', nome: 'Qua' }, { n: 4, letra: 'Q', nome: 'Qui' },
  { n: 5, letra: 'S', nome: 'Sex' }, { n: 6, letra: 'S', nome: 'Sáb' }, { n: 7, letra: 'D', nome: 'Dom' },
];
const NOMES_DIA = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
export const INTERVALOS = [0, 30, 60, 90, 120];
const HORA = /^\d{2}:\d{2}$/;
const minutos = (hora: string) => Number(hora.slice(0, 2)) * 60 + Number(hora.slice(3, 5));
const inteiro = (texto: string) => Number(texto.trim());
export const novaChave = () => `novo-${crypto.randomUUID()}`;

export async function ler(response: Response) {
  const body = await response.json();
  if (!response.ok || body.ok === false) throw new Error(body.erro || 'Não foi possível concluir a operação.');
  return body;
}

export function formDaAgenda(agenda: AgendaEscopo): AgendaForm {
  const c = agenda.config;
  const nomeDoSalao = new Map([...agenda.saloes, ...(agenda.combinados ?? [])].map((s) => [s.id, s.nome]));
  return {
    modo: c?.modo ?? 'FIXO',
    capacidadeTipo: c?.capacidadeTipo ?? (agenda.saloes.length > 1 ? 'POR_SALAO' : 'POR_HORARIO'),
    limite: c?.limiteFestasDia == null ? '' : String(c.limiteFestasDia),
    intervalo: String(c?.intervaloMinimoMinutos ?? 60),
    saloes: agenda.saloes.map((s) => ({ chave: s.id, id: s.id, nome: s.nome, capacidade: s.capacidadeConvidados == null ? '' : String(s.capacidadeConvidados) })),
    horarios: agenda.horarios.map((h) => ({
      chave: h.id, id: h.id, nome: h.nome, inicio: h.inicio.slice(0, 5), fim: h.fim.slice(0, 5), dias: [...h.dias].sort((a, b) => a - b),
      capacidade: String(h.capacidade), saloes: h.saloes.map((id) => nomeDoSalao.get(id) ?? id), original: h,
    })),
    combinados: (agenda.combinados ?? []).map((c) => c.nome),
  };
}

/** Salões escolhíveis nos horários: os simples do formulário e os combinados ativos (098; A e B não liberam AB). */
export const nomesDosSaloes = (form: AgendaForm) => [...form.saloes.map((s) => s.nome.trim()).filter(Boolean), ...(form.combinados ?? [])];

/** Renomear um salão leva junto a escolha dos horários (eles guardam o nome até salvar). */
export function renomearSalao(form: AgendaForm, indice: number, nome: string): AgendaForm {
  const antigo = form.saloes[indice]?.nome.trim();
  return {
    ...form,
    saloes: form.saloes.map((s, i) => i === indice ? { ...s, nome } : s),
    horarios: antigo ? form.horarios.map((h) => ({ ...h, saloes: h.saloes.map((n) => n === antigo ? nome.trim() : n) })) : form.horarios,
  };
}

export function erroDosSaloes(form: AgendaForm): string | null {
  if (form.capacidadeTipo !== 'POR_SALAO') return null;
  if (form.saloes.length === 0) return 'Cadastre pelo menos um salão.';
  if (form.saloes.some((s) => !s.nome.trim())) return 'Dê um nome a cada salão.';
  const nomes = form.saloes.map((s) => s.nome.trim().toLocaleLowerCase('pt-BR'));
  if (new Set(nomes).size !== nomes.length) return 'Dê um nome diferente a cada salão.';
  if (form.saloes.some((s) => s.capacidade.trim() && (!Number.isInteger(inteiro(s.capacidade)) || inteiro(s.capacidade) < 1))) return 'A capacidade de convidados precisa ser um número inteiro.';
  return null;
}

export function erroDosHorarios(form: AgendaForm): string | null {
  if (form.modo !== 'FIXO') return null;
  if (form.horarios.length === 0) return 'Cadastre pelo menos um horário.';
  for (const h of form.horarios) {
    const nome = h.nome.trim() || 'sem nome';
    if (!h.nome.trim()) return 'Dê um nome a cada horário.';
    if (!HORA.test(h.inicio) || !HORA.test(h.fim)) return `Informe o início e o fim do horário ${nome}.`;
    if (minutos(h.fim) <= minutos(h.inicio)) return `O fim do horário ${nome} precisa ser depois do início.`;
    if (h.dias.length === 0) return `Escolha os dias do horário ${nome}.`;
    if (form.capacidadeTipo === 'POR_SALAO') {
      const existentes = new Set(nomesDosSaloes(form));
      if (!h.saloes.some((s) => existentes.has(s))) return `Escolha os salões do horário ${nome}.`;
    } else {
      const n = inteiro(h.capacidade);
      if (!Number.isInteger(n) || n < 1 || n > 20) return `Informe de 1 a 20 festas ao mesmo tempo no horário ${nome}.`;
    }
  }
  return null;
}

export function erroDoLimite(form: AgendaForm): string | null {
  if (!form.limite.trim()) return null;
  const n = inteiro(form.limite);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? null : 'Informe um limite de festas por dia entre 1 e 50, ou deixe em branco.';
}

export const erroDoForm = (form: AgendaForm) => erroDosSaloes(form) ?? erroDosHorarios(form) ?? erroDoLimite(form);

export function corpoSalvar(form: AgendaForm, estabelecimentoId: string | null, origem: 'ASSISTENTE' | 'CONFIGURACOES') {
  const saloes = form.saloes.filter((s) => s.nome.trim());
  const existentes = new Set([...saloes.map((s) => s.nome.trim()), ...(form.combinados ?? [])]);
  return {
    acao: 'salvar',
    origem,
    estabelecimentoId,
    modo: form.modo,
    capacidadeTipo: form.capacidadeTipo,
    limiteFestasDia: form.limite.trim() ? inteiro(form.limite) : null,
    intervaloMinimoMinutos: Number(form.intervalo) || 0,
    saloes: saloes.map((s) => ({ ...(s.id ? { id: s.id } : {}), nome: s.nome.trim(), capacidadeConvidados: s.capacidade.trim() ? inteiro(s.capacidade) : null })),
    horarios: form.modo === 'LIVRE' ? [] : form.horarios.map((h) => {
      const doHorario = form.capacidadeTipo === 'POR_SALAO' ? h.saloes.filter((s) => existentes.has(s)) : [];
      return {
        ...(h.id ? { id: h.id } : {}),
        nome: h.nome.trim(),
        inicio: h.inicio,
        fim: h.fim,
        dias: [...h.dias].sort((a, b) => a - b),
        capacidade: form.capacidadeTipo === 'POR_SALAO' ? Math.min(20, Math.max(1, doHorario.length)) : inteiro(h.capacidade),
        saloes: doHorario,
      };
    }),
  };
}

/**
 * Retrato do que está DIGITADO no formulário (texto como está, linhas incompletas incluídas): nada é convertido nem
 * filtrado, para que "abc" numa capacidade ou um salão sem nome contem como alteração (rodada 2 do Astra, P2-2).
 */
function retratoDoForm(f: AgendaForm) {
  return JSON.stringify({
    modo: f.modo, capacidadeTipo: f.capacidadeTipo, limite: f.limite, intervalo: f.intervalo,
    saloes: f.saloes.map((s) => [s.id ?? null, s.nome, s.capacidade]),
    horarios: f.horarios.map((h) => [h.id ?? null, h.nome, h.inicio, h.fim, [...h.dias].sort((a, b) => a - b), h.capacidade, [...h.saloes].sort()]),
  });
}

/**
 * Há alteração não salva quando o texto do formulário difere do formulário montado da agenda salva (qualquer campo,
 * inclusive valor inválido ou linha incompleta). Usado para não descartar edições ao criar/desativar um combinado.
 */
export function formAlterado(form: AgendaForm, agenda: AgendaEscopo) {
  return retratoDoForm(form) !== retratoDoForm(formDaAgenda(agenda));
}

export function textoDias(dias: number[]) {
  if (dias.length === 7) return 'todos os dias';
  return [...dias].sort((a, b) => a - b).map((d) => DIAS[d - 1]?.nome ?? d).join(', ');
}

export function DiasChips({ dias, onChange, disabled, rotulo }: { dias: number[]; onChange: (dias: number[]) => void; disabled?: boolean; rotulo: string }) {
  return <div className={`${ws.dias} ${css.chips}`} role="group" aria-label={`Dias do horário ${rotulo}`}>
    {DIAS.map((d) => <button key={d.n} type="button" aria-pressed={dias.includes(d.n)} aria-label={NOMES_DIA[d.n - 1]} title={NOMES_DIA[d.n - 1]} disabled={disabled}
      onClick={() => onChange(dias.includes(d.n) ? dias.filter((x) => x !== d.n) : [...dias, d.n].sort((a, b) => a - b))}>{d.letra}</button>)}
  </div>;
}

export function SalaoChips({ saloes, escolhidos, onChange, disabled, rotulo }: { saloes: string[]; escolhidos: string[]; onChange: (saloes: string[]) => void; disabled?: boolean; rotulo: string }) {
  if (saloes.length === 0) return <span className={css.fraco}>Cadastre os salões acima.</span>;
  return <div className={`${ws.dias} ${css.chips}`} role="group" aria-label={`Salões do horário ${rotulo}`}>
    {saloes.map((nome) => <button key={nome} type="button" aria-pressed={escolhidos.includes(nome)} disabled={disabled}
      onClick={() => onChange(escolhidos.includes(nome) ? escolhidos.filter((x) => x !== nome) : [...escolhidos, nome])}>{nome}</button>)}
  </div>;
}

export function EditorSaloes({ form, onChange, disabled }: { form: AgendaForm; onChange: (form: AgendaForm) => void; disabled?: boolean }) {
  return <>
    {form.saloes.length > 0 && <div className={css.lista} role="table" aria-label="Salões">
      <div className={`${css.linhaSalao} ${css.cabecalho}`} role="row"><span role="columnheader">Salão</span><span role="columnheader">Capacidade de convidados</span><span /></div>
      {form.saloes.map((s, i) => <div key={s.chave} className={css.linhaSalao} role="row">
        <label><span className={ws.srOnly}>Nome do salão</span><input value={s.nome} maxLength={80} disabled={disabled} onChange={(e) => onChange(renomearSalao(form, i, e.target.value))} /></label>
        <label><span className={ws.srOnly}>Capacidade de convidados de {s.nome || 'este salão'}</span><input inputMode="numeric" placeholder="Opcional" value={s.capacidade} disabled={disabled}
          onChange={(e) => onChange({ ...form, saloes: form.saloes.map((x, j) => j === i ? { ...x, capacidade: e.target.value } : x) })} /></label>
        {!disabled && <button type="button" className={css.remover} aria-label={`Remover o salão ${s.nome}`} onClick={() => onChange({
          ...form,
          saloes: form.saloes.filter((_, j) => j !== i),
          horarios: form.horarios.map((h) => ({ ...h, saloes: h.saloes.filter((n) => n !== s.nome.trim()) })),
        })}>×</button>}
      </div>)}
    </div>}
    {!disabled && <div className={css.acoes}>
      <button type="button" onClick={() => onChange({ ...form, saloes: [...form.saloes, { chave: novaChave(), nome: `Salão ${form.saloes.length + 1}`, capacidade: '' }] })}>+ Adicionar salão</button>
    </div>}
  </>;
}

export const horarioNovo = (form: AgendaForm): HorarioForm => ({
  chave: novaChave(), nome: '', inicio: '', fim: '', dias: [1, 2, 3, 4, 5, 6, 7], capacidade: '1',
  saloes: form.capacidadeTipo === 'POR_SALAO' ? nomesDosSaloes(form) : [],
});

const TOTAL = 6;

/** No horário livre o passo 4 (horários fixos) não existe: a numeração mostrada pula só ele (5 passos, sem salto). */
export function numeracaoAssistente(passo: number, modo: string) {
  const livre = modo === 'LIVRE';
  return { passoVisivel: livre && passo > 4 ? passo - 1 : passo, totalVisivel: livre ? TOTAL - 1 : TOTAL };
}

/**
 * Assistente da primeira entrada (decisão de Felipe em 22/10/2026): cinco perguntas por unidade. Os horários herdados
 * vão com o id para o servidor copiar as regras de preço; qualquer usuário da unidade pode concluir.
 */
export function AssistenteAgenda({ escopo, agenda, onConcluido, onDepois }: {
  escopo: EscopoConfiguravel;
  agenda: AgendaEscopo;
  onConcluido: () => void;
  onDepois: () => void;
}) {
  const [form, setForm] = useState<AgendaForm>(() => formDaAgenda(agenda));
  const [passo, setPasso] = useState(1);
  const [limiteTocado, setLimiteTocado] = useState(false);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const titulo = useId();
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const nome = escopo.nome;

  useEffect(() => { tituloRef.current?.focus(); }, [passo]);

  function limitePadrao(atual: AgendaForm) {
    const horarios = atual.modo === 'FIXO' ? atual.horarios.length : 1;
    const saloes = atual.capacidadeTipo === 'POR_SALAO' ? atual.saloes.length : 1;
    return String(Math.min(50, Math.max(1, horarios) * Math.max(1, saloes)));
  }

  function escolherSaloes(tipo: CapacidadeTipo) {
    setErro('');
    if (tipo === 'POR_SALAO' && form.saloes.length === 0) {
      setForm({ ...form, capacidadeTipo: tipo, saloes: [{ chave: 'novo-1', nome: 'Salão 1', capacidade: '' }, { chave: 'novo-2', nome: 'Salão 2', capacidade: '' }] });
    } else setForm({ ...form, capacidadeTipo: tipo });
  }

  function avancar() {
    const erroPasso = passo === 2 ? erroDosSaloes(form) : passo === 4 ? erroDosHorarios(form) : passo === 5 ? erroDoLimite(form) : null;
    if (erroPasso) { setErro(erroPasso); return; }
    setErro('');
    let proximo = { ...form };
    if (passo === 2 && form.capacidadeTipo === 'POR_SALAO') {
      // Cada horário usa todos os salões por padrão; nomes que sumiram saem da escolha.
      const todos = nomesDosSaloes(form);
      proximo = { ...proximo, horarios: proximo.horarios.map((h) => {
        const mantidos = h.saloes.filter((s) => todos.includes(s));
        return { ...h, saloes: mantidos.length ? mantidos : todos };
      }) };
    }
    const seguinte = passo === 3 && form.modo === 'LIVRE' ? 5 : passo + 1;
    if (seguinte === 5 && !limiteTocado) proximo = { ...proximo, limite: limitePadrao(proximo) };
    setForm(proximo);
    setPasso(seguinte);
  }

  function voltar() {
    setErro('');
    setPasso(passo === 5 && form.modo === 'LIVRE' ? 3 : passo - 1);
  }

  async function concluir() {
    const erroFinal = erroDoForm(form);
    if (erroFinal) { setErro(erroFinal); return; }
    setErro('');
    setSalvando(true);
    try {
      const corpo = corpoSalvar(form.capacidadeTipo === 'POR_SALAO' ? form : { ...form, saloes: [] }, escopo.estabelecimentoId, 'ASSISTENTE');
      await ler(await adminFetch('/api/admin/configuracoes/agenda', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }));
      onConcluido();
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Não foi possível salvar a agenda.');
    } finally {
      setSalvando(false);
    }
  }

  function alterarHorario(indice: number, mudanca: Partial<HorarioForm>) {
    setForm({ ...form, horarios: form.horarios.map((h, i) => i === indice ? { ...h, ...mudanca } : h) });
  }

  const saloes = nomesDosSaloes(form);
  const intervalos = INTERVALOS.includes(Number(form.intervalo)) ? INTERVALOS : [...INTERVALOS, Number(form.intervalo)].sort((a, b) => a - b);

  let corpo: ReactNode;
  if (passo === 1) {
    corpo = <>
      <h2 id={titulo} ref={tituloRef} tabIndex={-1}>Vamos configurar a agenda da unidade {nome}</h2>
      <p>São 5 perguntas rápidas. Com elas, a agenda, os orçamentos, o site e o Wall-e passam a oferecer só os horários que a {nome} realmente tem.</p>
      <p className={css.fraco}>Leva cerca de 2 minutos. Dá para mudar depois em Configurações › Agenda.</p>
    </>;
  } else if (passo === 2) {
    corpo = <>
      <h2 id={titulo} ref={tituloRef} tabIndex={-1}>A {nome} tem mais de um salão?</h2>
      <div className={css.opcoes}>
        <button type="button" className={css.opcao} aria-pressed={form.capacidadeTipo === 'POR_HORARIO'} onClick={() => escolherSaloes('POR_HORARIO')}><strong>Não, um espaço só</strong></button>
        <button type="button" className={css.opcao} aria-pressed={form.capacidadeTipo === 'POR_SALAO'} onClick={() => escolherSaloes('POR_SALAO')}><strong>Sim, mais de um salão</strong></button>
      </div>
      {form.capacidadeTipo === 'POR_SALAO' && <EditorSaloes form={form} onChange={setForm} />}
    </>;
  } else if (passo === 3) {
    corpo = <>
      <h2 id={titulo} ref={tituloRef} tabIndex={-1}>Como a {nome} marca o horário das festas?</h2>
      <div className={css.opcoes}>
        <button type="button" className={css.opcao} aria-pressed={form.modo === 'FIXO'} onClick={() => setForm({ ...form, modo: 'FIXO' })}><strong>Horários fixos</strong><span>Ex.: almoço 11h–15h e noite 17h–21h</span></button>
        <button type="button" className={css.opcao} aria-pressed={form.modo === 'LIVRE'} onClick={() => setForm({ ...form, modo: 'LIVRE' })}><strong>Horário livre</strong><span>O cliente escolhe a hora de início</span></button>
      </div>
    </>;
  } else if (passo === 4) {
    corpo = <>
      <h2 id={titulo} ref={tituloRef} tabIndex={-1}>Quais são os horários?</h2>
      <p className={css.fraco}>Já preenchemos com os horários que o sistema usava. Ajuste o que for diferente.</p>
      {form.horarios.length > 0 && <div className={css.lista} role="table" aria-label="Horários de festa">
        {form.horarios.map((h, i) => <div key={h.chave} className={css.cartaoHorario} role="row">
          <label className={css.campoRotulado}><span>Nome do horário</span><input placeholder="Ex.: Almoço" value={h.nome} maxLength={80} aria-invalid={!h.nome.trim() || undefined} onChange={(e) => alterarHorario(i, { nome: e.target.value })} /></label>
          <label className={css.campoRotulado}><span>Início</span><input type="time" aria-label={`Início de ${h.nome || 'este horário'}`} value={h.inicio} onChange={(e) => alterarHorario(i, { inicio: e.target.value })} /></label>
          <label className={css.campoRotulado}><span>Fim</span><input type="time" aria-label={`Fim de ${h.nome || 'este horário'}`} value={h.fim} onChange={(e) => alterarHorario(i, { fim: e.target.value })} /></label>
          <div className={css.linhaRotulada}><span aria-hidden="true">Dias</span><DiasChips dias={h.dias} rotulo={h.nome} onChange={(dias) => alterarHorario(i, { dias })} /></div>
          {form.capacidadeTipo === 'POR_SALAO'
            ? <div className={css.linhaRotulada}><span aria-hidden="true">Salões</span><SalaoChips saloes={saloes} escolhidos={h.saloes} rotulo={h.nome} onChange={(escolhidos) => alterarHorario(i, { saloes: escolhidos })} /></div>
            : <label className={css.linhaRotulada}><span>Festas ao mesmo tempo</span><input inputMode="numeric" aria-label={`Festas ao mesmo tempo em ${h.nome || 'este horário'}`} value={h.capacidade} onChange={(e) => alterarHorario(i, { capacidade: e.target.value })} /></label>}
          <button type="button" className={css.remover} aria-label={`Remover o horário ${h.nome}`} onClick={() => setForm({ ...form, horarios: form.horarios.filter((_, j) => j !== i) })}>×</button>
        </div>)}
      </div>}
      <div className={css.acoes}><button type="button" onClick={() => setForm({ ...form, horarios: [...form.horarios, horarioNovo(form)] })}>+ Adicionar horário</button></div>
    </>;
  } else if (passo === 5) {
    corpo = <>
      <h2 id={titulo} ref={tituloRef} tabIndex={-1}>Quantas festas a {nome} faz por dia?</h2>
      <div className={css.campos}>
        <label>Limite de festas por dia
          <input inputMode="numeric" placeholder="Sem limite" value={form.limite} onChange={(e) => { setLimiteTocado(true); setForm({ ...form, limite: e.target.value }); }} />
        </label>
        <label>Intervalo entre festas
          <select value={form.intervalo} onChange={(e) => setForm({ ...form, intervalo: e.target.value })}>
            {intervalos.map((m) => <option key={m} value={String(m)}>{m} min</option>)}
          </select>
        </label>
      </div>
      <p className={css.fraco}>O intervalo é o tempo de limpeza e montagem entre duas festas no mesmo salão.</p>
    </>;
  } else {
    const limite = form.limite.trim() ? `Até ${form.limite} festas` : 'Sem limite de festas';
    corpo = <>
      <h2 id={titulo} ref={tituloRef} tabIndex={-1}>Confira a agenda da {nome}</h2>
      <ul className={css.resumo}>
        <li><span>Salões</span>{form.capacidadeTipo === 'POR_SALAO' ? form.saloes.map((s) => s.capacidade.trim() ? `${s.nome.trim()} (${s.capacidade} convidados)` : s.nome.trim()).join(', ') : 'Um espaço só'}</li>
        <li><span>Modo</span>{form.modo === 'FIXO' ? 'Horários fixos' : 'Horário livre: o cliente escolhe a hora de início'}</li>
        {form.modo === 'FIXO' && <li><span>Horários</span>{form.horarios.map((h) => `${h.nome.trim()} ${h.inicio}–${h.fim} (${textoDias(h.dias)})`).join('; ')}</li>}
        <li><span>Por dia</span>{limite}, com {form.intervalo} min entre festas</li>
      </ul>
      <p className={css.fraco}>Próximo passo sugerido: dizer em quais horários e salões cada pacote pode ser feito.</p>
    </>;
  }

  const { passoVisivel, totalVisivel } = numeracaoAssistente(passo, form.modo);

  return <div className={`${ws.page} ${css.overlay}`} data-admin-workspace data-assistente-agenda>
    <div className={css.painel} role="dialog" aria-modal="true" aria-labelledby={titulo}>
      <div className={css.progresso} aria-hidden="true">{Array.from({ length: totalVisivel }, (_, i) => <span key={i} data-feito={i < passoVisivel} />)}</div>
      <p className={css.passo}>PASSO {passoVisivel} DE {totalVisivel}</p>
      {corpo}
      {erro && <p className={css.erroLinha} role="alert">{erro}</p>}
      <div className={css.painelRodape}>
        <button type="button" className={ws.textButton} onClick={onDepois} disabled={salvando}>Fazer depois</button>
        {passo > 1 && <button type="button" onClick={voltar} disabled={salvando}>Voltar</button>}
        {passo < TOTAL
          ? <AdminPrimaryButton onClick={avancar}>{passo === 1 ? 'Começar' : 'Continuar'}</AdminPrimaryButton>
          : <AdminPrimaryButton onClick={concluir} carregando={salvando}>Concluir</AdminPrimaryButton>}
      </div>
    </div>
  </div>;
}

const CHAVE_DEPOIS = 'kidmais-agenda-assistente-depois';

/** Abre o assistente na primeira entrada enquanto houver unidade sem agenda configurada. Falhas não mostram nada. */
export function AssistenteAgendaPendente() {
  const [alvo, setAlvo] = useState<{ escopo: EscopoConfiguravel; agenda: AgendaEscopo } | null>(null);

  useEffect(() => {
    let ativo = true;
    let adiado = false;
    try { adiado = Boolean(window.sessionStorage.getItem(CHAVE_DEPOIS)); } catch { adiado = false; }
    if (adiado) return;
    adminFetch('/api/admin/configuracoes/agenda?pendentes=1')
      .then(async (resposta) => {
        const json = await ler(resposta);
        const pendente = (json.data?.instalada ? json.data.pendentes?.[0] : null) as EscopoConfiguravel | null | undefined;
        if (!pendente || !ativo) return;
        const agenda = await ler(await adminFetch(`/api/admin/configuracoes/agenda?unidadeId=${encodeURIComponent(pendente.estabelecimentoId ?? '')}`));
        if (ativo && agenda.data?.agenda) setAlvo({ escopo: pendente, agenda: agenda.data.agenda as AgendaEscopo });
      })
      .catch(() => { /* sem assistente quando a leitura falha */ });
    return () => { ativo = false; };
  }, []);

  if (!alvo) return null;
  return <AssistenteAgenda
    escopo={alvo.escopo}
    agenda={alvo.agenda}
    onDepois={() => {
      try { window.sessionStorage.setItem(CHAVE_DEPOIS, '1'); } catch { /* sem armazenamento: só esconde */ }
      setAlvo(null);
    }}
    onConcluido={() => {
      setAlvo(null);
      window.dispatchEvent(new Event('kidmais:agenda-configurada'));
    }}
  />;
}
