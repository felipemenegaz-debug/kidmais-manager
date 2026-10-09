'use client';
import type { Conteudo } from '@/lib/convites/domain';
import { temaVisual, tintaLegivel, visualPadrao } from '@/lib/convites/visual';

type Visual = NonNullable<Conteudo['visual']>;
export default function ConviteVisual({ conteudo, arte, ui, busy, mudar, extrair }: {
  conteudo: Conteudo; arte?: string; ui: Record<string, string>; busy: boolean;
  mudar: (visual: Visual) => void; extrair: () => void;
}) {
  const visual: Visual = conteudo.visual ?? visualPadrao, tema = temaVisual(conteudo);
  return <div className={ui.ajustesVisual}>
    {arte && <>
      <p><strong>Como usar esta imagem</strong></p>
      <div className={ui.acoes} role="group" aria-label="Modo da imagem">
        <button type="button" aria-pressed={visual.modo === 'modelo'} onClick={() => mudar({ ...visual, modo: 'modelo' })}>Imagem + textos do editor</button>
        <button type="button" aria-pressed={visual.modo === 'completa'} onClick={() => mudar({ ...visual, modo: 'completa' })}>Arte completa</button>
      </div>
      <small>{visual.modo === 'completa' ? 'Para convites que já têm nome, data e endereço na imagem. Os textos do editor não serão repetidos na arte. Mantenha os dados atualizados para o mapa e a confirmação.' : 'A imagem aparece na capa. Os dados da festa ficam abaixo.'}</small>
      <div className={ui.acoes} role="group" aria-label="Enquadramento da imagem">
        <button type="button" aria-pressed={visual.ajuste === 'conter'} onClick={() => mudar({ ...visual, ajuste: 'conter', x: 50, y: 50 })}>Mostrar imagem inteira</button>
        <button type="button" aria-pressed={visual.ajuste === 'preencher'} onClick={() => mudar({ ...visual, ajuste: 'preencher' })}>Preencher e recortar</button>
      </div>
      {visual.ajuste === 'preencher' && <>
        <small>Confira se nenhum texto importante ficou fora da imagem. O arquivo original é preservado.</small>
        <label>Posição horizontal · {visual.x}%<input type="range" min={0} max={100} value={visual.x} onChange={e => mudar({ ...visual, x: Number(e.target.value) })} /></label>
        <label>Posição vertical · {visual.y}%<input type="range" min={0} max={100} value={visual.y} onChange={e => mudar({ ...visual, y: Number(e.target.value) })} /></label>
        <button type="button" onClick={() => mudar({ ...visual, x: 50, y: 50 })}>Centralizar imagem</button>
      </>}
    </>}
    <p><strong>Cores do convite e da página pública</strong></p>
    <div className={ui.acoes}>
      <button type="button" disabled={busy || !arte} onClick={extrair}>Usar cores da imagem</button>
      <button type="button" disabled={!visual.cores} onClick={() => { const { cores: _cores, ...padrao } = visual; void _cores; mudar(padrao); }}>Restaurar cores do tema</button>
    </div>
    <div className={ui.cores}>
      {([['fundo', 'Fundo'], ['destaque', 'Destaque'], ['tinta', 'Texto']] as const).map(([campo, label]) => <label key={campo}>{label}<input type="color" aria-label={`Cor: ${label}`} value={visual.cores?.[campo] ?? tema[campo]} onChange={e => mudar({ ...visual, cores: { fundo: tema.fundo, tinta: tema.tinta, destaque: tema.destaque, ...visual.cores, [campo]: e.target.value } })} /></label>)}
    </div>
    {visual.cores && tema.tinta !== visual.cores.tinta && <small>O texto foi ajustado automaticamente para manter a leitura sobre o fundo escolhido.</small>}
    <div className={ui.amostraCores} style={{ background: tema.fundo, color: tema.tinta, borderColor: tema.destaque }} aria-label="Prévia das cores da página pública"><strong>Vamos celebrar juntos.</strong><span style={{ background: visual.cores ? tema.destaque : tema.tinta, color: visual.cores ? tintaLegivel(tema.destaque) : tema.fundo }}>Confirmar presença</span></div>
    <small>Ajustar imagem e cores não consome créditos. Salve ou publique para aplicar.</small>
  </div>;
}
