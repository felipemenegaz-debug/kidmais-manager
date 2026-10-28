'use client';
import Link from 'next/link';
import type { ComponentProps, MouseEvent } from 'react';
import { abaPrecisaPerguntar, cliqueComum } from './protegerSaida';

/**
 * Aba de Importar documentos: com alteração não salva no modelo de contrato, a tela pergunta "Ficar | Sair sem salvar"
 * antes de trocar de aba. data-sem-protecao evita a segunda pergunta pela captura de cliques da própria tela.
 */
export default function AbaDocumento({ href, ...props }: ComponentProps<typeof Link> & { href: string }) {
  function aoClicar(e: MouseEvent<HTMLAnchorElement>) {
    if (cliqueComum(e) && abaPrecisaPerguntar(href)) e.preventDefault();
  }
  return <Link href={href} data-sem-protecao onClick={aoClicar} {...props} />;
}
