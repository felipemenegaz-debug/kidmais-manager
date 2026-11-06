// Textos de saldo do editor de convites. "disponiveis" é o menor valor entre o que a empresa tem disponível e o limite do convite.
// "disponivel" da empresa já desconta reservas e bloqueios: nunca é o saldo total, e o texto precisa dizer isso.
export type CreditosNaTela = { motor: 'LEGADO' } | { motor: 'CREDITOS'; disponivel: number; reservado: number; consumoAtivo: boolean } | null | undefined;

export const comUnidade = (n: number, um: string, varios: string) => (n === 1 ? um : varios);

export const creditosDisponiveisDaEmpresa = (n: number) => `${comUnidade(n, 'crédito disponível', 'créditos disponíveis')} da empresa`;

export const textoReserva = (n: number) => (n > 0 ? ` (${n} ${comUnidade(n, 'reservado', 'reservados')} em geração)` : '');

/** Sinais de que este convite tem geração em curso, inclusive a de resultado incerto. */
export const geracaoDoConviteEmCurso = (s: { busy: boolean; acompanhando: string; geracaoIncerta?: boolean; geracaoEmAndamento?: string | null }) =>
  s.busy || !!s.acompanhando || !!s.geracaoIncerta || !!s.geracaoEmAndamento;

/**
 * Motivo do botão de gerar estar desabilitado por saldo ou limite. Só no motor de créditos do buffet (quem vê a seção de limites),
 * e nunca no laboratório local ou com geração deste convite em curso, inclusive a de resultado incerto.
 * Alterar o limite é da gestão (service.ts, ação "cotas"), e o editor não conhece o papel: o texto serve aos dois.
 */
export function avisoSemGeracao({ disponiveis, creditos, laboratorio = false, geracaoEmCurso = false }: { disponiveis: number; creditos: CreditosNaTela; laboratorio?: boolean; geracaoEmCurso?: boolean }) {
  if (laboratorio || geracaoEmCurso || disponiveis >= 1 || creditos?.motor !== 'CREDITOS') return null;
  // Em manutenção o servidor recusa a geração com qualquer saldo: ajustar limite ou saldo não resolveria.
  if (!creditos.consumoAtivo) return 'A geração com créditos está em manutenção. Você pode seguir sem IA: modelos, upload e download continuam disponíveis.';
  if (creditos.disponivel >= 1) return 'Este convite atingiu o limite de gerações. Para gerar mais, a gestão da conta pode aumentar o limite em “Acesso do cliente e limites”.';
  return creditos.reservado > 0
    ? 'A empresa não tem créditos disponíveis agora. Há créditos reservados. Veja o saldo em IA e créditos.'
    : 'A empresa está sem créditos disponíveis. Veja o saldo em IA e créditos.';
}
