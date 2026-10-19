'use client';
import { useState } from 'react';
import type { Atribuicao, AlvoAtribuicao } from '@/lib/marketing/atribuicao';
import type { OpcaoOrigem } from '@/lib/marketing/origens';
import { dataHoraBr } from '@/lib/marketing/apresentacao';
import { enviarMarketing, useMarketing } from './comum';
import styles from './marketing.module.css';

type Dados = { vigente: Atribuicao | null; historico: Atribuicao[]; origens: OpcaoOrigem[]; campanhas: Array<{ id: string; nome: string }> };

const CANAIS: Array<[string, string]> = [['', 'Não informado'], ['WHATSAPP', 'WhatsApp'], ['TELEFONE', 'Telefone'], ['PRESENCIAL', 'Presencial'], ['EMAIL', 'E-mail'], ['FORMULARIO_SITE', 'Formulário do site'], ['OUTRO', 'Outro']];
const METODO: Record<string, string> = { CAPTURADO: 'capturada pelo link', INFORMADO: 'informada pela equipe', HERDADO: 'herdada do contato', DESCONHECIDO: 'sem evidência' };

function rotulo(codigo: string, origens: OpcaoOrigem[]) {
  if (codigo === 'DESCONHECIDA') return 'Desconhecida';
  return origens.find((o) => o.codigo === codigo)?.rotulo ?? codigo;
}

/**
 * Origem manual no CRM (recurso básico): mostra a origem vigente e o histórico, registra a primeira e corrige com
 * motivo (nada é apagado). Cliente: primeira origem; negociação: origem desta negociação.
 */
export default function OrigemPainel({ alvoTipo, alvoId, titulo }: { alvoTipo: AlvoAtribuicao; alvoId: string; titulo?: string }) {
  const { dados, falha, carregando, recarregar } = useMarketing<Dados>(`/api/admin/marketing/atribuicoes?alvoTipo=${alvoTipo}&alvoId=${encodeURIComponent(alvoId)}`);
  const [editando, setEditando] = useState(false);
  const [origem, setOrigem] = useState('');
  const [canal, setCanal] = useState('');
  const [campanhaId, setCampanhaId] = useState('');
  const [detalhe, setDetalhe] = useState('');
  const [motivo, setMotivo] = useState('');
  const [aviso, setAviso] = useState('');
  const [enviando, setEnviando] = useState(false);
  const cabecalho = titulo ?? (alvoTipo === 'CLIENTE' ? 'Primeira origem do cliente' : alvoTipo === 'FECHAMENTO' ? 'Origem desta negociação' : 'Origem do contato');

  if (carregando && !dados) return <div className={styles.muted} role="status">Carregando origem…</div>;
  if (falha) return falha.codigo === 'MARKETING_INDISPONIVEL' ? null : <p className={styles.muted}>Origem indisponível: {falha.mensagem}</p>;
  if (!dados) return null;
  const v = dados.vigente;

  function abrir() {
    setOrigem(v && v.origemCodigo !== 'DESCONHECIDA' ? v.origemCodigo : ''); setCanal(v?.canalAtendimento ?? ''); setCampanhaId(v?.campanhaId ?? '');
    setDetalhe(v?.detalhe ?? ''); setMotivo(''); setAviso(''); setEditando(true);
  }
  async function salvar(e: React.FormEvent) {
    e.preventDefault();
    if (!origem) { setAviso('Escolha a origem.'); return; }
    setEnviando(true); setAviso('');
    try {
      await enviarMarketing('/api/admin/marketing/atribuicoes', {
        alvoTipo, alvoId, origemCodigo: origem, canalAtendimento: canal || null, campanhaId: campanhaId || null, detalhe: detalhe || null,
        ...(v ? { corrigeId: v.id, motivo } : {}),
      });
      setEditando(false); recarregar();
    } catch (erro) { setAviso(erro instanceof Error ? erro.message : 'Não foi possível salvar.'); }
    finally { setEnviando(false); }
  }

  return <section aria-label={cabecalho} className={styles.cartao} style={{ marginBottom: 0 }}>
    <h3 style={{ marginTop: 0 }}>{cabecalho}</h3>
    {v ? <p><strong>{rotulo(v.origemCodigo, dados.origens)}</strong>{v.campanhaNome ? ` · campanha ${v.campanhaNome}` : ''}{v.detalhe ? ` · ${v.detalhe}` : ''}
      <br /><span className={styles.muted}>{METODO[v.metodo] ?? v.metodo} · {dataHoraBr(v.registradoEm)}{v.registradoPorNome ? ` · ${v.registradoPorNome}` : ''}</span></p>
      : <p className={styles.muted}>Não registrada. {alvoTipo === 'CLIENTE' ? 'Sem evidência, a origem fica desconhecida (nada é presumido).' : 'Informe como este contato chegou.'}</p>}
    {!editando && <button type="button" className={styles.secundario} onClick={abrir}>{v ? 'Corrigir origem' : 'Informar origem'}</button>}
    {editando && <form onSubmit={salvar} className={styles.editor} style={{ marginTop: 12 }}>
      <div className={styles.grade2}>
        <label className={styles.campo}>Origem<select value={origem} onChange={(e) => setOrigem(e.target.value)} required>
          <option value="">Escolha…</option>{dados.origens.filter((o) => o.ativa || o.codigo === origem).map((o) => <option key={o.codigo} value={o.codigo}>{o.rotulo}</option>)}
        </select></label>
        <label className={styles.campo}>Canal de atendimento<select value={canal} onChange={(e) => setCanal(e.target.value)}>{CANAIS.map(([c, r]) => <option key={c} value={c}>{r}</option>)}</select></label>
        {dados.campanhas.length > 0 && <label className={styles.campo}>Campanha (opcional)<select value={campanhaId} onChange={(e) => setCampanhaId(e.target.value)}>
          <option value="">Nenhuma</option>{dados.campanhas.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</select></label>}
        <label className={styles.campo}>Detalhe (indicador, parceiro…)<input maxLength={200} value={detalhe} onChange={(e) => setDetalhe(e.target.value)} /></label>
      </div>
      {v && <label className={styles.campo}>Motivo da correção (fica no histórico)<input required minLength={3} maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} /></label>}
      {aviso && <p className={styles.erro} role="alert">{aviso}</p>}
      <div className={styles.acoes}><button type="button" className={styles.fantasma} onClick={() => setEditando(false)} disabled={enviando}>Cancelar</button>
        <button type="submit" className={styles.secundario} disabled={enviando}>{enviando ? 'Salvando…' : 'Salvar origem'}</button></div>
    </form>}
    {dados.historico.length > 1 && <details className={styles.definicoes} style={{ marginTop: 12 }}><summary>Histórico ({dados.historico.length})</summary>
      <ul className={styles.historico}>{dados.historico.map((a) => <li key={a.id} data-vigente={a.vigente}>
        {rotulo(a.origemCodigo, dados.origens)}{a.campanhaNome ? ` · ${a.campanhaNome}` : ''} — {METODO[a.metodo] ?? a.metodo}, {dataHoraBr(a.registradoEm)}
        {a.motivo ? ` · motivo: ${a.motivo}` : ''}{a.vigente ? ' · vigente' : ''}</li>)}</ul></details>}
  </section>;
}
