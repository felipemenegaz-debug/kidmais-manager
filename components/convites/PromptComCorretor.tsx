'use client';
import { useEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';
import { palavraNoPrompt, substituirPalavra } from '@/lib/convites/palavra-prompt';
import ui from './corretor-prompt.module.css';

type Menu = NonNullable<ReturnType<typeof palavraNoPrompt>> & { id: number; x: number; y: number; carregando: boolean; correta?: boolean; sugestoes: string[]; erro?: string };
type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> & { value: string; habilitado: boolean; corrigir: (texto: string) => void };

export default function PromptComCorretor({ habilitado, corrigir, ...props }: Props) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const caixa = useRef<HTMLDivElement>(null);
  const worker = useRef<Worker | null>(null);
  const sequencia = useRef(0);
  const selecao = useRef<{ inicio: number; fim: number } | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  useEffect(() => {
    if (!menu) return;
    const fechar = (e: PointerEvent) => { if (!caixa.current?.contains(e.target as Node)) setMenu(null); };
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(null); area.current?.focus(); } };
    document.addEventListener('pointerdown', fechar);
    document.addEventListener('keydown', tecla);
    window.addEventListener('scroll', fecharMenu, true);
    window.addEventListener('resize', fecharMenu);
    function fecharMenu() { setMenu(null); }
    return () => {
      document.removeEventListener('pointerdown', fechar);
      document.removeEventListener('keydown', tecla);
      window.removeEventListener('scroll', fecharMenu, true);
      window.removeEventListener('resize', fecharMenu);
    };
  }, [menu]);
  useEffect(() => { if (menu && !menu.carregando) caixa.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [menu]);
  return <>
    <textarea {...props} ref={area} onChange={e => { setMenu(null); props.onChange?.(e); }} onPointerDown={e => {
      selecao.current = e.button === 2 && e.currentTarget.selectionEnd > e.currentTarget.selectionStart
        ? { inicio: e.currentTarget.selectionStart, fim: e.currentTarget.selectionEnd } : null;
    }} onContextMenu={e => {
      if (!habilitado || props.disabled) return;
      const trecho = palavraNoPrompt(props.value, selecao.current?.inicio ?? e.currentTarget.selectionStart, selecao.current?.fim ?? e.currentTarget.selectionEnd);
      selecao.current = null;
      if (!trecho || trecho.palavra.length > 48) return;
      e.preventDefault();
      e.currentTarget.setSelectionRange(trecho.inicio, trecho.fim);
      const id = ++sequencia.current;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = Math.max(8, Math.min(e.clientX || rect.left, window.innerWidth - 288));
      const y = Math.max(8, Math.min(e.clientY || rect.top, window.innerHeight - 340));
      setMenu({ ...trecho, id, x, y, carregando: true, sugestoes: [] });
      try {
        if (!worker.current) {
          worker.current = new Worker(new URL('./corretor-prompt.worker.ts', import.meta.url));
          worker.current.onmessage = evento => setMenu(atual => atual?.id === evento.data.id ? { ...atual, ...evento.data, carregando: false } : atual);
          worker.current.onerror = () => { setMenu(atual => atual ? { ...atual, carregando: false, erro: 'Corretor indisponível. Tente novamente.' } : null); worker.current?.terminate(); worker.current = null; };
        }
        worker.current.postMessage({ id, palavra: trecho.palavra });
      } catch { setMenu(atual => atual ? { ...atual, carregando: false, erro: 'Corretor indisponível. Tente novamente.' } : null); }
    }} />
    {menu && <div ref={caixa} className={ui.menu} style={{ left: menu.x, top: menu.y }} role="dialog" aria-label={`Correção de ${menu.palavra}`} onKeyDown={e => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); const itens = Array.from(caixa.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      const atual = itens.indexOf(document.activeElement as HTMLButtonElement);
      const indice = e.key === 'Home' ? 0 : e.key === 'End' ? itens.length - 1 : (atual + (e.key === 'ArrowDown' ? 1 : -1) + itens.length) % itens.length;
      itens[indice]?.focus();
    }}>
      <strong>Correção · {menu.palavra}</strong>
      <p role="status">{menu.carregando ? 'Buscando sugestões…' : menu.erro || (menu.sugestoes.length ? menu.correta ? 'Outras grafias no dicionário:' : 'Escolha a grafia:' : menu.correta ? 'Palavra reconhecida pelo dicionário.' : 'Sem sugestões. Pode ser um nome ou termo específico.')}</p>
      {menu.sugestoes.map(sugestao => <button type="button" key={sugestao} onClick={() => {
        const texto = substituirPalavra(props.value, menu, sugestao);
        corrigir(texto); setMenu(null); area.current?.focus();
      }}>{sugestao}</button>)}
      <button type="button" className={ui.manter} onClick={() => { setMenu(null); area.current?.focus(); }}>Manter palavra</button>
    </div>}
  </>;
}
