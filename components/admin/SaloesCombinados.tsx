'use client';

import { useState } from 'react';
import type { AgendaEscopo } from '@/lib/agenda/configuracao-unidade';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import css from './agenda-configuracao.module.css';
import ws from './workspace.module.css';

/**
 * 098 (fase 1 dos salões): salão combinado ("salão inteiro" = A+B). Cria escolhendo os salões; a composição não muda
 * depois (para mudar, cria-se outro e desativa-se o antigo). Desativar é recusado com festa de hoje em diante (D5): a
 * mensagem do servidor lista as festas. Nos pacotes e horários, A e B liberados não liberam o combinado.
 */
export const AVISO_PENDENTE = 'Há alterações da agenda ainda não salvas. Salve ou descarte (Cancelar) antes de criar ou desativar um salão combinado.';

export const AVISO_COMBINADO = 'Liberar dois salões num pacote ou horário não libera o salão combinado. Para o pacote grande usar o salão inteiro, escolha só o combinado nos salões do pacote.';

type Props = {
  agenda: AgendaEscopo;
  leitura: boolean;
  ocupado: boolean;
  /**
   * Formulário da agenda com alterações não salvas (P2-2 da revisão do Astra): criar ou desativar um combinado grava na
   * hora e recarrega a agenda, o que descartaria essas alterações. Enquanto houver pendência, as ações ficam bloqueadas
   * e a tela pede salvar ou descartar antes.
   */
  pendenteSalvar: boolean;
  onCriar: (dados: { nome: string; capacidadeConvidados: number | null; membros: string[] }) => Promise<boolean>;
  onDesativar: (salao: { id: string; nome: string }) => Promise<void>;
};

export function SaloesCombinados({ agenda, leitura, ocupado, pendenteSalvar, onCriar, onDesativar }: Props) {
  const [nome, setNome] = useState('Salão inteiro');
  const [capacidade, setCapacidade] = useState('');
  const [membros, setMembros] = useState<string[]>([]);
  const [erro, setErro] = useState('');
  const simples = agenda.saloes;

  async function criar() {
    setErro('');
    if (pendenteSalvar) { setErro(AVISO_PENDENTE); return; }
    const n = capacidade.trim() ? Number(capacidade.trim()) : null;
    if (!nome.trim()) { setErro('Dê um nome ao salão combinado.'); return; }
    if (n != null && (!Number.isInteger(n) || n < 1)) { setErro('A capacidade de convidados precisa ser um número inteiro.'); return; }
    if (membros.length < 2) { setErro('Escolha pelo menos dois salões.'); return; }
    if (await onCriar({ nome: nome.trim(), capacidadeConvidados: n, membros })) {
      setMembros([]);
      setCapacidade('');
    }
  }

  return <div data-saloes-combinados>
    <h3>Salões combinados</h3>
    <p className={css.fraco}>Junte salões para uma festa grande (por exemplo, &quot;Salão inteiro&quot;). Quando o combinado está reservado, os salões dele ficam ocupados; quando um deles está reservado, o combinado fica indisponível.</p>
    {agenda.combinados.length > 0 && <div className={css.lista} role="table" aria-label="Salões combinados">
      <div className={`${css.linhaCombinado} ${css.cabecalho}`} role="row"><span role="columnheader">Combinado</span><span role="columnheader">Salões</span><span /></div>
      {agenda.combinados.map((c) => <div key={c.id} className={css.linhaCombinado} role="row" data-combinado={c.id}>
        <span role="cell"><strong>{c.nome}</strong>{c.capacidadeConvidados ? ` · até ${c.capacidadeConvidados} convidados` : ''}</span>
        <span role="cell">
          {c.membros.map((m) => m.nome).join(' + ')}
          {!c.elegivel && <> <span className={`${ws.badge} ${css.badgeAviso}`}>Indisponível: {c.membros.filter((m) => !m.ativo).map((m) => m.nome).join(', ')} desativado</span></>}
        </span>
        {!leitura
          ? <button type="button" className={ws.textButton} disabled={ocupado || pendenteSalvar} onClick={() => void onDesativar({ id: c.id, nome: c.nome })}>Desativar</button>
          : <span />}
      </div>)}
    </div>}
    {!leitura && <div className={css.campos} data-criar-combinado>
      <label>Nome do combinado
        <input value={nome} maxLength={80} disabled={ocupado} onChange={(e) => setNome(e.target.value)} />
      </label>
      <label>Capacidade de convidados
        <input inputMode="numeric" placeholder="Opcional" value={capacidade} disabled={ocupado} onChange={(e) => setCapacidade(e.target.value)} />
      </label>
      <div role="group" aria-label="Salões do combinado" className={`${ws.dias} ${css.chips} ${css.linhaInteira}`}>
        {simples.map((s) => <button key={s.id} type="button" aria-pressed={membros.includes(s.id)} disabled={ocupado}
          onClick={() => setMembros((atual) => atual.includes(s.id) ? atual.filter((x) => x !== s.id) : [...atual, s.id])}>{s.nome}</button>)}
      </div>
      {pendenteSalvar && <p role="status" className={`${ws.notice} ${css.linhaInteira}`} data-aviso-pendente>{AVISO_PENDENTE}</p>}
      {erro && <p role="alert" className={`${ws.error} ${css.linhaInteira}`}>{erro}</p>}
      <div className={`${css.acoes} ${css.linhaInteira}`}>
        <AdminPrimaryButton carregando={ocupado} disabled={pendenteSalvar || simples.length < 2 || membros.length < 2} onClick={() => void criar()}>Criar salão combinado</AdminPrimaryButton>
      </div>
      <p className={`${css.fraco} ${css.linhaInteira}`}>Os salões de um combinado não mudam depois. Para mudar, crie outro e desative o antigo.</p>
    </div>}
    <p className={css.fraco} data-aviso-combinado>{AVISO_COMBINADO}</p>
  </div>;
}
