'use client';

import { useEffect, useRef, useState } from 'react';
import type { AgendaEscopo, EscopoConfiguravel } from '@/lib/agenda/configuracao-unidade';
import { AGENDA_MAIS_DE_UM_SALAO_LIBERADA, AVISO_VOLTA_UM_SALAO } from '@/lib/agenda/saloes-liberacao';
import { adminFetch } from '@/lib/http/admin-fetch';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import {
  corpoSalvar, DiasChips, EditorSaloes, erroDoForm, formAlterado, formDaAgenda, horarioNovo, INTERVALOS, ler, nomesDosSaloes, SalaoChips,
  type AgendaForm, type HorarioForm,
} from './AssistenteAgenda';
import { AVISO_PENDENTE, SaloesCombinados } from './SaloesCombinados';

/** Rodada 3 do Astra (P2-2): ações de horário e troca de unidade também gravam ou recarregam a agenda inteira. */
const AVISO_PENDENTE_AGENDA = 'Há alterações da agenda ainda não salvas. Salve ou descarte (Cancelar) antes de desativar um horário ou cancelar a desativação.';
const AVISO_PENDENTE_UNIDADE = 'Há alterações da agenda ainda não salvas. Salve ou descarte (Cancelar) antes de trocar de unidade.';
import css from './agenda-configuracao.module.css';
import ws from './workspace.module.css';

export type DadosAgenda = { instalada: boolean; gestao: boolean; escopos: EscopoConfiguravel[]; agenda: AgendaEscopo | null };

const URL_AGENDA = '/api/admin/configuracoes/agenda';
const partes = (iso: string) => iso.slice(0, 10).split('-');
const dataBr = (iso: string) => { const [a, m, d] = partes(iso); return `${d}/${m}/${a}`; };
const diaMes = (iso: string) => { const [, m, d] = partes(iso); return `${d}/${m}`; };
const somarDias = (iso: string, dias: number) => {
  const [a, m, d] = partes(iso).map(Number);
  return new Date(Date.UTC(a ?? 1970, (m ?? 1) - 1, (d ?? 1) + dias)).toISOString().slice(0, 10);
};
const hoje = () => {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
};
const quando = (texto: string) => {
  const data = new Date(texto);
  return Number.isNaN(data.getTime()) ? dataBr(texto) : data.toLocaleDateString('pt-BR');
};
const festas = (n: number) => n === 1 ? '1 festa' : `${n} festas`;

/** Horário com festas futuras: início, fim e dias ficam travados (decisão de Felipe em 22/10/2026). */
/**
 * Decisão de Felipe (23/10/2026, parecer do Astra P3): na capacidade por salão, festa já marcada SEM salão definido
 * ocupa todos os salões no horário dela (e no intervalo mínimo) até a equipe escolher o salão — sem reserva dupla.
 */
export const AVISO_SEM_SALAO = 'Festas já marcadas sem salão definido ocupam todos os salões no horário delas (e no intervalo mínimo) até a equipe escolher o salão de cada uma. Escolha o salão na tela da festa para liberar os demais.';

const travado = (h: HorarioForm) => Boolean(h.original && !h.original.herdado && h.original.festasFuturas.quantidade > 0);
const primeiraData = (h: HorarioForm) => h.original?.festasFuturas.ultima ? somarDias(h.original.festasFuturas.ultima, 1) : somarDias(hoje(), 1);

function Cadeado() {
  return <svg className={css.cadeado} aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
}

function Opcao({ ativo, titulo, texto, disabled, onClick }: { ativo: boolean; titulo: string; texto: string; disabled: boolean; onClick: () => void }) {
  return <button type="button" className={css.opcao} aria-pressed={ativo} disabled={disabled} onClick={onClick}><strong>{titulo}</strong><span>{texto}</span></button>;
}

export default function AgendaConfiguracao({ vitrine }: { vitrine?: { dados: DadosAgenda } }) {
  const [dados, setDados] = useState<DadosAgenda | null>(vitrine?.dados ?? null);
  const [form, setForm] = useState<AgendaForm | null>(() => vitrine?.dados.agenda ? formDaAgenda(vitrine.dados.agenda) : null);
  const [unidadeId, setUnidadeId] = useState(vitrine?.dados.agenda?.escopo.estabelecimentoId ?? '');
  const [carregando, setCarregando] = useState(!vitrine);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [confirmarTroca, setConfirmarTroca] = useState(false);
  const [datas, setDatas] = useState<Record<string, string>>({});
  const [desativar, setDesativar] = useState<{ horario: HorarioForm; data: string } | null>(null);

  function aplicar(novos: DadosAgenda) {
    setDados(novos);
    setForm(novos.agenda ? formDaAgenda(novos.agenda) : null);
    setUnidadeId(novos.agenda?.escopo.estabelecimentoId ?? '');
    setDatas({});
    setConfirmarTroca(false);
  }

  async function buscar(unidade: string) {
    const json = await ler(await adminFetch(`${URL_AGENDA}?unidadeId=${encodeURIComponent(unidade)}`));
    return json.data as DadosAgenda;
  }

  useEffect(() => {
    if (vitrine) return;
    let ativo = true;
    buscar('')
      .then((novos) => { if (ativo) aplicar(novos); })
      .catch((error) => { if (ativo) setErro(error instanceof Error ? error.message : 'Não foi possível carregar a agenda.'); })
      .finally(() => { if (ativo) setCarregando(false); });
    return () => { ativo = false; };
  }, [vitrine]);

  async function recarregar(unidade = unidadeId) {
    if (vitrine) { if (vitrine.dados.agenda) setForm(formDaAgenda(vitrine.dados.agenda)); return; }
    setCarregando(true);
    try {
      aplicar(await buscar(unidade));
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Não foi possível carregar a agenda.');
    } finally {
      setCarregando(false);
    }
  }

  /**
   * Recarrega depois de criar/desativar um combinado SEM descartar rascunho: se o formulário mudou durante a requisição
   * (não deveria: os controles ficam bloqueados), mantém o que foi digitado e só atualiza a agenda salva e a lista de
   * combinados escolhíveis. Devolve true quando preservou o rascunho.
   */
  async function recarregarPreservando(antes: AgendaForm | null) {
    setCarregando(true);
    try {
      const novos = await buscar(unidadeId);
      if (formAtual.current === antes) { aplicar(novos); return false; }
      setDados(novos);
      setForm((atual) => (atual && novos.agenda ? { ...atual, combinados: novos.agenda.combinados.map((c) => c.nome) } : atual));
      return true;
    } finally {
      setCarregando(false);
    }
  }

  async function enviar(corpo: object) {
    return (await ler(await adminFetch(URL_AGENDA, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }))).data;
  }

  const agenda = dados?.agenda ?? null;
  const config = agenda?.config ?? null;
  const leitura = !dados?.gestao;
  const totalFestas = agenda?.horarios.reduce((soma, h) => soma + h.festasFuturas.quantidade, 0) ?? 0;
  const pendente = Boolean(form && agenda && formAlterado(form, agenda));
  // Rodada 2 do Astra (P2-2): enquanto grava ou recarrega, nenhum controle da agenda aceita edição (o recarregamento
  // substituiria o formulário). Defesa em profundidade: o rascunho mais recente fica no ref e é preservado no retorno.
  const bloqueado = leitura || salvando || carregando;
  const formAtual = useRef(form);
  useEffect(() => { formAtual.current = form; }, [form]);
  const mudouRegra = Boolean(form && config && (form.modo !== config.modo || form.capacidadeTipo !== config.capacidadeTipo));

  async function salvar(confirmado = false) {
    if (!form || !agenda || leitura) return;
    setErro('');
    setAviso('');
    const problema = erroDoForm(form);
    if (problema) { setErro(problema); return; }
    if (!confirmado && mudouRegra && totalFestas > 0) { setConfirmarTroca(true); return; }
    setConfirmarTroca(false);
    if (vitrine) { setAviso('Prévia: nada foi salvo.'); return; }
    setSalvando(true);
    try {
      await enviar(corpoSalvar(form, agenda.escopo.estabelecimentoId, 'CONFIGURACOES'));
      await recarregar();
      setAviso('Agenda salva.');
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Não foi possível salvar a agenda.');
    } finally {
      setSalvando(false);
    }
  }

  async function confirmarDesativacao() {
    if (!desativar?.horario.id) return;
    const { horario, data } = desativar;
    setErro('');
    // Rodada 3 do Astra (P2-2): toda ação que grava e recarrega a agenda exige salvar ou descartar a edição pendente.
    if (pendente) { setDesativar(null); setErro(AVISO_PENDENTE_AGENDA); return; }
    if (vitrine) { setDesativar(null); setAviso('Prévia: nada foi salvo.'); return; }
    setSalvando(true);
    try {
      const r = await enviar({ acao: 'desativar', horarioId: horario.id, aPartirDe: data }) as { aPartirDe: string; festasMantidas: number; pacotesSemHorario: string[] };
      setDesativar(null);
      await recarregar();
      const pacotes = r.pacotesSemHorario?.length ? ` Pacotes que ficam sem horário a partir dessa data: ${r.pacotesSemHorario.join(', ')}.` : '';
      setAviso(`${horario.nome} deixa de ser oferecido a partir de ${dataBr(r.aPartirDe ?? data)}. ${festas(r.festasMantidas ?? 0)} ${r.festasMantidas === 1 ? 'continua' : 'continuam'} como ${r.festasMantidas === 1 ? 'está' : 'estão'}.${pacotes}`);
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Não foi possível desativar o horário.');
      setDesativar(null);
    } finally {
      setSalvando(false);
    }
  }

  async function cancelarDesativacao(horario: HorarioForm) {
    if (!horario.id) return;
    setErro('');
    setAviso('');
    if (pendente) { setErro(AVISO_PENDENTE_AGENDA); return; }
    if (vitrine) { setAviso('Prévia: nada foi salvo.'); return; }
    setSalvando(true);
    try {
      await enviar({ acao: 'cancelar_desativacao', horarioId: horario.id });
      await recarregar();
      setAviso(`A desativação de ${horario.nome} foi cancelada.`);
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Não foi possível cancelar a desativação.');
    } finally {
      setSalvando(false);
    }
  }

  // 098: salões combinados (criar e desativar). A desativação com festas de hoje em diante é recusada pelo servidor (D5),
  // que lista as festas na mensagem.
  async function criarCombinado(dados: { nome: string; capacidadeConvidados: number | null; membros: string[] }) {
    if (!agenda) return false;
    setErro('');
    setAviso('');
    // P2-2: gravar e recarregar descartaria a edição pendente; exige salvar ou descartar antes.
    if (pendente) { setErro(AVISO_PENDENTE); return false; }
    if (vitrine) { setAviso('Prévia: nada foi salvo.'); return false; }
    const antes = form;
    setSalvando(true);
    try {
      await enviar({ acao: 'criar_combinado', estabelecimentoId: agenda.escopo.estabelecimentoId, ...dados });
      const mantido = await recarregarPreservando(antes);
      setAviso(`${dados.nome} criado. Escolha-o nos pacotes e horários em que ele pode ser reservado.${mantido ? ' Suas alterações ainda não salvas foram mantidas.' : ''}`);
      return true;
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Não foi possível criar o salão combinado.');
      return false;
    } finally {
      setSalvando(false);
    }
  }

  async function desativarSalao(salao: { id: string; nome: string }) {
    setErro('');
    setAviso('');
    if (pendente) { setErro(AVISO_PENDENTE); return; }
    if (vitrine) { setAviso('Prévia: nada foi salvo.'); return; }
    const antes = form;
    setSalvando(true);
    try {
      await enviar({ acao: 'desativar_salao', salaoId: salao.id });
      const mantido = await recarregarPreservando(antes);
      setAviso(`${salao.nome} foi desativado.${mantido ? ' Suas alterações ainda não salvas foram mantidas.' : ''}`);
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Não foi possível desativar o salão.');
    } finally {
      setSalvando(false);
    }
  }

  function alterarHorario(indice: number, mudanca: Partial<HorarioForm>) {
    if (!form) return;
    setForm({ ...form, horarios: form.horarios.map((h, i) => i === indice ? { ...h, ...mudanca } : h) });
  }

  const saloes = form ? nomesDosSaloes(form) : [];
  const intervalos = form && !INTERVALOS.includes(Number(form.intervalo)) ? [...INTERVALOS, Number(form.intervalo)].sort((a, b) => a - b) : INTERVALOS;
  const hojeIso = hoje();

  return <main className={ws.page} data-admin-workspace data-agenda-configuracao aria-busy={carregando || salvando}>
    <header className={ws.header}>
      <div>
        <h1>Agenda</h1>
        <p className={css.subtitulo}>Vale para a agenda, os orçamentos, o site e o Wall-e.</p>
      </div>
      {dados && dados.escopos.length > 1 && <label className={css.unidade}>Unidade
        <select value={unidadeId} disabled={carregando || salvando || pendente} title={pendente ? AVISO_PENDENTE_UNIDADE : undefined}
          onChange={(e) => { if (pendente) { setErro(AVISO_PENDENTE_UNIDADE); return; } setUnidadeId(e.target.value); setAviso(''); setErro(''); void recarregar(e.target.value); }}>
          {dados.escopos.map((e) => <option key={e.estabelecimentoId ?? ''} value={e.estabelecimentoId ?? ''}>{e.nome}{e.configurado ? '' : ' (não configurada)'}</option>)}
        </select>
      </label>}
    </header>
    <div className={ws.content}>
      <a className={css.voltar} href="/admin/configuracoes">← Voltar às configurações</a>
      {config && <p className={ws.muted}>Configurado por {config.configuradoPor ?? 'alguém da equipe'} em {quando(config.configuradoEm)}</p>}
      {erro && <p role="alert" className={ws.error}>{erro}</p>}
      {aviso && <p role="status" className={ws.notice}>{aviso}</p>}
      {dados && !dados.instalada && <p role="status" className={ws.notice}>A configuração da agenda ainda não está disponível neste ambiente.</p>}
      {dados?.instalada && leitura && <p role="status" className={ws.notice}>Só quem tem Gestão pode alterar a agenda.</p>}
      {dados?.instalada && !leitura && pendente && <p role="status" className={ws.notice} data-aviso-pendente-agenda>Há alterações não salvas. Salve ou descarte (Cancelar) antes de desativar horários, criar ou desativar salões combinados ou trocar de unidade.</p>}

      {dados?.instalada && form && agenda && <>
        <section className={ws.card} aria-labelledby="agenda-modo">
          <h2 id="agenda-modo">1. Modo da agenda</h2>
          <div className={css.opcoes}>
            <Opcao ativo={form.modo === 'FIXO'} titulo="Horários fixos" texto="O buffet cadastra os horários" disabled={bloqueado} onClick={() => setForm({ ...form, modo: 'FIXO' })} />
            <Opcao ativo={form.modo === 'LIVRE'} titulo="Horário livre" texto="O cliente escolhe a hora de início" disabled={bloqueado} onClick={() => setForm({ ...form, modo: 'LIVRE' })} />
          </div>
          {form.modo === 'LIVRE' && <p className={css.fraco} data-aviso-modo-livre>Qualquer hora de início é aceita. O sistema confere o limite do dia, o intervalo entre festas e a capacidade.{form.capacidadeTipo === 'POR_HORARIO' ? ' Festas já marcadas nos horários fixos anteriores continuam ocupando a agenda: um horário livre que se sobreponha a elas fica indisponível.' : ' Festas já marcadas nos horários fixos anteriores continuam ocupando a agenda.'}</p>}
        </section>

        <section className={ws.card} aria-labelledby="agenda-capacidade">
          <h2 id="agenda-capacidade">2. Salões e limites</h2>
          {/* Decisão de Felipe (25/10/2026): a escolha de "mais de um salão" só aparece para quem já está nela, até ser liberada. */}
          {AGENDA_MAIS_DE_UM_SALAO_LIBERADA || config?.capacidadeTipo === 'POR_SALAO'
            ? <div className={css.opcoes}>
              {/* Parecer do Astra (25/10/2026, P2): voltar de por salão para um salão fica bloqueado por ora (servidor recusa). */}
              <Opcao ativo={form.capacidadeTipo === 'POR_HORARIO'} titulo="Um salão" texto="Uma festa por horário" disabled={bloqueado || config?.capacidadeTipo === 'POR_SALAO'} onClick={() => setForm({ ...form, capacidadeTipo: 'POR_HORARIO' })} />
              <Opcao ativo={form.capacidadeTipo === 'POR_SALAO'} titulo="Mais de um salão" texto="Uma festa por salão por vez" disabled={bloqueado} onClick={() => setForm({ ...form, capacidadeTipo: 'POR_SALAO' })} />
              {config?.capacidadeTipo === 'POR_SALAO' && <p className={css.fraco} data-volta-um-salao-bloqueada>{AVISO_VOLTA_UM_SALAO}</p>}
            </div>
            : <p className={`${css.fraco} ${css.umSalao}`} data-agenda-um-salao>Agenda com um salão: cada horário recebe uma festa por vez.</p>}
          <div className={css.campos}>
            <label>Limite de festas por dia
              <input inputMode="numeric" placeholder="Sem limite" value={form.limite} disabled={bloqueado} onChange={(e) => setForm({ ...form, limite: e.target.value })} />
            </label>
            <label>Intervalo mínimo entre festas
              <select value={form.intervalo} disabled={bloqueado} onChange={(e) => setForm({ ...form, intervalo: e.target.value })}>
                {intervalos.map((m) => <option key={m} value={String(m)}>{m} min</option>)}
              </select>
            </label>
          </div>
          {form.capacidadeTipo === 'POR_SALAO' && <p className={css.fraco} data-aviso-sem-salao>{AVISO_SEM_SALAO}</p>}
          {form.capacidadeTipo === 'POR_SALAO' && <>
            <h3>Salões</h3>
            <EditorSaloes form={form} onChange={setForm} disabled={bloqueado} />
            {agenda.combinadosDisponiveis && <SaloesCombinados agenda={agenda} leitura={leitura} ocupado={salvando || carregando}
              pendenteSalvar={pendente} onCriar={criarCombinado} onDesativar={desativarSalao} />}
          </>}
        </section>

        {form.modo === 'FIXO' && <section className={ws.card} aria-labelledby="agenda-horarios">
          <h2 id="agenda-horarios">3. Horários de festa</h2>
          {form.horarios.length > 0 && <div className={css.lista} role="table" aria-label="Horários de festa">
            <div className={`${css.linhaHorario} ${css.cabecalho} ${css.cabecalhoHorario}`} role="row">
              <span role="columnheader">Nome</span><span role="columnheader">Início</span><span role="columnheader">Fim</span><span role="columnheader">Dias</span>
              <span role="columnheader">{form.capacidadeTipo === 'POR_SALAO' ? 'Salões' : 'Festas'}</span><span />
            </div>
            {form.horarios.map((h, i) => {
              const trava = travado(h);
              const futuras = h.original?.festasFuturas;
              const desativadoEm = h.original?.desativadoAPartirDe ?? null;
              const minimo = primeiraData(h);
              const data = datas[h.chave] ?? minimo;
              return <div key={h.chave} className={css.bloco} role="rowgroup">
                <div className={css.linhaHorario} role="row">
                  <label className={css.nomeTravado}>{trava && <Cadeado />}<span className={ws.srOnly}>Nome do horário</span>
                    <input placeholder="Nome" value={h.nome} maxLength={80} disabled={bloqueado} onChange={(e) => alterarHorario(i, { nome: e.target.value })} /></label>
                  <label><span className={ws.srOnly}>Início de {h.nome || 'este horário'}</span><input type="time" value={h.inicio} disabled={bloqueado || trava} onChange={(e) => alterarHorario(i, { inicio: e.target.value })} /></label>
                  <label><span className={ws.srOnly}>Fim de {h.nome || 'este horário'}</span><input type="time" value={h.fim} disabled={bloqueado || trava} onChange={(e) => alterarHorario(i, { fim: e.target.value })} /></label>
                  <DiasChips dias={h.dias} rotulo={h.nome} disabled={bloqueado || trava} onChange={(dias) => alterarHorario(i, { dias })} />
                  {form.capacidadeTipo === 'POR_SALAO'
                    ? <SalaoChips saloes={saloes} escolhidos={h.saloes} rotulo={h.nome} disabled={bloqueado} onChange={(escolhidos) => alterarHorario(i, { saloes: escolhidos })} />
                    : <span className={css.fraco} data-uma-festa-por-horario>1 festa por vez</span>}
                  {!leitura && !(futuras && futuras.quantidade > 0)
                    ? <button type="button" className={css.remover} aria-label={`Remover o horário ${h.nome}`} disabled={bloqueado} onClick={() => setForm({ ...form, horarios: form.horarios.filter((_, j) => j !== i) })}>×</button>
                    : <span />}
                </div>
                {desativadoEm && <div className={css.desativado}>
                  <span className={`${ws.badge} ${css.badgeAviso}`}>Desativado a partir de {diaMes(desativadoEm)}</span>
                  {!leitura && desativadoEm > hojeIso && <button type="button" className={ws.textButton} disabled={salvando || pendente} onClick={() => void cancelarDesativacao(h)}>Cancelar desativação</button>}
                </div>}
                {trava && !desativadoEm && futuras && <div className={css.aviso} role="note">
                  <strong>Não dá para editar o horário {h.nome}</strong>
                  <p>Há {festas(futuras.quantidade)} {futuras.quantidade === 1 ? 'marcada' : 'marcadas'} nele (próxima: {futuras.proxima ? diaMes(futuras.proxima) : '—'}; última: {futuras.ultima ? diaMes(futuras.ultima) : '—'}). Mudar o início ou o fim alteraria festas já contratadas.</p>
                  {!leitura && <div className={css.avisoAcoes}>
                    <label>Desativar a partir de
                      <input type="date" min={minimo} value={data} onChange={(e) => setDatas({ ...datas, [h.chave]: e.target.value })} />
                    </label>
                    <button type="button" disabled={!data || data < minimo || salvando || pendente} onClick={() => setDesativar({ horario: h, data })}>Desativar a partir desta data</button>
                  </div>}
                </div>}
              </div>;
            })}
          </div>}
          {!leitura && <div className={css.acoes}><button type="button" disabled={bloqueado} onClick={() => setForm({ ...form, horarios: [...form.horarios, horarioNovo(form)] })}>+ Adicionar horário</button></div>}
        </section>}

        {!leitura && (confirmarTroca
          ? <div className={css.confirmar} role="alertdialog" aria-labelledby="agenda-troca">
            <p id="agenda-troca">{festas(totalFestas)} {totalFestas === 1 ? 'futura continua como está' : 'futuras continuam como estão'}. A nova regra vale para as próximas.</p>
            {form.capacidadeTipo === 'POR_SALAO' && config?.capacidadeTipo !== 'POR_SALAO' && totalFestas > 0 && <p data-aviso-sem-salao-troca>{AVISO_SEM_SALAO}</p>}
            <div className={css.acoes}>
              <button type="button" onClick={() => setConfirmarTroca(false)}>Voltar</button>
              <AdminPrimaryButton carregando={salvando} onClick={() => void salvar(true)}>Confirmar e salvar</AdminPrimaryButton>
            </div>
          </div>
          : <div className={css.rodape}>
            <button type="button" disabled={salvando || carregando} onClick={() => { setErro(''); setAviso(''); void recarregar(); }}>Cancelar</button>
            <AdminPrimaryButton carregando={salvando} disabled={carregando} onClick={() => void salvar()}>Salvar configurações</AdminPrimaryButton>
          </div>)}
      </>}
    </div>

    {desativar && <div className={css.overlay} role="presentation">
      <div className={css.painel} role="dialog" aria-modal="true" aria-labelledby="agenda-desativar">
        <h2 id="agenda-desativar">Desativar {desativar.horario.nome} a partir de {dataBr(desativar.data)}?</h2>
        <ul>
          <li>As {festas(desativar.horario.original?.festasFuturas.quantidade ?? 0)} até {dataBr(somarDias(desativar.data, -1))} continuam como estão.</li>
          <li>A partir de {dataBr(desativar.data)}, {desativar.horario.nome} deixa de ser oferecido na agenda, nos orçamentos, no site e no Wall-e.</li>
          <li>Para mudar o horário, crie um novo que valha a partir de {dataBr(desativar.data)}.</li>
        </ul>
        <p className={css.fraco}>Até {dataBr(desativar.data)}, você pode cancelar a desativação.</p>
        <div className={css.painelRodape}>
          <span />
          <button type="button" disabled={salvando} onClick={() => setDesativar(null)}>Voltar</button>
          <AdminPrimaryButton carregando={salvando} onClick={() => void confirmarDesativacao()}>Desativar a partir de {diaMes(desativar.data)}</AdminPrimaryButton>
        </div>
      </div>
    </div>}
  </main>;
}
