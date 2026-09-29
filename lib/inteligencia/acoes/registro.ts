import { InteligenciaError } from "../politica.ts";
import type { FerramentaAcao } from "./tipos.ts";

/**
 * Registro de ações (feature ACTIONS). CONFIRM só executa pelo Human Gate; DENY nunca executa.
 *
 * O registro é montado na composição a partir das fábricas de cada feature (pacotes aqui; importação
 * na feature IMPORT). Nenhuma feature futura é importada por este arquivo.
 *
 * Buffet (categorias e itens) é DENY: `buffet_categorias`/`buffet_itens` são catálogo global e a
 * própria rota /api/admin/configuracoes/catalogo recusa escrita por membership de empresa
 * (`CATALOGO_GLOBAL_SEM_AUTORIDADE`). A IA não pode ter mais autoridade que a tela.
 * Liberar exige decisão do Core (catálogo por empresa, com migration própria).
 */
const MENSAGEM_BUFFET = "Categorias e itens do Buffet são um catálogo global do Kidmais. Hoje nenhuma empresa pode alterá-lo, nem pela tela nem pelo Kidmais Intelligence. Isso depende de o catálogo passar a ser por empresa.";

function negada(capacidade: string, titulo: string, mensagem: string): FerramentaAcao {
  const recusar = (): never => { throw new InteligenciaError("ACAO_NEGADA", mensagem, 403); };
  return {
    nome: `negada.${capacidade}`,
    capacidade,
    classe: "DENY",
    grupo: "ADMIN_ACTIONS",
    papeis: [],
    descricao: mensagem,
    titulo,
    mensagemNegada: mensagem,
    campos: [],
    extrair: () => ({}),
    faltando: () => [],
    validar: recusar,
    verificar: async () => recusar(),
    apresentar: () => [],
    executar: async () => recusar(),
  };
}

/** Pedidos que a IA reconhece e recusa sempre, com explicação humana. */
export function acoesNegadas(): FerramentaAcao[] {
  return [
    negada("criar_categoria_buffet", "Nova categoria do Buffet", MENSAGEM_BUFFET),
    negada("criar_item_buffet", "Novo item do Buffet", MENSAGEM_BUFFET),
    negada("editar_categoria_buffet", "Editar categoria do Buffet", MENSAGEM_BUFFET),
    negada("editar_item_buffet", "Editar item do Buffet", MENSAGEM_BUFFET),
    negada("excluir", "Excluir", "Exclusão definitiva não é feita pelo Kidmais Intelligence. Use a tela correspondente, que confere todos os vínculos antes."),
    negada("mutacao_nao_suportada", "Ação não disponível", "Essa ação ainda não é feita pelo Kidmais. Enviar mensagens, cobrar, registrar pagamento, cancelar ou mudar contratos continua nas telas, com as conferências de cada uma."),
    negada("sql", "Consulta direta ao banco", "O Kidmais Intelligence não executa SQL nem acessa o banco diretamente. Pergunte pelo que você quer saber."),
  ];
}

export type RegistroAcoes = {
  acao(capacidade: string): FerramentaAcao | null;
  todas(): readonly FerramentaAcao[];
};

/** Registro fechado a partir da lista montada na composição. Capacidade duplicada é erro de composição. */
export function criarRegistroAcoes(lista: readonly FerramentaAcao[]): RegistroAcoes {
  const mapa = new Map<string, FerramentaAcao>();
  for (const acao of lista) {
    if (mapa.has(acao.capacidade)) throw new Error(`Capacidade de ação duplicada: ${acao.capacidade}`);
    mapa.set(acao.capacidade, acao);
  }
  const todas = Object.freeze([...mapa.values()]);
  return { acao: (capacidade) => mapa.get(capacidade) ?? null, todas: () => todas };
}
