'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { ContatoLista, DetalheContato } from '@/lib/marketing/contatos';
import type { OpcaoOrigem } from '@/lib/marketing/origens';
import { adminFetch } from '@/lib/http/admin-fetch';
import { clientesDaBusca, dataBr, dataHoraBr, ROTULO_STATUS_CONTATO } from '@/lib/marketing/apresentacao';
import { AdminPrimaryButton } from '../AdminPrimaryButton';
import { AtribuicaoExplicada } from './AtribuicaoExplicada';
import { CabecalhoMarketing, EstadoCarga, enviarMarketing, novaChave, useMarketing } from './comum';
import styles from './marketing.module.css';

type Dados = {
  contatos: ContatoLista[]; origens: OpcaoOrigem[]; campanhas: Array<{ id: string; nome: string; status: string }>; capacidades: string[]; gestao: boolean;
  unidades: Array<{ id: string; nome: string }>;
};

const CANAL: Record<string, string> = { FORMULARIO_SITE: 'Formulário do site', WHATSAPP: 'WhatsApp', TELEFONE: 'Telefone', PRESENCIAL: 'Presencial', EMAIL: 'E-mail', OUTRO: 'Outro' };
const METODO: Record<string, string> = { CAPTURADO: 'capturada pelo link', INFORMADO: 'informada', HERDADO: 'herdada', DESCONHECIDO: 'sem evidência' };
const VINCULO: Record<string, string> = { NOVO: 'cliente criado por este pedido', EXISTENTE_CONTATO: 'cliente existente (mesmo telefone/e-mail)', MANUAL: 'vinculado pela equipe', SEM_CLIENTE: 'sem cliente' };

function origemTexto(c: { origemCodigo: string | null; metodo: string | null; campanhaNome: string | null }, origens: OpcaoOrigem[]) {
  if (!c.origemCodigo) return 'Não registrada';
  const nome = c.origemCodigo === 'DESCONHECIDA' ? 'Desconhecida' : origens.find((o) => o.codigo === c.origemCodigo)?.rotulo ?? c.origemCodigo;
  return `${nome}${c.campanhaNome ? ` · ${c.campanhaNome}` : ''}${c.metodo ? ` (${METODO[c.metodo] ?? c.metodo})` : ''}`;
}

export default function MarketingOrigens() {
  const [status, setStatus] = useState('');
  const [campanhaId, setCampanhaId] = useState('');
  const consulta = new URLSearchParams({ ...(status ? { status } : {}), ...(campanhaId ? { campanhaId } : {}) }).toString();
  const { dados, falha, carregando, recarregar } = useMarketing<Dados>(`/api/admin/marketing/contatos${consulta ? `?${consulta}` : ''}`);
  const [abertoId, setAbertoId] = useState<string | null>(null);
  const [registrando, setRegistrando] = useState(false);
  const podeEditar = dados?.capacidades.includes('MARKETING_CAMPANHAS_EDITAR') ?? false;
  return <main className={styles.pagina}>
    <CabecalhoMarketing titulo="Origens dos contatos" descricao="Pedidos do site e contatos registrados, com a origem de cada um. Vincule à negociação para acompanhar até o contrato."
      acao={podeEditar ? <AdminPrimaryButton type="button" onClick={() => setRegistrando(true)}>+ Registrar contato</AdminPrimaryButton> : undefined} />
    {dados && <form className={styles.filtros} onSubmit={(e) => e.preventDefault()} aria-label="Filtros">
      <label>Situação<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todas</option>{Object.entries(ROTULO_STATUS_CONTATO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      {dados.campanhas.length > 0 && <label>Campanha<select value={campanhaId} onChange={(e) => setCampanhaId(e.target.value)}><option value="">Todas</option>{dados.campanhas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></label>}
    </form>}
    <EstadoCarga carregando={carregando && !dados} falha={falha} aoTentar={recarregar} />
    {dados && <section className={styles.cartao} aria-label="Da campanha ao contrato"><AtribuicaoExplicada /></section>}
    {dados && <>
      <section className={styles.cartao} aria-labelledby="t-contatos">
        <h2 id="t-contatos">Contatos ({dados.contatos.length})</h2>
        {dados.contatos.length === 0 ? <p className={styles.vazio}>Nenhum contato neste filtro. Pedidos do site aparecem aqui assim que chegam.</p> : <>
          <div className={`${styles.tabelaWrap} ${styles.responsiva}`}><table className={styles.tabela}>
            <thead><tr><th>Recebido</th><th>Nome</th><th>Canal</th><th>Origem</th><th>Situação</th><th>Cliente</th><th></th></tr></thead>
            <tbody>{dados.contatos.map((c) => <tr key={c.id}>
              <td>{dataHoraBr(c.recebidoEm)}</td><td>{c.nome}</td><td>{CANAL[c.canal] ?? c.canal}</td><td>{origemTexto(c, dados.origens)}</td>
              <td><span className={c.status === 'CONVERTIDO' ? styles.seloAtivo : c.status === 'NOVO' ? styles.seloVioleta : styles.selo}>{ROTULO_STATUS_CONTATO[c.status]}</span></td>
              <td>{c.clienteId ? <Link href={`/clientes/${c.clienteId}`}>{c.clienteNome ?? 'Abrir'}</Link> : <span className={styles.muted}>—</span>}</td>
              <td><button type="button" className={styles.fantasma} onClick={() => setAbertoId(c.id)}>Detalhes</button></td>
            </tr>)}</tbody>
          </table></div>
          <div className={styles.cards}>{dados.contatos.map((c) => <article key={c.id} className={styles.card}>
            <strong>{c.nome}</strong><p className={styles.muted}>{dataHoraBr(c.recebidoEm)} · {CANAL[c.canal] ?? c.canal}</p>
            <p>{origemTexto(c, dados.origens)}</p><p>{ROTULO_STATUS_CONTATO[c.status]}</p>
            <button type="button" className={styles.secundario} onClick={() => setAbertoId(c.id)}>Detalhes</button>
          </article>)}</div>
        </>}
      </section>
      <ListaOrigens origens={dados.origens} gestao={dados.gestao} aoSalvar={recarregar} />
    </>}
    {abertoId && <DetalheDialogo id={abertoId} podeEditar={podeEditar} aoFechar={() => { setAbertoId(null); recarregar(); }} />}
    {registrando && dados && <RegistroDialogo dados={dados} aoFechar={(salvou) => { setRegistrando(false); if (salvou) recarregar(); }} />}
  </main>;
}

function DetalheDialogo({ id, podeEditar, aoFechar }: { id: string; podeEditar: boolean; aoFechar: () => void }) {
  const { dados, falha, carregando, recarregar } = useMarketing<{ contato: DetalheContato; origens: OpcaoOrigem[] }>(`/api/admin/marketing/contatos?id=${encodeURIComponent(id)}`);
  const [aviso, setAviso] = useState('');
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState<Array<{ id: string; nomeCompleto: string }>>([]);
  async function acao(corpo: Record<string, unknown>) {
    setAviso('');
    try {
      const r = await enviarMarketing<{ origemNegociacaoExistente?: boolean }>('/api/admin/marketing/contatos', corpo);
      if (r?.origemNegociacaoExistente) setAviso('Vinculado. A negociação já tinha origem própria, que foi mantida (corrija na negociação, se for o caso).');
      recarregar();
    } catch (e) { setAviso(e instanceof Error ? e.message : 'Não foi possível concluir.'); }
  }
  async function buscar() {
    if (busca.trim().length < 2) return;
    try {
      const corpo = await (await adminFetch(`/api/admin/clientes?q=${encodeURIComponent(busca.trim())}&limit=10`)).json();
      setResultados(clientesDaBusca(corpo).map((c) => ({ id: c.id, nomeCompleto: c.nome })));
    } catch { setResultados([]); }
  }
  const c = dados?.contato;
  return <div className={styles.dialogo} role="dialog" aria-modal="true" aria-labelledby="t-detalhe">
    <div>
      <h2 id="t-detalhe">Contato</h2>
      <EstadoCarga carregando={carregando && !dados} falha={falha} aoTentar={recarregar} />
      {c && dados && <>
        <p><strong>{c.nome}</strong> · {CANAL[c.canal] ?? c.canal} · recebido em {dataHoraBr(c.recebidoEm)}</p>
        <p className={styles.muted}>{[c.telefone, c.email].filter(Boolean).join(' · ')}{c.dataDesejada ? ` · data desejada ${dataBr(c.dataDesejada)}` : ''}{c.convidados ? ` · ${c.convidados} convidados` : ''}</p>
        {c.mensagem && <p style={{ whiteSpace: 'pre-line' }}>{c.mensagem}</p>}
        <h3>Origem</h3>
        <p>{origemTexto(c, dados.origens)}</p>
        {c.atribuicoes.length > 1 && <ul className={styles.historico}>{c.atribuicoes.map((a) => <li key={a.id} data-vigente={a.vigente}>{a.origemCodigo} · {METODO[a.metodo]} · {dataHoraBr(a.registradoEm)}{a.motivo ? ` · ${a.motivo}` : ''}</li>)}</ul>}
        <h3>Cliente</h3>
        {c.clienteId ? <p><Link href={`/clientes/${c.clienteId}`}>{c.clienteNome}</Link> <span className={styles.muted}>({VINCULO[c.vinculoCliente] ?? c.vinculoCliente})</span>
          {c.origemCliente && <><br /><span className={styles.muted}>Primeira origem do cliente: {c.origemCliente.origemCodigo === 'DESCONHECIDA' ? 'desconhecida' : dados.origens.find((o) => o.codigo === c.origemCliente?.origemCodigo)?.rotulo ?? c.origemCliente.origemCodigo}</span></>}</p>
          : <p className={styles.muted}>Sem cliente vinculado.</p>}
        {podeEditar && !c.fechamentoId && <div className={styles.acoes}>
          <input aria-label="Buscar cliente" placeholder="Buscar cliente pelo nome, telefone ou e-mail" value={busca} onChange={(e) => setBusca(e.target.value)} className={styles.link} />
          <button type="button" className={styles.secundario} onClick={() => void buscar()}>Buscar</button>
          {resultados.map((r) => <button key={r.id} type="button" className={styles.fantasma} onClick={() => void acao({ acao: 'vincular-cliente', id: c.id, clienteId: r.id })}>Vincular {r.nomeCompleto}</button>)}
        </div>}
        <h3>Negociação</h3>
        {c.fechamentoId ? <p className={styles.ok}>Vinculado a uma negociação — o contrato dela herda esta origem.</p>
          : !c.clienteId ? <p className={styles.muted}>Vincule a um cliente primeiro.</p>
            : c.fechamentosDoCliente.length === 0 ? <p className={styles.muted}>O cliente ainda não tem negociação. <Link href={`/admin/clientes/${c.clienteId}/fechamento`}>Iniciar fechamento</Link> e depois volte para vincular.</p>
              : <ul className={styles.historico}>{c.fechamentosDoCliente.map((f) => <li key={f.id}>{dataBr(f.dataEvento)} · {f.status}{f.origemDefinida ? ' · já tem origem' : ''}
                {podeEditar && !f.vinculadoAOutroContato && <> <button type="button" className={styles.fantasma} onClick={() => void acao({ acao: 'vincular-negociacao', id: c.id, fechamentoId: f.id })}>Vincular</button></>}
                {f.vinculadoAOutroContato && <span className={styles.muted}> · vinculada a outro contato</span>}</li>)}</ul>}
        {podeEditar && c.status !== 'CONVERTIDO' && <div className={styles.acoes}>
          {c.status !== 'EM_ATENDIMENTO' && <button type="button" className={styles.secundario} onClick={() => void acao({ acao: 'status', id: c.id, status: 'EM_ATENDIMENTO' })}>Marcar em atendimento</button>}
          {c.status !== 'DESCARTADO' && <button type="button" className={styles.fantasma} onClick={() => void acao({ acao: 'status', id: c.id, status: 'DESCARTADO' })}>Descartar</button>}
        </div>}
        {aviso && <p className={styles.aviso} role="status">{aviso}</p>}
      </>}
      <div className={styles.acoes}><button type="button" className={styles.secundario} onClick={aoFechar}>Fechar</button></div>
    </div>
  </div>;
}

function RegistroDialogo({ dados, aoFechar }: { dados: Dados; aoFechar: (salvou: boolean) => void }) {
  const [chave] = useState(novaChave);
  const [f, setF] = useState({ nome: '', telefone: '', email: '', canal: 'WHATSAPP', origemCodigo: '', campanhaId: '', detalhe: '', dataDesejada: '', convidados: '', mensagem: '', unidadeId: '' });
  const [aviso, setAviso] = useState('');
  const [enviando, setEnviando] = useState(false);
  async function salvar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true); setAviso('');
    try {
      await enviarMarketing('/api/admin/marketing/contatos', {
        acao: 'registrar', chave, nome: f.nome, telefone: f.telefone || null, email: f.email || null, canal: f.canal,
        origemCodigo: f.origemCodigo || null, campanhaId: f.campanhaId || null, detalhe: f.detalhe || null, dataDesejada: f.dataDesejada || null,
        convidados: f.convidados ? Number(f.convidados) : null, mensagem: f.mensagem || null, unidadeId: f.unidadeId || null,
      });
      aoFechar(true);
    } catch (erro) { setAviso(erro instanceof Error ? erro.message : 'Não foi possível registrar.'); }
    finally { setEnviando(false); }
  }
  return <div className={styles.dialogo} role="dialog" aria-modal="true" aria-labelledby="t-registro">
    <form onSubmit={salvar}>
      <h2 id="t-registro">Registrar contato</h2>
      <p className={styles.muted}>Para quem chegou por WhatsApp, telefone ou visita. Sem origem informada, ela fica desconhecida.</p>
      <div className={styles.grade2}>
        <label>Nome<input required minLength={2} maxLength={120} value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} /></label>
        <label>Canal<select value={f.canal} onChange={(e) => setF({ ...f, canal: e.target.value })}>{Object.entries(CANAL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>Telefone<input inputMode="tel" value={f.telefone} onChange={(e) => setF({ ...f, telefone: e.target.value })} /></label>
        <label>E-mail<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label>Origem<select value={f.origemCodigo} onChange={(e) => setF({ ...f, origemCodigo: e.target.value })}><option value="">Não sei / não perguntado</option>{dados.origens.filter((o) => o.ativa).map((o) => <option key={o.codigo} value={o.codigo}>{o.rotulo}</option>)}</select></label>
        {dados.campanhas.length > 0 && <label>Campanha (opcional)<select value={f.campanhaId} onChange={(e) => setF({ ...f, campanhaId: e.target.value })}><option value="">Nenhuma</option>{dados.campanhas.filter((c) => c.status !== 'ARQUIVADA').map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></label>}
        <label>Detalhe (indicador…)<input maxLength={200} value={f.detalhe} onChange={(e) => setF({ ...f, detalhe: e.target.value })} /></label>
        <label>Data desejada<input type="date" value={f.dataDesejada} onChange={(e) => setF({ ...f, dataDesejada: e.target.value })} /></label>
        <label>Convidados<input type="number" min={1} max={5000} value={f.convidados} onChange={(e) => setF({ ...f, convidados: e.target.value })} /></label>
        {dados.unidades.length > 0 && <label>Unidade<select value={f.unidadeId} onChange={(e) => setF({ ...f, unidadeId: e.target.value })}><option value="">Empresa</option>{dados.unidades.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select></label>}
      </div>
      <label>Observação<textarea maxLength={1000} value={f.mensagem} onChange={(e) => setF({ ...f, mensagem: e.target.value })} /></label>
      {aviso && <p className={styles.erro} role="alert">{aviso}</p>}
      <div className={styles.acoes}><button type="button" className={styles.fantasma} onClick={() => aoFechar(false)} disabled={enviando}>Cancelar</button><AdminPrimaryButton type="submit" carregando={enviando}>Registrar</AdminPrimaryButton></div>
    </form>
  </div>;
}

function ListaOrigens({ origens, gestao, aoSalvar }: { origens: OpcaoOrigem[]; gestao: boolean; aoSalvar: () => void }) {
  const [novo, setNovo] = useState('');
  const [aviso, setAviso] = useState('');
  async function salvar(corpo: Record<string, unknown>) {
    setAviso('');
    try { await enviarMarketing('/api/admin/marketing/origens', corpo); setNovo(''); aoSalvar(); }
    catch (e) { setAviso(e instanceof Error ? e.message : 'Não foi possível salvar.'); }
  }
  return <section className={styles.cartao} aria-labelledby="t-opcoes">
    <h2 id="t-opcoes">Opções de origem</h2>
    <p className={styles.muted}>Usadas no CRM para informar como o cliente conheceu o buffet. Desativar esconde de novos registros; o histórico continua legível.</p>
    <ul className={styles.datas}>{origens.map((o) => <li key={o.codigo}>{o.rotulo}{!o.ativa && ' (inativa)'}
      {gestao && <> <button type="button" className={styles.fantasma} style={{ minHeight: 28, padding: '0 8px' }} onClick={() => void salvar({ codigo: o.codigo, rotulo: o.rotulo, ativa: !o.ativa, ordem: o.ordem })}>{o.ativa ? 'Desativar' : 'Ativar'}</button></>}</li>)}</ul>
    {gestao && <form className={styles.filtros} style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); if (novo.trim()) void salvar({ rotulo: novo.trim(), ativa: true }); }}>
      <label>Nova origem<input value={novo} maxLength={60} onChange={(e) => setNovo(e.target.value)} placeholder="ex.: Feira de noivas" /></label>
      <button type="submit" className={styles.secundario}>Adicionar</button>
    </form>}
    {aviso && <p className={styles.erro} role="alert">{aviso}</p>}
  </section>;
}
