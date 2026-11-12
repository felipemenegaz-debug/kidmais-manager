'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { EstadoTarefa, PainelRetornos, TarefaRetorno } from '@/lib/satisfacao/tarefas';
import { dataBr, dataHoraBr } from '@/lib/marketing/apresentacao';
import { enviarMarketing } from '../marketing/comum';
import styles from '../marketing/marketing.module.css';
import proprio from './satisfacao.module.css';
import { mensagemDaFalha, podeRepetir, recusada, useLeituraViva } from './leitura';

/**
 * Satisfação › Retornos (PS-4 R5; tela que a D-PS3-3 deixou para a PS-4). Fila de quem tem TRATAR (Gestão: todas as
 * unidades e as sem unidade; Equipe: as unidades concedidas), carregada direto da API da pesquisa — sem capacidades de
 * Marketing e sem depender da regra. Contrato de TRATAMENTO da PS-3: nome completo e atalho ao cadastro (que segue as
 * permissões do CRM). Indicadores de reserva ("sem responsável", "sem unidade") só para a Gestão. Estado no servidor,
 * antes do limite; "Ver mais" pelo cursor. `?tarefa=` só realça se a tarefa estiver na página carregada.
 */
export default function RetornosPagina() {
  const busca = useSearchParams();
  const destaque = busca.get('tarefa');
  const [estado, setEstado] = useState<EstadoTarefa>(busca.get('estado') === 'CONCLUIDA' ? 'CONCLUIDA' : 'ABERTA');
  const [unidadeId, setUnidadeId] = useState('');
  const url = useMemo(() => `/api/admin/satisfacao/tarefas?estado=${estado}${unidadeId ? `&unidadeId=${unidadeId}` : ''}`, [estado, unidadeId]);
  const { paginas, falha, carregando, anexando, verMais, recarregar } = useLeituraViva<PainelRetornos>(url);
  const dados = paginas[0] ?? null;
  const itens: TarefaRetorno[] = paginas.flatMap((p) => p.tarefas);
  const proximo = paginas.length > 0 ? paginas[paginas.length - 1].proximo : null;
  const [observacoes, setObservacoes] = useState<Record<string, string>>({});
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  useEffect(() => {
    if (!destaque || !itens.some((t) => t.id === destaque)) return;
    document.querySelector(`[data-tarefa="${CSS.escape(destaque)}"]`)?.scrollIntoView({ block: 'center' });
  }, [destaque, itens]);

  async function concluir(id: string) {
    setOcupado(id); setAviso(null);
    try {
      await enviarMarketing(`/api/admin/satisfacao/tarefas/${id}/concluir`, { observacao: observacoes[id]?.trim() || null });
      setAviso({ tipo: 'ok', texto: 'Retorno registrado.' });
      recarregar();
    } catch (e) { setAviso({ tipo: 'erro', texto: e instanceof Error ? e.message : 'Não foi possível concluir.' }); }
    finally { setOcupado(null); }
  }
  const semResponsavel = dados?.gestao ? dados.unidades.filter((u) => u.semResponsavel && u.abertas > 0) : [];
  return <div className={styles.pagina} data-retornos-notas-baixas>
    <header className={styles.topo}><div><h1>Retornos de notas baixas</h1><p>Clientes que deram nota de 0 a 6 na pesquisa de satisfação. Entre em contato e registre o retorno.</p></div></header>
    <div className={proprio.abas} role="group" aria-label="Estado dos retornos">
      {(['ABERTA', 'CONCLUIDA'] as const).map((e) => <button key={e} type="button" className={styles.secundario} aria-pressed={estado === e} onClick={() => setEstado(e)}>
        {e === 'ABERTA' ? 'Abertos' : 'Concluídos'}{estado === e && dados ? ` (${dados.totalNoEstado})` : ''}</button>)}
    </div>
    {dados && dados.unidades.length > 0 && <div className={styles.filtros}><label>Unidade<select value={unidadeId} onChange={(e) => setUnidadeId(e.target.value)}>
      <option value="">Todas</option>{dados.unidades.map((u) => <option key={u.id} value={u.id}>{u.nome} ({u.abertas})</option>)}</select></label>
      {!unidadeId && (dados.abertasSemUnidade ?? 0) > 0 && <span className={styles.muted}>{dados.abertasSemUnidade} sem unidade.</span>}</div>}
    {semResponsavel.length > 0 && <p className={styles.aviso} role="note">Sem responsável pelos retornos: {semResponsavel.map((u) => u.nome).join(', ')}. Por enquanto a Gestão trata essas unidades.</p>}
    {aviso && <p className={aviso.tipo === 'ok' ? styles.info : styles.aviso} role={aviso.tipo === 'ok' ? 'status' : 'alert'}>{aviso.texto}</p>}
    {carregando && <p role="status" aria-busy="true" className={styles.muted}>Carregando…</p>}
    {falha && (() => { const m = mensagemDaFalha(falha); return <section className={styles.cartao} role="alert" data-sem-acesso={recusada(falha) ? '' : undefined}><h2>{m.titulo}</h2><p>{m.texto}</p>{podeRepetir(falha) && <button type="button" className={styles.secundario} data-tentar-novamente onClick={recarregar}>Tentar novamente</button>}
      {/* PS4-R4-C1: recusa com uma unidade escolhida (ex.: TRATAR dela revogado) — sair do filtro relê o escopo atual. */}
      {recusada(falha) && unidadeId && <button type="button" className={styles.secundario} data-limpar-unidade onClick={() => setUnidadeId('')}>Ver todas as minhas unidades</button>}</section>; })()}
    {dados && <section className={styles.cartao} aria-label={estado === 'ABERTA' ? 'Retornos abertos' : 'Retornos concluídos'}>
      {itens.length === 0 ? <p className={styles.vazio}>{estado === 'ABERTA' ? 'Nenhum retorno pendente.' : 'Nenhum retorno concluído.'}</p>
        : <ul className={proprio.lista}>{itens.map((t) => <li key={t.id} data-tarefa={t.id} data-destaque={t.id === destaque ? '' : undefined}>
          <div className={proprio.linhaTopo}><strong data-nota-faixa="detrator">Nota {t.notaIndicacao}</strong>
            <span>{t.cliente} · festa em {dataBr(t.dataFesta)}{t.unidade ? ` · ${t.unidade}` : ''}</span> <Link href={`/clientes/${t.clienteId}`}>cliente</Link></div>
          {t.comentario && <p className={proprio.comentario}>“{t.comentario}”</p>}
          {t.estado === 'ABERTA' ? <>
            <label className={styles.campo}>Como foi o retorno (opcional)
              <textarea rows={2} maxLength={1000} value={observacoes[t.id] ?? ''} onChange={(e) => setObservacoes({ ...observacoes, [t.id]: e.target.value })} /></label>
            <button type="button" className={styles.secundario} disabled={ocupado !== null} onClick={() => void concluir(t.id)}>{ocupado === t.id ? 'Salvando…' : 'Concluir retorno'}</button>
          </> : <p className={styles.muted}>Concluído em {t.concluidaEm ? dataHoraBr(t.concluidaEm) : '—'}{t.observacao ? ` · ${t.observacao}` : ''}</p>}
        </li>)}</ul>}
      {proximo && <button type="button" className={styles.secundario} disabled={anexando} onClick={() => void verMais(proximo)}>{anexando ? 'Carregando…' : 'Ver mais'}</button>}
    </section>}
  </div>;
}
