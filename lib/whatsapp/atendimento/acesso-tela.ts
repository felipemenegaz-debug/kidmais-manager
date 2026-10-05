/**
 * Recusa de acesso à tela de Atendimento → o que a pessoa vê. Três situações diferentes, cada uma com o que dá para
 * fazer: a empresa ativa é outra (trocar), nenhuma empresa ativa foi selecionada (selecionar) ou não há acesso
 * (pedir liberação). Nenhuma delas mostra dados da empresa piloto.
 */
export type TipoBloqueio = 'EMPRESA_DIVERGENTE' | 'EMPRESA_NAO_SELECIONADA' | 'SEM_ACESSO';
export type BloqueioAtendimento = { tipo: TipoBloqueio; titulo: string; orientacao: string };

const BLOQUEIOS: Record<TipoBloqueio, BloqueioAtendimento> = {
  EMPRESA_DIVERGENTE: {
    tipo: 'EMPRESA_DIVERGENTE',
    titulo: 'A empresa ativa é outra',
    orientacao: 'O Atendimento WhatsApp pertence a outra empresa. Troque a empresa ativa no menu para usá-lo.',
  },
  EMPRESA_NAO_SELECIONADA: {
    tipo: 'EMPRESA_NAO_SELECIONADA',
    titulo: 'Selecione a empresa ativa',
    orientacao: 'Nenhuma empresa está ativa nesta sessão. Selecione a empresa no menu para abrir o Atendimento WhatsApp.',
  },
  SEM_ACESSO: {
    tipo: 'SEM_ACESSO',
    titulo: 'Sem acesso ao Atendimento WhatsApp',
    orientacao: 'Seu acesso nesta empresa não inclui o Atendimento WhatsApp. Peça a liberação a quem administra a empresa.',
  },
};

const POR_CODIGO: Record<string, TipoBloqueio> = {
  ATENDIMENTO_EMPRESA_DIVERGENTE: 'EMPRESA_DIVERGENTE',
  ATENDIMENTO_EMPRESA_NAO_SELECIONADA: 'EMPRESA_NAO_SELECIONADA',
  ATENDIMENTO_SEM_ACESSO: 'SEM_ACESSO',
  ATENDIMENTO_ACESSO_NEGADO: 'SEM_ACESSO',
};

/** Só para o carregamento da tela; nas ações (assumir, configurar…) a recusa continua como mensagem da ação. */
export function bloqueioDoCodigo(codigo: unknown): BloqueioAtendimento | null {
  const tipo = typeof codigo === 'string' ? POR_CODIGO[codigo] : undefined;
  return tipo ? BLOQUEIOS[tipo] : null;
}
