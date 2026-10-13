'use client';
import type { Conteudo } from '@/lib/convites/domain';
import { temaVisual, tintaLegivel, visualPadrao } from '@/lib/convites/visual';
import { modeloComFoto } from '@/lib/convites/modelos';

type Visual = NonNullable<Conteudo['visual']>;
export default function ConviteVisual({ conteudo, arte, ui, busy, mudar, extrair, mostrarPosicao = true }: {
  conteudo: Conteudo; arte?: string; ui: Record<string, string>; busy: boolean;
  mudar: (visual: Visual) => void; extrair: () => void; mostrarPosicao?: boolean;
}) {
  const visual: Visual = conteudo.visual ?? visualPadrao, tema = temaVisual(conteudo);
  return <>
    {mostrarPosicao && arte && !modeloComFoto(conteudo.tema) && <div className={ui.posicaoImagem}>
      <p>Posição da imagem</p>
      <div className={ui.acoes}>
        {(['fundo', 'topo'] as const).map(posicao => <button key={posicao} type="button" disabled={busy} aria-pressed={(visual.posicao ?? 'fundo') === posicao && visual.modo !== 'completa'} onClick={() => mudar({ ...visual, modo: 'modelo', posicao })}>{posicao === 'fundo' ? 'Imagem como fundo' : 'Imagem no topo'}</button>)}
      </div>
    </div>}
    <details className={ui.ajustesVisual}>
    <summary>Personalizar cores</summary>
    <p>Cores do convite e da página pública</p>
    <div className={ui.acoes}>
      <button type="button" disabled={busy || !arte} onClick={extrair}>Usar cores da imagem</button>
      <button type="button" disabled={!visual.cores} onClick={() => { const { cores: _cores, ...padrao } = visual; void _cores; mudar(padrao); }}>Restaurar cores do tema</button>
    </div>
    <div className={ui.cores}>
      {([['fundo', 'Fundo'], ['destaque', 'Destaque'], ['tinta', 'Texto']] as const).map(([campo, label]) => <label key={campo}>{label}<input type="color" aria-label={`Cor: ${label}`} value={visual.cores?.[campo] ?? tema[campo]} onChange={e => mudar({ ...visual, cores: { fundo: tema.fundo, tinta: tema.tinta, destaque: tema.destaque, ...visual.cores, [campo]: e.target.value } })} /></label>)}
    </div>
    {visual.cores && tema.tinta !== visual.cores.tinta && <small>O texto foi ajustado automaticamente para manter a leitura sobre o fundo escolhido.</small>}
    <div className={ui.amostraCores} style={{ background: tema.fundo, color: tema.tinta, borderColor: tema.destaque }} aria-label="Prévia das cores da página pública"><strong>Vamos celebrar juntos.</strong><span style={{ background: visual.cores ? tema.destaque : tema.tinta, color: visual.cores ? tintaLegivel(tema.destaque) : tema.fundo }}>Confirmar presença</span></div>
    <small>Ajustar as cores não consome créditos. Salve ou publique para aplicar.</small>
  </details></>;
}
