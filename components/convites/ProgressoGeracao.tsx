'use client';
import { useEffect, useState } from 'react';
import { faseGeracao, formatarDuracao, LIMITE_PROVEDOR_SEGUNDOS, TEXTO_FASE } from '@/lib/convites/progresso-geracao';

// Indicador da geração em curso: etapas reais, tempo decorrido e o prazo do provedor. Sem porcentagem.
// Só a mudança de fase é anunciada (role="status"); o relógio não é lido a cada segundo.
export function ProgressoGeracao({ inicio, ui }: { inicio: number | null; ui: Record<string, string> }) {
  const [segundos, setSegundos] = useState(0);
  useEffect(() => {
    if (inicio === null) return;
    const tique = setInterval(() => setSegundos(Math.max(0, Math.floor((Date.now() - inicio) / 1000))), 1000);
    return () => clearInterval(tique);
  }, [inicio]);
  const decorridos = inicio === null ? null : segundos;
  const fase = faseGeracao(decorridos);
  const etapa = (atual: boolean, feita: boolean) => ({ 'aria-current': atual ? 'step' as const : undefined, 'data-etapa': feita ? 'feita' : atual ? 'atual' : 'futura' });
  return <div className={ui.progressoGeracao} data-progresso-geracao data-fase={fase}>
    <span className={ui.indicadorGeracao} aria-hidden="true"><i /><i /><i /></span>
    <ol aria-label="Etapas da geração">
      <li {...etapa(false, true)}>Pedido enviado</li>
      <li {...etapa(fase !== 'conferindo', fase === 'conferindo')}>Criando a arte</li>
      <li {...etapa(fase === 'conferindo', false)}>Conferindo e salvando nas imagens da festa</li>
    </ol>
    <p role="status">{TEXTO_FASE[fase]}</p>
    {decorridos !== null && <p className={ui.tempoGeracao} aria-hidden="true">
      {formatarDuracao(decorridos)}{fase === 'criando' ? ` de até ${formatarDuracao(LIMITE_PROVEDOR_SEGUNDOS)}` : ''}
    </p>}
  </div>;
}
