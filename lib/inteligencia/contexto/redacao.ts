import { OCULTOS_MODELO, PADRAO_NUMERO_LONGO, PADROES_LINK, PADROES_PII } from "../texto-modelo.ts";
import { normalizar } from "../texto-pt.ts";

/**
 * Redação para o Context Builder (CORE): o texto que sai daqui pode ir a um modelo.
 *
 * Conservadora por construção — na dúvida, retira:
 * - dados pessoais por padrão (CPF, CNPJ, e-mail, telefone, uuid, número longo, URL/caminho interno);
 * - nomes próprios por HEURÍSTICA ESTRITA: toda palavra iniciada por maiúscula que não esteja na lista de
 *   vocabulário do sistema vira "[nome]" (inclusive no começo da frase). Falso positivo apenas empobrece o
 *   texto; falso negativo vazaria um nome — por isso a lista é de PERMITIDAS, não de proibidas;
 * - nomes informados explicitamente por quem monta o bloco (`sensiveis`);
 * - caracteres de controle/invisíveis.
 */
// Ocultos e padrões de dado pessoal: os MESMOS da preparação canônica de texto para modelo (texto-modelo.ts).
const OCULTOS = OCULTOS_MODELO;
const PADROES: ReadonlyArray<readonly [RegExp, string]> = [...PADROES_LINK, ...PADROES_PII, PADRAO_NUMERO_LONGO];

/**
 * Vocabulário do sistema que pode aparecer com inicial maiúscula (normalizado, sem acento). Nome de pessoa
 * NUNCA entra aqui. Tudo o que não está na lista e começa com maiúscula é tratado como nome próprio.
 */
const VOCABULARIO = new Set([
  "a", "as", "o", "os", "um", "uma", "uns", "umas", "e", "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas", "para", "por", "com", "sem",
  "ao", "aos", "ate", "sim", "nao", "nenhum", "nenhuma", "todos", "todas", "hoje", "amanha", "ontem", "total", "saldo", "valor", "valores",
  "cliente", "clientes", "festa", "festas", "contrato", "contratos", "pacote", "pacotes", "cadastro", "cadastrado", "completo", "incompleto",
  "proximo", "proxima", "aniversario", "aniversariante", "aniversariantes", "agenda", "evento", "eventos", "convidados", "horario", "data",
  "recebido", "recebidos", "recebimento", "recebimentos", "parcela", "parcelas", "vencimento", "vencida", "vencidas", "vencido", "vencidos",
  "pagamento", "pagamentos", "pago", "pendente", "pendentes", "pendencia", "pendencias", "atrasado", "atrasados", "atraso", "aberto", "em aberto",
  "assinado", "assinada", "assinatura", "assinaturas", "financeiro", "situacao", "status", "ativo", "ativa", "inativo", "checklist", "tarefa",
  "tarefas", "responsavel", "responsaveis", "falta", "faltam", "mes", "semana", "dia", "dias", "anterior", "atual", "comparado", "entrada",
  "entradas", "manual", "manuais", "pix", "cartao", "boleto", "kidmais", "buffet", "item", "itens", "categoria", "categorias", "risco",
  "atencao", "prioridade", "alta", "media", "baixa", "fato", "calculo", "ausencia", "contas", "receber", "pagar", "faixa", "faixas",
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
  "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo", "cpf", "cnpj", "rg", "uf", "r$", "v1", "v2", "v3",
  // Rótulos de campo (o rótulo não é o dado; o valor nunca é lido) e termos financeiros/operacionais.
  "nome", "telefone", "email", "e-mail", "whatsapp", "endereco", "bairro", "cidade", "cep", "complemento", "contato", "contratante",
  "recebivel", "recebiveis", "vence", "vencem", "venceu", "preco", "precos", "tabela", "versao", "versoes", "revisao", "rascunho",
  "sugestao", "informativo", "dados", "numero", "quantidade", "confirmado", "confirmada", "cancelado", "cancelada", "reservado", "credito",
  "cobranca", "cobrancas", "obrigacao", "liquido", "estorno", "estornos", "plano", "cronograma", "devolucao", "fornecedor", "fornecedores",
  // Palavras comuns de início de frase nas respostas determinísticas.
  "veja", "confira", "abra", "ha", "tem", "temos", "existe", "existem", "entre", "desde", "maior", "menor", "ultimo", "ultima", "novo",
  "nova", "este", "esta", "esse", "essa", "isso", "aqui", "outro", "outra", "cada", "apenas", "somente", "ainda", "ja", "mais", "menos",
  "sem dados", "periodo", "comparacao", "resumo", "detalhe", "fonte", "origem", "empresa", "unidade", "equipe", "gestao",
]);

export type Redacao = { texto: string; redacoes: number };

const MAIUSCULA = /^[\p{Lu}]/u;

/** Troca PII, nomes informados e nomes próprios (heurística estrita) por marcadores. */
export function redigir(bruto: string, opcoes: { sensiveis?: readonly string[]; maxCaracteres?: number } = {}): Redacao {
  let redacoes = 0;
  let texto = bruto.normalize("NFKC").replace(OCULTOS, "").replace(/\s+/g, " ").trim();
  for (const nome of opcoes.sensiveis ?? []) {
    const alvo = nome.trim();
    if (alvo.length < 2) continue;
    const partes = texto.split(alvo);
    if (partes.length > 1) {
      redacoes += partes.length - 1;
      texto = partes.join("[nome]");
    }
  }
  for (const [padrao, marcador] of PADROES) {
    texto = texto.replace(padrao, () => {
      redacoes += 1;
      return marcador;
    });
  }
  // Nomes próprios: palavra com inicial maiúscula fora do vocabulário ⇒ [nome]; sequências viram um só marcador.
  const palavras = texto.split(/(\s+)/);
  const saida: string[] = [];
  let ultimoFoiNome = false;
  for (const pedaco of palavras) {
    if (/^\s+$/.test(pedaco) || pedaco === "") {
      saida.push(pedaco);
      continue;
    }
    // Moeda ("R$", "R$1.000") não é nome.
    if (/^\(?R\$/.test(pedaco)) {
      ultimoFoiNome = false;
      saida.push(pedaco);
      continue;
    }
    const nucleo = pedaco.replace(/^[^\p{L}\d[]+|[^\p{L}\d\]]+$/gu, "");
    const ehNome = nucleo.length > 0 && MAIUSCULA.test(nucleo) && !VOCABULARIO.has(normalizar(nucleo)) && !/^\[[a-z]+\]$/.test(nucleo);
    if (ehNome) {
      redacoes += ultimoFoiNome ? 0 : 1;
      const sufixo = pedaco.slice(pedaco.indexOf(nucleo) + nucleo.length);
      if (ultimoFoiNome) {
        // Remove o espaço já empurrado e junta à marcação anterior.
        while (saida.length && /^\s+$/.test(saida[saida.length - 1])) saida.pop();
        saida.push(sufixo);
      } else {
        saida.push(`${pedaco.slice(0, pedaco.indexOf(nucleo))}[nome]${sufixo}`);
      }
      ultimoFoiNome = sufixo === "";
      continue;
    }
    ultimoFoiNome = false;
    saida.push(pedaco);
  }
  texto = saida.join("");
  const max = opcoes.maxCaracteres ?? 200;
  if (texto.length > max) texto = `${texto.slice(0, max - 1)}…`;
  return { texto, redacoes };
}

/** Sinais de dado de criança (aniversariante, idade, nascimento): excluídos do contexto de modelo em V1. */
export function mencionaCrianca(texto: string) {
  return /\b(aniversari\w*|nascimento|nascid[oa]|idade|anos de idade|crianca\w*|filh[oa]s?)\b/.test(normalizar(texto));
}

/** Última barreira: identificador, e-mail ou CPF residual no JSON final ⇒ contexto recusado (nunca enviado). */
export function temIdentificadorResidual(json: string) {
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(json)
    || /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(json)
    || /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(json)
    || /https?:\/\//i.test(json);
}
