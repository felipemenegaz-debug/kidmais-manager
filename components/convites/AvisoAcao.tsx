'use client';
import { useEffect, useRef } from 'react';

// Retornos curtos de sucesso que somem sozinhos. Avisos que pedem ação, erros e o estado da geração ficam até a pessoa fechar.
export const AVISOS_TEMPORARIOS = new Set([
  'Link copiado.',
  'Rascunho salvo.',
  'Convite publicado. Agora você pode compartilhar.',
  'Convite despublicado.',
  'Limites atualizados.',
  'Confirmações atualizadas. Suas alterações no editor foram preservadas.',
]);
export const TEMPO_AVISO_TEMPORARIO_MS = 8000;

type Props = {
  erro: string;
  aviso: string;
  // Texto mostrado quando não há aviso, mas a geração anterior ainda está sendo verificada.
  avisoPadrao?: string;
  // false quando outro bloco já anuncia o mesmo estado (ex.: o progresso da geração), para o leitor de tela não ouvir duas vezes.
  anunciar: boolean;
  podeFechar: boolean;
  onFechar: () => void;
  classes: { caixa: string; erro: string; aviso: string; fechar: string };
};

// Aviso fixo no rodapé com o retorno das ações.
// Ao fechar, o foco volta para o controle que disparou a ação (ou para o título do editor), em vez de cair no fim da página.
export function AvisoAcao({ erro, aviso, avisoPadrao, anunciar, podeFechar, onFechar, classes }: Props) {
  const caixa = useRef<HTMLDivElement>(null);
  const origem = useRef<HTMLElement | null>(null);
  const ultimoFoco = useRef<HTMLElement | null>(null);
  const mensagem = erro || aviso;

  // Último controle focado fora do aviso. Botões desabilitados durante a ação (Salvar, Publicar) perdem o foco para o body,
  // então o foco atual na hora da mensagem nem sempre diz quem disparou a ação.
  useEffect(() => {
    const guardar = (e: FocusEvent) => {
      const el = e.target;
      if (el instanceof HTMLElement && el !== document.body && !caixa.current?.contains(el)) ultimoFoco.current = el;
    };
    document.addEventListener('focusin', guardar);
    return () => document.removeEventListener('focusin', guardar);
  }, []);

  // Guarda quem disparou a ação quando a mensagem aparece; sem mensagem, esquece.
  useEffect(() => {
    if (!mensagem) { origem.current = null; return; }
    const ativo = document.activeElement;
    const valido = ativo instanceof HTMLElement && ativo !== document.body && !caixa.current?.contains(ativo);
    origem.current = valido ? ativo : ultimoFoco.current;
  }, [mensagem]);

  function devolverFoco() {
    const alvo = origem.current;
    origem.current = null;
    requestAnimationFrame(() => {
      if (alvo?.isConnected && !(alvo as HTMLButtonElement).disabled && alvo.getClientRects().length > 0) { alvo.focus(); return; }
      const titulo = document.querySelector<HTMLElement>('[data-editor] h1');
      if (!titulo) return;
      if (!titulo.hasAttribute('tabindex')) titulo.setAttribute('tabindex', '-1');
      titulo.focus({ preventScroll: true });
    });
  }

  function fechar() {
    const focoDentro = !!caixa.current?.contains(document.activeElement);
    onFechar();
    if (focoDentro) devolverFoco();
  }
  const fecharRef = useRef(fechar);
  useEffect(() => { fecharRef.current = fechar; });

  // Sucesso curto some sozinho; pausa enquanto o mouse ou o foco estão no aviso.
  const temporario = !erro && AVISOS_TEMPORARIOS.has(aviso);
  useEffect(() => {
    if (!temporario) return;
    const el = caixa.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const iniciar = () => { clearTimeout(timer); timer = setTimeout(() => fecharRef.current(), TEMPO_AVISO_TEMPORARIO_MS); };
    const pausar = () => clearTimeout(timer);
    const retomar = () => { if (!el?.matches(':hover') && !el?.contains(document.activeElement)) iniciar(); };
    iniciar();
    el?.addEventListener('mouseenter', pausar); el?.addEventListener('focusin', pausar);
    el?.addEventListener('mouseleave', retomar); el?.addEventListener('focusout', retomar);
    return () => {
      clearTimeout(timer);
      el?.removeEventListener('mouseenter', pausar); el?.removeEventListener('focusin', pausar);
      el?.removeEventListener('mouseleave', retomar); el?.removeEventListener('focusout', retomar);
    };
  }, [temporario, aviso]);

  const textoAviso = aviso || avisoPadrao;
  if (!erro && !textoAviso) return null;
  return <div ref={caixa} className={classes.caixa} data-mensagens-acao data-temporario={temporario || undefined}>
    <div>
      {erro && <p className={classes.erro} role="alert">{erro}</p>}
      {textoAviso && <p className={classes.aviso} role={anunciar ? 'status' : undefined}>{textoAviso}</p>}
    </div>
    {podeFechar && mensagem && <button type="button" className={classes.fechar} aria-label="Fechar aviso" onClick={fechar}><span aria-hidden="true">×</span></button>}
  </div>;
}
