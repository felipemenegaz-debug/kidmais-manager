/**
 * Rodada 42: rótulo do ambiente nas telas do atendimento ("Demo r42 · modo regras locais"), só quando o servidor define
 * ATENDIMENTO_AMBIENTE_ROTULO (demonstrações e homologação). Sem a variável, nada aparece (produção não muda).
 * Texto curto e sem caracteres de controle; nunca vem do cliente.
 */
export function rotuloAmbiente(valor: string | undefined = process.env.ATENDIMENTO_AMBIENTE_ROTULO): string | null {
  const t = String(valor ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 80) : null;
}
