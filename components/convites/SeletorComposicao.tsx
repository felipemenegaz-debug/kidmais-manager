'use client';
import type { Conteudo } from '@/lib/convites/domain';
import { aplicarComposicao, composicaoAtual, rotulosComposicao, type Composicao } from './composicao';

/** Controle único de composição, usado sob a prévia e em "Personalizar cores" para não divergirem. */
export default function SeletorComposicao({ conteudo, opcoes, busy, className, mudar }: {
  conteudo: Conteudo; opcoes: Composicao[]; busy: boolean; className?: string; mudar: (visual: Conteudo['visual']) => void;
}) {
  if (!opcoes.length) return null;
  const atual = composicaoAtual(conteudo);
  return <div className={className} role="group" aria-label="Posição da imagem">
    {opcoes.map(opcao => <button key={opcao} type="button" disabled={busy} aria-pressed={atual === opcao} onClick={() => mudar(aplicarComposicao(conteudo, opcao).visual)}>{rotulosComposicao[opcao]}</button>)}
  </div>;
}
