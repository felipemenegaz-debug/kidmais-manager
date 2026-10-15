'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { Regra, TipoRegra } from '@/lib/marketing/automacoes/regras';
import type { SugestaoDatas } from '@/lib/marketing/sugestoes';
import { adminFetch } from '@/lib/http/admin-fetch';
import { dataBr, dataHoraBr } from '@/lib/marketing/apresentacao';
import { AdminPrimaryButton } from '../AdminPrimaryButton';
import { CabecalhoMarketing, EstadoCarga, enviarMarketing, useMarketing } from './comum';
import styles from './marketing.module.css';

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
const ESTADO: Record<string, string> = { AGENDADA: 'Agendada', PROCESSANDO: 'Processando', ENVIANDO: 'Enviando', TAREFA_CRIADA: 'Tarefa criada', ACEITA: 'Aceita pelo provedor',
  ENTREGUE: 'Entregue', FALHOU: 'Falhou', INCERTA: 'Incerta (conferir)', SUPRIMIDA: 'Suprimida', CANCELADA: 'Cancelada' };
const MOTIVO: Record<string, string> = { SEM_AUTORIZACAO: 'sem autorização de mensagens', DESCADASTRADO: 'descadastrado', SEM_TELEFONE: 'sem telefone', LIMITE_FREQUENCIA: 'limite de frequência',
  NAO_CONTATAR_ATENDIMENTO: 'pediu para não ser contatado no atendimento', CLIENTE_INATIVO: 'cliente inativo', ALVO_NAO_ELEGIVEL: 'condição deixou de valer', REGRA_INATIVA: 'regra pausada',
  REGRA_PAUSADA: 'regra pausada', INTERRUPCAO_DA_EMPRESA: 'interrupção geral', ACAO_ALTERADA: 'ação da regra mudou', TEXTO_ALTERADO_SEM_REVISAO: 'texto alterado sem revisão' };
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function motivoTexto(m: string | null) { if (!m) return ''; return MOTIVO[m] ?? m; }

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
    <CabecalhoMarketing titulo="Automações" descricao="Regras prontas de acompanhamento. Tarefas internas funcionam sem provedor; mensagens usam transporte SIMULADO e só saem para quem autorizou."
      acao={pode && dados ? <div className={styles.acoes}>
        {dados.ambiente.processamentoLigado && <AdminPrimaryButton type="button" carregando={ocupado} onClick={() => void acao({ acao: 'processar' }, (r) => `Ciclo local concluído: ${String((r.planejamento as { criadas?: number })?.criadas ?? 0)} agendada(s), ${String(r.processadas ?? 0)} processada(s).`)}>Processar agora (local)</AdminPrimaryButton>}
        <button type="button" className={styles.perigo} disabled={ocupado} onClick={() => { if (window.confirm('Parar todas as automações desta empresa? Regras ativas são pausadas e o que estava agendado é cancelado.')) void acao({ acao: 'parar-tudo' }, (r) => `${String(r.regrasPausadas)} regra(s) pausada(s); ${String(r.canceladas)} execução(ões) cancelada(s).`); }}>Parar tudo</button>
      </div> : undefined} />
    {dados && dados.unidades.length > 0 && <div className={styles.filtros}><label>Unidade<select value={unidadeId} onChange={(e) => setUnidadeId(e.target.value)}><option value="">Empresa</option>{dados.unidades.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select></label></div>}
    <EstadoCarga carregando={carregando && !dados} falha={falha} aoTentar={recarregar} />
    {aviso && <p className={aviso.tipo === 'ok' ? styles.info : styles.aviso} role={aviso.tipo === 'ok' ? 'status' : 'alert'}>{aviso.texto}</p>}
    {dados && <>
      <p className={dados.ambiente.processamentoLigado ? styles.info : styles.aviso}>
        Processamento {dados.ambiente.processamentoLigado ? 'ligado neste servidor (local)' : 'desligado neste servidor (MARKETING_AUTOMACOES_ENABLED): regras podem ser configuradas e simuladas, mas nada é executado'}.
        Transporte de mensagens: <span className={styles.seloSimulado}>{dados.ambiente.transporte}</span> — nenhuma mensagem real é enviada.
      </p>
      {dados.regras.map((r) => <CartaoRegra key={r.tipo} regra={r} catalogo={dados.catalogo[r.tipo]} pode={pode} unidadeId={unidadeId || null} datasVagas={r.tipo === 'DATAS_VAGAS' ? dados.datasVagas : null}
        aoMudar={(texto) => { setAviso({ tipo: 'ok', texto }); recarregar(); }} aoErro={(texto) => setAviso({ tipo: 'erro', texto })} />)}
      <section className={styles.cartao} aria-labelledby="t-tarefas">
        <h2 id="t-tarefas">Tarefas abertas ({dados.tarefas.length})</h2>
        {dados.tarefas.length === 0 ? <p className={styles.vazio}>Nenhuma tarefa aberta.</p> : <ul className={styles.historico}>{dados.tarefas.map((t) => <li key={t.id}>
          <strong>{t.titulo}</strong> · vence {dataBr(t.vencimento)}{t.descricao ? ` · ${t.descricao}` : ''} · <Link href={`/clientes/${t.cliente_id}`}>cliente</Link>
          {pode && <> <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => void acao({ acao: 'concluir-tarefa', tarefaId: t.id }, () => 'Tarefa concluída.')}>Concluir</button>
            <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => void acao({ acao: 'concluir-tarefa', tarefaId: t.id, cancelar: true }, () => 'Tarefa cancelada.')}>Cancelar</button></>}
        </li>)}</ul>}
      </section>
      <section className={styles.cartao} aria-labelledby="t-exec">
        <h2 id="t-exec">Histórico de execuções</h2>
        {dados.execucoes.length === 0 ? <p className={styles.vazio}>Nada executado ainda.</p> : <div className={styles.tabelaWrap}><table className={styles.tabela}>
          <thead><tr><th>Atualizado</th><th>Regra</th><th>Cliente</th><th>Ação</th><th>Situação</th><th>Detalhe</th><th></th></tr></thead>
          <tbody>{dados.execucoes.map((e) => <tr key={e.id}>
            <td>{dataHoraBr(e.atualizado_em)}</td><td>{dados.catalogo[e.regra_tipo]?.nome ?? e.regra_tipo}</td><td><Link href={`/clientes/${e.cliente_id}`}>{e.cliente_nome}</Link></td>
            <td>{ACAO[e.acao]}</td>
            <td><span className={['FALHOU', 'INCERTA'].includes(e.estado) ? styles.seloAlerta : ['ENTREGUE', 'TAREFA_CRIADA', 'ACEITA'].includes(e.estado) ? styles.seloAtivo : styles.selo}>{ESTADO[e.estado] ?? e.estado}</span></td>
            <td className={styles.muted}>{e.estado === 'AGENDADA' ? `para ${dataHoraBr(e.agendada_para)}` : motivoTexto(e.motivo)}{e.tentativas ? ` · ${e.tentativas} tentativa(s)` : ''}{e.destinatario_mascarado ? ` · ${e.destinatario_mascarado}` : ''}</td>
            <td>{pode && e.estado === 'FALHOU' && <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => void acao({ acao: 'execucao', execucaoId: e.id, operacao: 'tentar-novamente' }, (r) => `Situação: ${String(r.estado)}.`)}>Tentar de novo</button>}
              {pode && ['FALHOU', 'INCERTA'].includes(e.estado) && <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => { if (window.confirm('Encerrar sem reenviar? Use depois de conferir com o cliente.')) void acao({ acao: 'execucao', execucaoId: e.id, operacao: 'encerrar' }, () => 'Encerrada.'); }}>Encerrar</button>}</td>
          </tr>)}</tbody>
        </table></div>}
      </section>
      <section className={styles.cartao} aria-labelledby="t-saida">
        <h2 id="t-saida">Caixa de saída simulada <span className={styles.seloSimulado}>nada foi enviado</span></h2>
        {dados.caixaSimulada.length === 0 ? <p className={styles.vazio}>Vazia.</p> : <ul className={styles.historico}>{dados.caixaSimulada.map((m) => <li key={m.id}>
          {dataHoraBr(m.aceito_em)} · {m.destinatario_mascarado} · modelo {m.template_provedor} · <strong>{m.status}</strong><br />{m.texto}</li>)}</ul>}
      </section>
      <Preferencias pode={pode} />
    </>}
  </main>;
}

function CartaoRegra({ regra, catalogo, pode, unidadeId, datasVagas, aoMudar, aoErro }: {
  regra: Regra; catalogo: Catalogo[TipoRegra]; pode: boolean; unidadeId: string | null; datasVagas: SugestaoDatas | null; aoMudar: (t: string) => void; aoErro: (t: string) => void;
}) {
  const [f, setF] = useState(regra);
  const [ocupado, setOcupado] = useState(false);
  const [simulacao, setSimulacao] = useState<Simulacao | null>(null);
  async function enviar(corpo: Record<string, unknown>, ok: string) {
    setOcupado(true);
    try { const r = await enviarMarketing<{ simulacao?: Simulacao }>('/api/admin/marketing/automacoes', corpo); if (r.simulacao) setSimulacao(r.simulacao); else aoMudar(ok); }
    catch (e) { aoErro(e instanceof Error ? e.message : 'Não foi possível concluir.'); }
    finally { setOcupado(false); }
  }
  const salvar = () => enviar({ acao: 'salvar-regra', tipo: regra.tipo, unidadeId, versao: regra.versao, acaoRegra: f.acao, esperaDias: f.esperaDias, janelaInicio: f.janelaInicio,
    janelaFim: f.janelaFim, fuso: f.fuso, fimDeSemana: f.fimDeSemana, limiteFrequenciaDias: f.limiteFrequenciaDias, maxTentativas: f.maxTentativas,
    templateTexto: f.acao === 'MENSAGEM_WHATSAPP' ? f.templateTexto : regra.templateTexto, templateProvedor: f.acao === 'MENSAGEM_WHATSAPP' ? f.templateProvedor : regra.templateProvedor }, 'Regra salva.');
  const statusTexto = regra.status === 'NAO_CONFIGURADA' ? 'Não configurada' : regra.status === 'ATIVA' ? 'Ativa' : regra.status === 'PAUSADA' ? 'Pausada' : 'Rascunho';
  if (regra.tipo === 'DATAS_VAGAS') return <section className={styles.cartao} aria-label={catalogo.nome}>
    <h2>{catalogo.nome} <span className={styles.selo}>sugestão revisável</span></h2>
    <p className={styles.muted}>{catalogo.gatilho} {catalogo.condicoes}</p>
    {!datasVagas?.disponivel ? <p className={styles.vazio}>{datasVagas?.motivo ?? 'Agenda indisponível.'}</p> : datasVagas.datas.length === 0 ? <p className={styles.vazio}>Sem datas livres.</p>
      : <ul className={styles.datas}>{datasVagas.datas.filter((d) => d.fimDeSemana).slice(0, 12).map((d) => <li key={d.data} data-fds>{DIAS[d.diaSemana]} {dataBr(d.data)}</li>)}</ul>}
    <p className={styles.muted}>Para divulgar, <Link href="/admin/marketing/campanhas">crie uma campanha</Link> e revise o texto. Nada é enviado, reservado ou descontado automaticamente.</p>
  </section>;
  return <section className={styles.cartao} aria-label={catalogo.nome}>
    <h2>{catalogo.nome} <span className={regra.status === 'ATIVA' ? styles.seloAtivo : regra.status === 'PAUSADA' ? styles.seloAlerta : styles.selo}>{statusTexto}</span></h2>
    <p className={styles.muted}><strong>Gatilho:</strong> {catalogo.gatilho} <strong>Condições:</strong> {catalogo.condicoes} <strong>Público:</strong> {catalogo.publico}</p>
    <div className={styles.grade3}>
      <label className={styles.campo}>Ação<select disabled={!pode} value={f.acao} onChange={(e) => setF({ ...f, acao: e.target.value as Regra['acao'] })}>{catalogo.acoes.map((a) => <option key={a} value={a}>{ACAO[a]}</option>)}</select></label>
      <label className={styles.campo}>Espera (dias)<input disabled={!pode} type="number" min={0} max={400} value={f.esperaDias} onChange={(e) => setF({ ...f, esperaDias: Number(e.target.value) })} /></label>
      <label className={styles.campo}>Limite por cliente (dias entre mensagens)<input disabled={!pode} type="number" min={1} max={365} value={f.limiteFrequenciaDias} onChange={(e) => setF({ ...f, limiteFrequenciaDias: Number(e.target.value) })} /></label>
      <label className={styles.campo}>Janela início<input disabled={!pode} type="time" value={f.janelaInicio} onChange={(e) => setF({ ...f, janelaInicio: e.target.value })} /></label>
      <label className={styles.campo}>Janela fim<input disabled={!pode} type="time" value={f.janelaFim} onChange={(e) => setF({ ...f, janelaFim: e.target.value })} /></label>
      <label className={styles.campo}>Fuso<input disabled={!pode} value={f.fuso} onChange={(e) => setF({ ...f, fuso: e.target.value })} /></label>
      <label className={styles.check}><input disabled={!pode} type="checkbox" checked={f.fimDeSemana} onChange={(e) => setF({ ...f, fimDeSemana: e.target.checked })} /> Também sábado e domingo</label>
      <label className={styles.campo}>Tentativas máximas<input disabled={!pode} type="number" min={1} max={5} value={f.maxTentativas} onChange={(e) => setF({ ...f, maxTentativas: Number(e.target.value) })} /></label>
    </div>
    {f.acao === 'MENSAGEM_WHATSAPP' && <>
      <label className={styles.campo}>Texto (marcadores: {'{{nome}}'}, {'{{buffet}}'}, {'{{data_festa}}'}; inclua como PARAR)<textarea disabled={!pode} maxLength={1000} value={f.templateTexto ?? ''} onChange={(e) => setF({ ...f, templateTexto: e.target.value })} /></label>
      <label className={styles.campo}>Nome do modelo aprovado no provedor (ex.: retomar_proposta_v1)<input disabled={!pode} value={f.templateProvedor ?? ''} onChange={(e) => setF({ ...f, templateProvedor: e.target.value })} /></label>
      <p className={styles.muted}>{regra.templateRevisadoEm ? `Texto revisado em ${dataHoraBr(regra.templateRevisadoEm)}.` : 'Texto ainda não revisado: mensagens não podem ser ativadas.'}</p>
    </>}
    {pode && <div className={styles.acoes}>
      <button type="button" className={styles.secundario} disabled={ocupado} onClick={() => void salvar()}>Salvar</button>
      {regra.id && regra.acao === 'MENSAGEM_WHATSAPP' && !regra.templateRevisadoEm && <button type="button" className={styles.secundario} disabled={ocupado} onClick={() => { if (window.confirm(`Aprovar este texto para envio automático?\n\n${regra.templateTexto ?? ''}`)) void enviar({ acao: 'revisar', regraId: regra.id, versao: regra.versao }, 'Texto revisado e aprovado.'); }}>Revisar e aprovar texto</button>}
      {regra.id && regra.status !== 'ATIVA' && <button type="button" className={styles.secundario} disabled={ocupado} onClick={() => void enviar({ acao: 'ativar', regraId: regra.id, versao: regra.versao }, 'Regra ativada.')}>Ativar</button>}
      {regra.id && regra.status === 'ATIVA' && <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => void enviar({ acao: 'pausar', regraId: regra.id }, 'Regra pausada; agendadas canceladas.')}>Pausar</button>}
      {regra.id && <button type="button" className={styles.fantasma} disabled={ocupado} onClick={() => void enviar({ acao: 'simular', regraId: regra.id }, '')}>Simular agora</button>}
    </div>}
    {simulacao && <div className={styles.info} role="status"><strong>Simulação (nada foi gravado): {simulacao.total} alvo(s)</strong>
      {simulacao.alvos.length > 0 && <ul className={styles.historico}>{simulacao.alvos.map((a, i) => <li key={i}>{a.clienteNome}{a.dataFesta ? ` · festa ${dataBr(a.dataFesta)}` : ''} · {a.jaPlanejada ? `já planejada (${ESTADO[a.jaPlanejada] ?? a.jaPlanejada})` : a.impedimento ? `não sairia: ${motivoTexto(a.impedimento)}` : `sairia em ${dataHoraBr(a.agendadaPara)}`}</li>)}</ul>}</div>}
  </section>;
}

function Preferencias({ pode }: { pode: boolean }) {
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState<Array<{ id: string; nome: string }>>([]);
  const [selecionado, setSelecionado] = useState<{ cliente: { id: string; nome: string }; preferencia: { whatsappAutorizado: boolean; autorizacaoOrigem: string | null; autorizadoEm: string | null; descadastradoEm: string | null } | null } | null>(null);
  const [erro, setErro] = useState('');
  async function buscar() {
    if (busca.trim().length < 2) return;
    const corpo = await (await adminFetch(`/api/admin/clientes?q=${encodeURIComponent(busca.trim())}&limit=10`)).json().catch(() => null);
    setResultados(Array.isArray(corpo?.data) ? corpo.data.map((c: { id: string; nomeCompleto: string }) => ({ id: c.id, nome: c.nomeCompleto })) : []);
  }
  async function abrir(id: string) {
    setErro('');
    const corpo = await (await adminFetch(`/api/admin/marketing/automacoes?clienteId=${id}`)).json().catch(() => null);
    if (corpo?.ok) setSelecionado(corpo.data); else setErro(corpo?.erro ?? 'Não foi possível abrir.');
  }
  async function alterar(operacao: 'autorizar' | 'descadastrar' | 'reativar') {
    if (!selecionado) return;
    const confirmacao = window.prompt(operacao === 'descadastrar' ? 'Registre o pedido de descadastro (ex.: pediu por telefone em 14/10):' : 'Registre como a pessoa autorizou (ex.: autorizou por WhatsApp em 14/10):');
    if (!confirmacao || confirmacao.trim().length < 3) return;
    try { await enviarMarketing('/api/admin/marketing/automacoes', { acao: 'preferencia', clienteId: selecionado.cliente.id, operacao, confirmacao }); await abrir(selecionado.cliente.id); }
    catch (e) { setErro(e instanceof Error ? e.message : 'Não foi possível concluir.'); }
  }
  const p = selecionado?.preferencia;
  return <section className={styles.cartao} aria-labelledby="t-pref">
    <h2 id="t-pref">Preferências de contato</h2>
    <p className={styles.muted}>Mensagem automática só para quem autorizou (caixa no formulário do site ou registro da equipe) e não pediu para parar. Descadastro vale na hora e cancela o que estava agendado.</p>
    <div className={styles.acoes}><input className={styles.link} aria-label="Buscar cliente" placeholder="Buscar cliente" value={busca} onChange={(e) => setBusca(e.target.value)} />
      <button type="button" className={styles.secundario} onClick={() => void buscar()}>Buscar</button>
      {resultados.map((r) => <button key={r.id} type="button" className={styles.fantasma} onClick={() => void abrir(r.id)}>{r.nome}</button>)}</div>
    {selecionado && <div style={{ marginTop: 12 }}>
      <p><strong>{selecionado.cliente.nome}</strong>: {p?.descadastradoEm ? `descadastrado em ${dataHoraBr(p.descadastradoEm)}` : p?.whatsappAutorizado ? `autorizado (${p.autorizacaoOrigem === 'FORMULARIO_SITE' ? 'formulário do site' : 'registro da equipe'}) em ${dataHoraBr(p.autorizadoEm)}` : 'sem autorização registrada'}</p>
      {pode && <div className={styles.acoes}>
        {!p?.descadastradoEm && !p?.whatsappAutorizado && <button type="button" className={styles.secundario} onClick={() => void alterar('autorizar')}>Registrar autorização</button>}
        {!p?.descadastradoEm && <button type="button" className={styles.fantasma} onClick={() => void alterar('descadastrar')}>Descadastrar</button>}
        {p?.descadastradoEm && <button type="button" className={styles.fantasma} onClick={() => void alterar('reativar')}>Reativar (novo pedido da pessoa)</button>}
      </div>}
    </div>}
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
  </section>;
}
