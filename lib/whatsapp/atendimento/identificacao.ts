import type { CadastroContato } from './core';

/**
 * Como a tela de Atendimento identifica o contato. Três fontes, sempre rotuladas e nunca misturadas:
 * - número completo (o que o WhatsApp entregou; é o identificador do canal);
 * - nome CADASTRADO: só com um único cliente desta empresa no número; com vários, nenhum é escolhido;
 * - nome de PERFIL do WhatsApp: escrito pela própria pessoa, NÃO verificado; nunca vira "cliente".
 */
export type Identificacao = {
  titulo: string;
  origemTitulo: 'CADASTRO' | 'PERFIL' | 'NUMERO';
  telefone: string;
  cadastro: string;
  perfil: string;
  ambiguo: string | null;
};

/** +55 (61) 90000-0101 para celulares/fixos do Brasil; outros países ficam como +<dígitos>. */
export function formatarTelefone(contato: string) {
  const d = contato.replace(/\D/g, '');
  if (d.startsWith('55') && d.length === 13) return `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.startsWith('55') && d.length === 12) return `+55 (${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`;
  return d ? `+${d}` : '';
}

export const ROTULO_PERFIL = 'nome no WhatsApp, não verificado';

export function identificar(c: { contato: string; nome_perfil: string | null; cadastro: CadastroContato }): Identificacao {
  const telefone = formatarTelefone(c.contato);
  const perfil = c.nome_perfil ? `${c.nome_perfil} (${ROTULO_PERFIL})` : 'Não informado pelo WhatsApp';
  const semCadastro = c.nome_perfil
    ? { titulo: `${c.nome_perfil} (${ROTULO_PERFIL})`, origemTitulo: 'PERFIL' as const }
    : { titulo: telefone, origemTitulo: 'NUMERO' as const };
  if (c.cadastro.situacao === 'UNICO') {
    return { titulo: c.cadastro.nome, origemTitulo: 'CADASTRO', telefone, cadastro: `Cliente cadastrado: ${c.cadastro.nome}`, perfil, ambiguo: null };
  }
  if (c.cadastro.situacao === 'AMBIGUO') {
    const ambiguo = `${c.cadastro.quantidade} clientes cadastrados com este número. Nenhum foi escolhido; confira o cadastro.`;
    return { ...semCadastro, telefone, cadastro: ambiguo, perfil, ambiguo };
  }
  return { ...semCadastro, telefone, cadastro: 'Nenhum cliente cadastrado com este número.', perfil, ambiguo: null };
}
