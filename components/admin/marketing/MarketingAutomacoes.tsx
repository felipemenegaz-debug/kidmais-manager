'use client';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { Regra, TipoRegra } from '@/lib/marketing/automacoes/regras';
import type { SugestaoDatas } from '@/lib/marketing/sugestoes';
import { LIMITE_SIMULACAO } from '@/lib/marketing/automacoes/alvos';
import { renderizarModelo, validarModelo } from '@/lib/marketing/automacoes/modelo';
import { EXEMPLO_FICTICIO, QUEM_RECEBE, ROTULO_ESTADO, ROTULO_PRAZO, horarioPermitido, motivoLegivel, oQueFaz, quandoAcontece, resumoRegra } from '@/lib/marketing/automacoes/explicacao';
import { adminFetch } from '@/lib/http/admin-fetch';
import { clientesDaBusca, dataBr, dataHoraBr } from '@/lib/marketing/apresentacao';
import { AdminPrimaryButton } from '../AdminPrimaryButton';
import { CabecalhoMarketing, EstadoCarga, enviarMarketing, useMarketing } from './comum';
import styles from './marketing.module.css';
import au from './automacoes.module.css';

type Catalogo = Record<TipoRegra, { nome: string; gatilho: string; condicoes: string; publico: string; acoes: string[] }>;
type Execucao = { id: string; regra_tipo: TipoRegra; acao: string; estado: string; agendada_para: string; tentativas: number; motivo: string | null; cliente_id: string; cliente_nome: string;
  destinatario_mascarado: string | null; conteudo: string | null; atualizado_em: string };
type Dados = {
  regras: Regra[]; catalogo: Catalogo; execucoes: Execucao[]; tarefas: Array<{ id: string; titulo: string; descricao: string | null; vencimento: string; cliente_id: string }>;
  caixaSimulada: Array<{ id: string; destinatario_mascarado: string; template_provedor: string; texto: string; status: string; aceito_em: string }>;
  datasVagas: SugestaoDatas; ambiente: { processamentoLigado: boolean; transporte: string }; unidades: Array<{ id: string; nome: string }>; capacidades: string[];
};
type Simulacao = { total: number; alvos: Array<{ clienteNome: string; dataFesta: string | null; jaPlanejada: string | null; impedimento: string | null; agendadaPara: string }> };

const ACAO: Record<string, string> = { TAREFA_INTERNA: 'Tarefa para a equipe', MENSAGEM_WHATSAPP: 'Mensagem WhatsApp (simulada)', SUGESTAO: 'Sugestão' };
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const STATUS: Record<Regra['status'], string> = { NAO_CONFIGURADA: 'Não configurada', RASCUNHO: 'Rascunho', ATIVA: 'Ativa', PAUSADA: 'Pausada' };
const seloEstado = (e: string) => (['FALHOU', 'INCERTA'].includes(e) ? styles.seloAlerta : ['ENTREGUE', 'TAREFA_CRIADA', 'ACEITA'].includes(e) ? styles.seloAtivo : styles.selo);

export default function MarketingAutomacoes() {
  const [unidadeId, setUnidadeId] = useState('');
  const { dados, falha, carregando, recarregar } = useMarketing<Dados>(`/api/admin/marketing/automacoes${unidadeId ? `?unidadeId=${unidadeId}` : ''}`);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const pode = dados?.capacidades.includes('MARKETING_AUTOMACOES_GERIR') ?? false;
  async function acao(corpo: Record<string, unknown>, sucesso: (r: Record<string, unknown>) => string) {
    setOcupado(true); setAviso(null);
    try { const r = await enviarMarketing<Record<string, unknown>>('/api/admin/marketing/automacoes', corpo); setAviso({ tipo: 'ok', texto: sucesso(r) }); recarregar(); }
    catch (e) { setAviso({ tipo: 'erro', texto: e instanceof Error ? e.message : 'Não foi possível concluir.' }); }
    finally { setOcupado(false); }
  }
  return <main className={styles.pagina}>
    <CabecalhoMarketing titulo="Automações" descricao="Regras prontas de acompanhamento: quando algo acontece, depois do prazo, o sistema cria uma tarefa para a equipe ou envia uma mensagem a quem autorizou." />
    {dados && <div className={au.ambiente} role="note">
      <strong>Ambiente local — mensagens simuladas.</strong>
      <span>Nenhuma mensagem real sai deste servidor: o transporte é <span className={styles.seloSimulado}>{dados.ambiente.transporte}</span> e tudo vai para a “Caixa de saída simulada” abaixo.</span>
      <span>{dados.ambiente.processamentoLigado
        ? 'Ativar uma regra não liga um processamento contínuo aqui: nada roda sozinho neste ambiente. “Processar agora” executa UM ciclo (planeja o que venceu e processa o que está dentro do horário). Em um ambiente real, isso depende de um processador configurado.'
        : 'Processamento desligado neste servidor (MARKETING_AUTOMACOES_ENABLED): regras podem ser configuradas e simuladas, mas nada é executado.'}</span>
      {pode && <div className={styles.acoes}>
        {dados.ambiente.processamentoLigado && <AdminPrimaryButton type="button" carregando={ocupado} onClick={() => void acao({ acao: 'processar' }, (r) => `Ciclo concluído: ${String((r.planejamento as { criadas?: number })?.criadas ?? 0)} execução(ões) agendada(s), ${String(r.processadas ?? 0)} processada(s). Veja o histórico abaixo.`)}>Processar agora (um ciclo)</AdminPrimaryButton>}
        <button type="button" className={styles.perigo} disabled={ocupado} onClick={() => { if (window.confirm('Parar todas as automações desta empresa? Regras ativas são pausadas e o que estava agendado é cancelado.')) void acao({ acao: 'parar-tudo' }, (r) => `${String(r.regrasPausadas)} regra(s) pausada(s); ${String(r.canceladas)} execução(ões) cancelada(s).`); }}>Parar tudo</button>
      </div>}
    </div>}
    {dados && !pode && <p className={styles.info}>Seu acesso permite só visualizar as automações. Editar, ativar, pausar e processar dependem da permissão “Automações” (Marketing → Permissões).</p>}
    {dados && dados.unidades.length > 0 && <div className={styles.filtros}><label>Regras da<select value={unidadeId} onChange={(e) => setUnidadeId(e.target.value)}><option value="">Empresa (todas as unidades)</option>{dados.unidades.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select></label>
      <span className={styles.muted}>Regras da empresa e de cada unidade são independentes.</span></div>}
    <EstadoCarga carregando={carregando && !dados} falha={falha} aoTentar={recarregar} />
    {aviso && <p className={aviso.tipo === 'ok' ? styles.info : styles.aviso} role={aviso.tipo === 'ok' ? 'status' : 'alert'}>{aviso.texto}</p>}
    {dados && <>
      {dados.regras.map((r) => <CartaoRegra key={`${unidadeId}:${r.tipo}:${r.versao}`} regra={r} catalogo={dados.catalogo[r.tipo]} pode={pode} unidadeId={unidadeId || null}
        datasVagas={r.tipo === 'DATAS_VAGAS' ? dados.datasVagas : null} aoMudar={(texto) => { setAviso({ tipo: 'ok', texto }); recarregar(); }} aoErro={(texto) => setAviso({ tipo: 'erro', texto })} />)}
      <section className={styles.cartao} aria-labelledby="t-tarefas">
        <h2 id="t-tarefas">Tarefas abertas ({dados.tarefas.length})</h2>
        <p className={styles.muted}>Criadas pelas regras com a ação “tarefa”. Não dependem de autorização de mensagens.</p>
        {dados.tarefas.length === 0 ? <p className={styles.vazio}>Nenhuma tarefa aberta.</p> : <ul className={styles.historico}>{dados.tarefas.map((t) => <li key={t.id}>
          <strong>{t.titulo}</strong> · vence {dataBr(t.vencimento)}{t.descricao ? ` · ${t.descricao}` : ''} · <Link href={`/clientes/${t.cliente_id}`}>cliente</Link>
          {pode && <> <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => void acao({ acao: 'concluir-tarefa', tarefaId: t.id }, () => 'Tarefa concluída.')}>Concluir</button>
            <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => void acao({ acao: 'concluir-tarefa', tarefaId: t.id, cancelar: true }, () => 'Tarefa cancelada.')}>Cancelar</button></>}
        </li>)}</ul>}
      </section>
      <Historico execucoes={dados.execucoes} catalogo={dados.catalogo} pode={pode} ocupado={ocupado} acao={acao} />
      <section className={styles.cartao} aria-labelledby="t-saida">
        <h2 id="t-saida">Caixa de saída simulada <span className={styles.seloSimulado}>nada foi enviado</span></h2>
        <p className={styles.muted}>O que o transporte simulado aceitou. Número sempre mascarado. Uma mensagem aqui não significa que alguém a recebeu.</p>
        {dados.caixaSimulada.length === 0 ? <p className={styles.vazio}>Vazia.</p> : <ul className={styles.historico}>{dados.caixaSimulada.map((m) => <li key={m.id}>
          {dataHoraBr(m.aceito_em)} · {m.destinatario_mascarado} · modelo {m.template_provedor} · <strong>{m.status}</strong><br />{m.texto}</li>)}</ul>}
      </section>
      <Preferencias pode={pode} />
    </>}
  </main>;
}

function Historico({ execucoes, catalogo, pode, ocupado, acao }: {
  execucoes: Execucao[]; catalogo: Catalogo; pode: boolean; ocupado: boolean; acao: (c: Record<string, unknown>, s: (r: Record<string, unknown>) => string) => Promise<void>;
}) {
  return <section className={styles.cartao} aria-labelledby="t-exec">
    <h2 id="t-exec">Histórico de execuções</h2>
    <details className={au.legenda}><summary>O que significa cada situação</summary><ul>
      <li><strong>Agendada</strong>: vai rodar no próximo horário permitido; é conferida de novo antes de agir.</li>
      <li><strong>Tarefa criada</strong>: a tarefa está em “Tarefas abertas”.</li>
      <li><strong>Mensagem aceita pelo transporte simulado</strong>: o transporte local aceitou; não é confirmação de entrega.</li>
      <li><strong>Não enviada (impedimento)</strong> / <strong>Cancelada</strong>: nada saiu; o motivo explica por quê.</li>
      <li><strong>Falhou</strong> / <strong>Resultado incerto</strong>: confira antes de tentar de novo; nada é reenviado automaticamente.</li>
    </ul></details>
    {execucoes.length === 0 ? <p className={styles.vazio}>Nada executado ainda.</p> : <div className={styles.tabelaWrap}><table className={styles.tabela}>
      <thead><tr><th>Data</th><th>Regra</th><th>Contato</th><th>Ação</th><th>Situação</th><th>Motivo / detalhe</th><th aria-label="Ações" /></tr></thead>
      <tbody>{execucoes.map((e) => <tr key={e.id}>
        <td>{dataHoraBr(e.atualizado_em)}</td><td>{catalogo[e.regra_tipo]?.nome ?? e.regra_tipo}</td><td><Link href={`/clientes/${e.cliente_id}`}>{e.cliente_nome}</Link>{e.destinatario_mascarado ? <span className={styles.muted}> · {e.destinatario_mascarado}</span> : null}</td>
        <td>{ACAO[e.acao] ?? e.acao}</td>
        <td><span className={seloEstado(e.estado)}>{ROTULO_ESTADO[e.estado] ?? e.estado}</span></td>
        <td className={styles.muted}>{e.estado === 'AGENDADA' ? `para ${dataHoraBr(e.agendada_para)}` : motivoLegivel(e.motivo)}{e.tentativas ? ` · ${e.tentativas} tentativa(s)` : ''}</td>
        <td>{pode && e.estado === 'FALHOU' && <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => void acao({ acao: 'execucao', execucaoId: e.id, operacao: 'tentar-novamente' }, (r) => `Situação: ${String(r.estado)}.`)}>Tentar de novo</button>}
          {pode && ['FALHOU', 'INCERTA'].includes(e.estado) && <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => { if (window.confirm('Encerrar sem reenviar? Use depois de conferir com o cliente.')) void acao({ acao: 'execucao', execucaoId: e.id, operacao: 'encerrar' }, () => 'Encerrada.'); }}>Encerrar</button>}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

function Passo({ n, titulo, children }: { n: number; titulo: string; children: ReactNode }) {
  return <li className={au.passo}><span className={au.numero} aria-hidden="true">{n}</span><div><h3>{titulo}</h3>{children}</div></li>;
}

function CartaoRegra({ regra, catalogo, pode, unidadeId, datasVagas, aoMudar, aoErro }: {
  regra: Regra; catalogo: Catalogo[TipoRegra]; pode: boolean; unidadeId: string | null; datasVagas: SugestaoDatas | null; aoMudar: (t: string) => void; aoErro: (t: string) => void;
}) {
  const [f, setF] = useState(regra);
  const [ocupado, setOcupado] = useState(false);
  const [simulacao, setSimulacao] = useState<Simulacao | null>(null);
  const sujo = JSON.stringify(f) !== JSON.stringify(regra);
  async function enviar(corpo: Record<string, unknown>, ok: string) {
    setOcupado(true);
    try { const r = await enviarMarketing<{ simulacao?: Simulacao }>('/api/admin/marketing/automacoes', corpo); if (r.simulacao) setSimulacao(r.simulacao); else aoMudar(ok); }
    catch (e) { aoErro(e instanceof Error ? e.message : 'Não foi possível concluir.'); }
    finally { setOcupado(false); }
  }
  const salvar = () => enviar({ acao: 'salvar-regra', tipo: regra.tipo, unidadeId, versao: regra.versao, acaoRegra: f.acao, esperaDias: f.esperaDias, janelaInicio: f.janelaInicio,
    janelaFim: f.janelaFim, fuso: f.fuso, fimDeSemana: f.fimDeSemana, limiteFrequenciaDias: f.limiteFrequenciaDias, maxTentativas: f.maxTentativas,
    templateTexto: f.acao === 'MENSAGEM_WHATSAPP' ? f.templateTexto : regra.templateTexto, templateProvedor: f.acao === 'MENSAGEM_WHATSAPP' ? f.templateProvedor : regra.templateProvedor },
    regra.status === 'ATIVA' ? 'Regra salva e continua ativa.' : 'Regra salva como rascunho (não está ativa).');
  const statusClasse = regra.status === 'ATIVA' ? styles.seloAtivo : regra.status === 'PAUSADA' ? styles.seloAlerta : styles.selo;

  if (regra.tipo === 'DATAS_VAGAS') return <section className={styles.cartao} aria-label={catalogo.nome}>
    <h2>{catalogo.nome} <span className={styles.selo}>só sugestão</span></h2>
    <p className={au.resumo}>{resumoRegra(regra)}</p>
    {!datasVagas?.disponivel ? <p className={styles.vazio}>{datasVagas?.motivo ?? 'Agenda indisponível.'}</p> : datasVagas.datas.length === 0 ? <p className={styles.vazio}>Sem datas livres no período.</p>
      : <ul className={styles.datas}>{datasVagas.datas.filter((d) => d.fimDeSemana).slice(0, 12).map((d) => <li key={d.data} data-fds>{DIAS[d.diaSemana]} {dataBr(d.data)}</li>)}</ul>}
    <p className={styles.muted}>Para divulgar, <Link href="/admin/marketing/campanhas">crie uma campanha</Link> e revise o texto.</p>
  </section>;

  const mensagem = f.acao === 'MENSAGEM_WHATSAPP';
  const problemasTexto = mensagem && f.templateTexto ? validarModelo(f.templateTexto) : [];
  const textoMudou = (f.templateTexto ?? null) !== (regra.templateTexto ?? null) || (f.templateProvedor ?? null) !== (regra.templateProvedor ?? null);
  return <section className={styles.cartao} aria-label={catalogo.nome}>
    <h2>{catalogo.nome} <span className={statusClasse}>{STATUS[regra.status]}</span>{sujo && <> <span className={styles.seloAlerta}>alterações não salvas</span></>}</h2>
    <p className={au.resumo}><strong>Resumo:</strong> {resumoRegra(f)}</p>
    <ol className={au.passos}>
      <Passo n={1} titulo="Quando acontecer">
        <p>{quandoAcontece(f)}.</p>
        <p className={styles.muted}>Quem: {catalogo.publico} Se a situação mudar antes da hora (ex.: o contrato foi assinado), nada acontece.</p>
      </Passo>
      <Passo n={2} titulo="Prazo">
        <label className={styles.campo}>{ROTULO_PRAZO[regra.tipo]}<input disabled={!pode} type="number" min={0} max={400} value={f.esperaDias} onChange={(e) => setF({ ...f, esperaDias: Number(e.target.value) })} /></label>
      </Passo>
      <Passo n={3} titulo="O que fazer">
        <div className={au.opcoes} role="radiogroup" aria-label="Ação">
          {catalogo.acoes.map((a) => <label key={a} className={au.opcao}>
            <input type="radio" name={`acao-${regra.tipo}`} disabled={!pode} checked={f.acao === a} onChange={() => setF({ ...f, acao: a as Regra['acao'] })} />
            <strong>{a === 'TAREFA_INTERNA' ? 'Criar tarefa para a equipe' : 'Enviar mensagem de WhatsApp'}</strong>
            <span>{a === 'TAREFA_INTERNA' ? 'Aparece em “Tarefas abertas”. Funciona sem provedor e sem autorização de mensagens.' : 'Só para quem autorizou um número do cadastro. Neste ambiente a mensagem é simulada.'}</span>
          </label>)}
        </div>
        {mensagem && <details className={au.legenda}><summary>Quem recebe e quem não recebe</summary><ul>{QUEM_RECEBE.map((q) => <li key={q}>{q}</li>)}</ul></details>}
      </Passo>
      {mensagem && <Passo n={4} titulo="Mensagem">
        <label className={styles.campo}>Texto (marcadores: {'{{nome}}'}, {'{{buffet}}'}, {'{{data_festa}}'}; precisa dizer como parar com “PARAR”)
          <textarea disabled={!pode} maxLength={1000} rows={4} value={f.templateTexto ?? ''} onChange={(e) => setF({ ...f, templateTexto: e.target.value })} /></label>
        {problemasTexto.length > 0 && <div className={styles.aviso} role="status"><ul>{problemasTexto.map((p) => <li key={p}>{p}</li>)}</ul></div>}
        <label className={styles.campo}>Nome do modelo no provedor (ex.: retomar_proposta_v1)<input disabled={!pode} value={f.templateProvedor ?? ''} onChange={(e) => setF({ ...f, templateProvedor: e.target.value })} /></label>
        {f.templateTexto && <div className={au.previaMensagem} aria-label="Prévia da mensagem">
          <span className={au.rotuloFicticio}>Prévia com dados fictícios: {EXEMPLO_FICTICIO.nome}, festa em {dataBr(EXEMPLO_FICTICIO.dataFesta)}</span>
          <p>{renderizarModelo(f.templateTexto, EXEMPLO_FICTICIO)}</p>
        </div>}
        <p className={styles.muted}>{regra.templateRevisadoEm && !textoMudou ? `Texto revisado por uma pessoa em ${dataHoraBr(regra.templateRevisadoEm)}.` : 'Texto ainda não revisado: a regra de mensagem só pode ser ativada depois da revisão.'}
          {' '}A revisão aqui é interna; a aprovação do modelo pelo provedor de WhatsApp é outra etapa e não acontece neste ambiente.</p>
      </Passo>}
      <Passo n={mensagem ? 5 : 4} titulo="Horários e frequência">
        <p>{horarioPermitido(f)}.{mensagem ? ` No máximo uma mensagem automática por cliente a cada ${f.limiteFrequenciaDias} dia(s).` : ''}</p>
        <details className={au.avancado}><summary>Ajustar horários{mensagem ? ', frequência e tentativas' : ''}</summary>
          <div className={styles.grade3}>
            <label className={styles.campo}>Começa às<input disabled={!pode} type="time" value={f.janelaInicio} onChange={(e) => setF({ ...f, janelaInicio: e.target.value })} /></label>
            <label className={styles.campo}>Termina às<input disabled={!pode} type="time" value={f.janelaFim} onChange={(e) => setF({ ...f, janelaFim: e.target.value })} /></label>
            <label className={styles.campo}>Fuso horário<input disabled={!pode} value={f.fuso} onChange={(e) => setF({ ...f, fuso: e.target.value })} /></label>
            <label className={styles.check}><input disabled={!pode} type="checkbox" checked={f.fimDeSemana} onChange={(e) => setF({ ...f, fimDeSemana: e.target.checked })} /> Também sábado e domingo</label>
            {mensagem && <label className={styles.campo}>Intervalo mínimo entre mensagens ao mesmo cliente (dias, todas as regras)<input disabled={!pode} type="number" min={1} max={365} value={f.limiteFrequenciaDias} onChange={(e) => setF({ ...f, limiteFrequenciaDias: Number(e.target.value) })} /></label>}
            {mensagem && <label className={styles.campo}>Tentativas se o provedor estiver indisponível<input disabled={!pode} type="number" min={1} max={5} value={f.maxTentativas} onChange={(e) => setF({ ...f, maxTentativas: Number(e.target.value) })} /></label>}
          </div>
          <p className={styles.muted}>O que vencer fora do horário fica agendado para o próximo horário permitido.</p>
        </details>
      </Passo>
      <Passo n={mensagem ? 6 : 5} titulo="Revisar, simular e ativar">
        {regra.status === 'ATIVA' && <p className={styles.muted}>Esta regra está ativa. Salvar prazo, horários ou ação mantém a regra ativa, e o que já está agendado é conferido de novo com a regra atual antes de agir.{mensagem ? ' Mudar o texto ou o modelo pausa a regra e cancela as mensagens agendadas até uma nova revisão.' : ''}</p>}
        {pode ? <div className={styles.acoes}>
          <button type="button" className={styles.secundario} disabled={ocupado || !sujo} onClick={() => void salvar()}>{regra.status === 'ATIVA' ? 'Salvar alterações' : 'Salvar rascunho'}</button>
          <button type="button" className={styles.fantasma} disabled={ocupado || !regra.id || sujo} title={!regra.id ? 'Salve a regra primeiro' : sujo ? 'A simulação usa a versão salva: salve antes' : undefined}
            onClick={() => void enviar({ acao: 'simular', regraId: regra.id }, '')}>Simular agora</button>
          {regra.id && regra.acao === 'MENSAGEM_WHATSAPP' && !regra.templateRevisadoEm && !sujo && <button type="button" className={styles.secundario} disabled={ocupado}
            onClick={() => { if (window.confirm(`Aprovar este texto para mensagens automáticas?\n\n${regra.templateTexto ?? ''}`)) void enviar({ acao: 'revisar', regraId: regra.id, versao: regra.versao }, 'Texto revisado e aprovado.'); }}>Revisar e aprovar texto</button>}
          {regra.id && regra.status !== 'ATIVA' && <AdminPrimaryButton type="button" carregando={ocupado} disabled={sujo} title={sujo ? 'Salve antes de ativar' : undefined}
            onClick={() => void enviar({ acao: 'ativar', regraId: regra.id, versao: regra.versao }, 'Regra ativada. Ela age nos próximos ciclos de processamento.')}>Ativar</AdminPrimaryButton>}
          {regra.id && regra.status === 'ATIVA' && <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => { if (window.confirm('Pausar a regra? O que estava agendado é cancelado.')) void enviar({ acao: 'pausar', regraId: regra.id }, 'Regra pausada; agendadas canceladas.'); }}>Pausar</button>}
        </div> : <p className={styles.muted}>Somente visualização.</p>}
        {!regra.id && <p className={styles.muted}>Ainda não configurada: salve para poder simular e ativar.</p>}
      </Passo>
    </ol>
    {simulacao && <div className={styles.info} role="status">
      <strong>Simulação com a versão salva — nada foi gravado nem enviado.</strong>
      <p style={{ margin: '4px 0' }}>{simulacao.total} cliente(s) atendem à condição agora{simulacao.total > simulacao.alvos.length ? `; mostrando os primeiros ${simulacao.alvos.length} (amostra limitada a ${LIMITE_SIMULACAO})` : ''}.</p>
      {simulacao.alvos.length > 0 && <ul className={styles.historico}>{simulacao.alvos.map((a, i) => <li key={i}>{a.clienteNome}{a.dataFesta ? ` · festa ${dataBr(a.dataFesta)}` : ''} · {a.jaPlanejada
        ? `já planejada (${ROTULO_ESTADO[a.jaPlanejada] ?? a.jaPlanejada})`
        : a.impedimento ? `não sairia: ${motivoLegivel(a.impedimento)}` : `${oQueFaz(regra.acao)} em ${dataHoraBr(a.agendadaPara)}`}</li>)}</ul>}
    </div>}
  </section>;
}

type AutorizacaoUi = { id: string; destino: string; estado: 'PENDENTE' | 'CONFIRMADA' | 'REVOGADA'; origem: string; evidencia: string; confirmadaEm: string | null; revogadaEm: string | null; motivoRevogacao: string | null; criadoEm: string };
type PreferenciaUi = { cliente: { id: string; nome: string; destinos: string[] }; preferencia: { descadastradoEm: string | null; autorizacoes: AutorizacaoUi[] } };

/** Número exibido com só os 4 finais (a tela não precisa do número inteiro para decidir). */
function finalDoNumero(destino: string) { return `•••• ${destino.slice(-4)}`; }

function Preferencias({ pode }: { pode: boolean }) {
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState<Array<{ id: string; nome: string }>>([]);
  const [selecionado, setSelecionado] = useState<PreferenciaUi | null>(null);
  const [erro, setErro] = useState('');
  async function buscar() {
    if (busca.trim().length < 2) return;
    const corpo = await (await adminFetch(`/api/admin/clientes?q=${encodeURIComponent(busca.trim())}&limit=10`)).json().catch(() => null);
    setResultados(clientesDaBusca(corpo));
  }
  async function abrir(id: string) {
    setErro('');
    const corpo = await (await adminFetch(`/api/admin/marketing/automacoes?clienteId=${id}`)).json().catch(() => null);
    if (corpo?.ok) setSelecionado(corpo.data); else setErro(corpo?.erro ?? 'Não foi possível abrir.');
  }
  async function alterar(corpo: Record<string, unknown>, pergunta: string) {
    if (!selecionado) return;
    const confirmacao = window.prompt(pergunta);
    if (!confirmacao || confirmacao.trim().length < 3) return;
    try { await enviarMarketing('/api/admin/marketing/automacoes', { acao: 'preferencia', clienteId: selecionado.cliente.id, confirmacao, ...corpo }); await abrir(selecionado.cliente.id); }
    catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível concluir.'); }
  }
  const p = selecionado?.preferencia;
  const vivas = p?.autorizacoes.filter((a) => a.estado !== 'REVOGADA') ?? [];
  const autorizados = new Set(vivas.map((a) => a.destino));
  return <section className={styles.cartao} aria-labelledby="t-pref">
    <h2 id="t-pref">Preferências e autorizações de contato</h2>
    <p className={styles.muted}>A autorização vale para um número específico. Só sai mensagem para um número do cadastro com autorização confirmada; trocar o número no cadastro não leva a autorização junto. Pedido do site com número fora do cadastro fica pendente até a equipe confirmar. Descadastro vale para o cliente inteiro, na hora.</p>
    <div className={styles.acoes}><input className={styles.link} aria-label="Buscar cliente" placeholder="Buscar cliente" value={busca} onChange={(e) => setBusca(e.target.value)} />
      <button type="button" className={styles.secundario} onClick={() => void buscar()}>Buscar</button>
      {resultados.map((r) => <button key={r.id} type="button" className={styles.fantasma} onClick={() => void abrir(r.id)}>{r.nome}</button>)}</div>
    {selecionado && p && <div style={{ marginTop: 12 }}>
      <p><strong>{selecionado.cliente.nome}</strong>{p.descadastradoEm ? ` — descadastrado em ${dataHoraBr(p.descadastradoEm)}` : ''}</p>
      <ul className={styles.historico}>
        {p.autorizacoes.length === 0 && <li>Nenhuma autorização registrada.</li>}
        {p.autorizacoes.map((a) => <li key={a.id} data-vigente={a.estado === 'CONFIRMADA'}>
          {finalDoNumero(a.destino)} · <strong>{a.estado === 'CONFIRMADA' ? 'confirmada' : a.estado === 'PENDENTE' ? 'pendente de confirmação' : 'revogada'}</strong>
          {' '}({a.origem === 'FORMULARIO_SITE' ? 'formulário do site' : 'equipe'}, {dataHoraBr(a.criadoEm)})
          {!selecionado.cliente.destinos.includes(a.destino) && a.estado !== 'REVOGADA' && <>{' '}<span className={styles.seloAlerta}>número fora do cadastro atual</span></>}
          {a.motivoRevogacao ? ` · ${a.motivoRevogacao}` : ''}
          {pode && a.estado === 'PENDENTE' && !p.descadastradoEm && <> <button type="button" className={styles.fantasma} onClick={() => void alterar({ operacao: 'confirmar', autorizacaoId: a.id }, 'Como a equipe confirmou que este número é da pessoa e que ela autorizou?')}>Confirmar</button></>}
          {pode && a.estado !== 'REVOGADA' && <> <button type="button" className={styles.fantasma} onClick={() => void alterar({ operacao: 'revogar', autorizacaoId: a.id }, 'Motivo da revogação:')}>Revogar</button></>}
        </li>)}
      </ul>
      {pode && !p.descadastradoEm && <div className={styles.acoes} style={{ marginTop: 8 }}>
        {selecionado.cliente.destinos.filter((d) => !autorizados.has(d)).map((d) => <button key={d} type="button" className={styles.secundario}
          onClick={() => void alterar({ operacao: 'autorizar', destino: d }, `Registre como a pessoa autorizou mensagens no número ${finalDoNumero(d)}:`)}>Autorizar {finalDoNumero(d)}</button>)}
        <button type="button" className={styles.fantasma} onClick={() => void alterar({ operacao: 'descadastrar' }, 'Registre o pedido de descadastro (ex.: pediu por telefone em 14/10):')}>Descadastrar</button>
      </div>}
      {pode && p.descadastradoEm && <div className={styles.acoes}><button type="button" className={styles.fantasma} onClick={() => void alterar({ operacao: 'reativar' }, 'Registre o novo pedido da própria pessoa:')}>Reativar (novo pedido da pessoa)</button></div>}
    </div>}
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
  </section>;
}
