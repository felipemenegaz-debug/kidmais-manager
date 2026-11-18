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
 * Motivo do botão de gerar estar desabilitado por saldo ou limite, para o buffet (motor de créditos ou franquia antiga) e para o
 * cliente da festa. Nunca no laboratório local ou com geração deste convite em curso, inclusive a de resultado incerto.
 * Alterar o limite é da gestão (service.ts, ação "cotas"), e o editor não conhece o papel: o texto serve aos dois.
 */
export function avisoSemGeracao({ disponiveis, creditos, laboratorio = false, geracaoEmCurso = false, avulso = false, cliente = false, cotas }: { disponiveis: number; creditos: CreditosNaTela; laboratorio?: boolean; geracaoEmCurso?: boolean; avulso?: boolean; cliente?: boolean; cotas?: { festa: number; festaUsado: number } }) {
  if (laboratorio || geracaoEmCurso || disponiveis >= 1) return null;
  // Cliente da festa (link de edição): não vê saldo nem limites do buffet; só sabe que acabou e o que fazer.
  if (cliente) return 'As gerações com IA deste convite acabaram. Peça mais ao buffet ou envie uma imagem sua.';
  const noLimite = `Este convite atingiu o limite de gerações. A gestão da conta pode aumentar o limite em “${avulso ? 'Limite deste convite' : 'Edição pelo cliente'}”.`;
  // Motor antigo (franquia mensal): o limite do convite acabou, ou a franquia da empresa foi toda usada.
  if (creditos?.motor === 'LEGADO') return cotas && cotas.festa - cotas.festaUsado < 1 ? noLimite
    : 'A franquia mensal de imagens da empresa foi toda usada. Você pode seguir sem IA: envie uma imagem sua.';
  if (creditos?.motor !== 'CREDITOS') return null;
  // Em manutenção o servidor recusa a geração com qualquer saldo: ajustar limite ou saldo não resolveria.
  if (!creditos.consumoAtivo) return 'A geração com créditos está em manutenção. Você pode seguir sem IA: modelos, upload e download continuam disponíveis.';
  if (creditos.disponivel >= 1) return noLimite;
  return creditos.reservado > 0
    ? 'A empresa não tem créditos disponíveis agora. Há créditos reservados. Veja o saldo em IA e créditos.'
    : 'A empresa está sem créditos disponíveis. Veja o saldo em IA e créditos.';
}
