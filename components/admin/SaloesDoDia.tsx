'use client';

import { useEffect, useState } from 'react';
import type { SalaoNoDia } from '@/lib/agenda/saloes-do-dia';
import { adminFetch } from '@/lib/http/admin-fetch';

/**
 * 098 (fase 1 dos salões): ocupação do dia por salão na agenda. O combinado reservado marca os salões dele (A+B ocupado
 * marca A e B); um salão reservado marca o combinado. A regra é a do banco (lib/agenda/saloes-do-dia.ts).
 */
type Classes = { painel: string; lista: string; livre: string; ocupado: string };

export function SaloesDoDia({ data, unidadeId, classes }: { data: string; unidadeId: string; classes: Classes }) {
  // Os dados ficam presos à chave dia/unidade de que vieram: ao trocar de dia ou unidade, a lista anterior nunca aparece
  // como se fosse a nova enquanto a busca não volta (P3 da conferência final do Astra).
  const chave = `${data}|${unidadeId}`;
  const [resultado, setResultado] = useState<{ chave: string; saloes: SalaoNoDia[] } | null>(null);

  useEffect(() => {
    let ativo = true;
    const parametros = new URLSearchParams({ data });
    if (unidadeId) parametros.set('unidadeId', unidadeId);
    adminFetch(`/api/admin/agenda/saloes-do-dia?${parametros}`, { cache: 'no-store' })
      .then(async (r) => (r.ok ? ((await r.json()).data?.saloes as SalaoNoDia[]) : []))
      .catch(() => [] as SalaoNoDia[])
      .then((lista) => { if (ativo) setResultado({ chave: `${data}|${unidadeId}`, saloes: lista ?? [] }); });
    return () => { ativo = false; };
  }, [data, unidadeId]);

  if (resultado && resultado.chave !== chave) {
    return <div className={classes.painel} data-saloes-do-dia data-carregando><h3>Salões neste dia</h3><p>Carregando os salões deste dia…</p></div>;
  }
  const saloes = resultado?.saloes ?? null;
  if (!saloes || saloes.length === 0) return null;
  return <div className={classes.painel} data-saloes-do-dia>
    <h3>Salões neste dia</h3>
    <div className={classes.lista}>
      {saloes.map((s) => <div key={s.id} className={s.ocupacoes.length || !s.elegivel ? classes.ocupado : classes.livre} data-salao-dia={s.nome}
        data-ocupado={s.ocupacoes.length > 0} data-elegivel={s.elegivel}>
        <span>{s.nome}{s.combinado && s.membros.length ? ` (${s.membros.join(' + ')})` : ''}</span>
        <b>{!s.elegivel && s.ocupacoes.length === 0
          ? `× Indisponível: ${s.membrosInativos.length ? `${s.membrosInativos.join(', ')} desativado` : 'salão desativado'}`
          : s.ocupacoes.length === 0
          ? '✓ Livre'
          : s.ocupacoes.map((o) => `${o.inicio}–${o.fim}${o.reservadoEm && o.reservadoEm !== s.nome ? ` · ${o.reservadoEm}` : ''}${o.reservadoEm ? '' : ' · sem salão'}${o.remarcacao ? ' · remarcação' : ''}`).join('; ')}</b>
      </div>)}
    </div>
  </div>;
}
