import { normalizarComMapa, normalizarTrecho, type CampoLido } from "./extracao.ts";
import { validarCnpj } from "./validadores.ts";

/**
 * Modelo de contrato ATIVO da empresa como referência da leitura (D-IMP-4, plano rev. 2.1, R2-7).
 *
 * Só o modelo publicado entra: as cláusulas com {{campos}} no lugar dos dados, sem dado pessoal. O PDF original
 * enviado nas configurações nunca é usado. Valores e trechos vêm SEMPRE do contrato importado; o modelo só diz onde
 * cada dado costuma estar.
 */
export type ModeloReferencia = { id: string; versao: number; textos: string[] };

/**
 * Dado literal que não deveria estar num modelo (CNPJ, CPF, e-mail, telefone, CEP): sai como "[dado]". CNPJ
 * alfanumérico sem máscara só quando o validador o aceita (rodada 2, P2), para não apagar palavra comum.
 */
const DADO = "[dado]";
const DADOS_LITERAIS: ReadonlyArray<readonly [RegExp, (trecho: string) => string]> = [
  [/(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g, () => DADO],
  [/(?<![0-9A-Z])[0-9A-Z]{2}\.[0-9A-Z]{3}\.[0-9A-Z]{3}\/[0-9A-Z]{4}-\d{2}(?![0-9A-Z])/gi, () => DADO],
  [/(?<![0-9A-Z])[0-9A-Z]{12}\d{2}(?![0-9A-Z])/gi, (t) => (validarCnpj(t.toUpperCase()).ok ? DADO : t)],
  [/(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g, () => DADO],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, () => DADO],
  [/(?:\(\d{2}\)\s?|(?<!\d)\d{2}\s)?9?\d{4}-?\d{4}(?!\d)/g, () => DADO],
  [/(?<!\d)\d{5}-\d{3}(?!\d)/g, () => DADO],
];
const semDadoLiteral = (texto: string) => DADOS_LITERAIS.reduce((t, [padrao, trocar]) => t.replace(padrao, trocar), texto);

/**
 * Referência da leitura a partir do modelo PUBLICADO (D-IMP-4; revisão do Astra da Entrega A, P2-5): só título e texto
 * das cláusulas. Título geral, preâmbulo e observações ficam fora, e qualquer dado literal que sobrar nas cláusulas é
 * trocado por "[dado]" antes de sair do servidor. O documento da contratada só serve para recusá-lo como do cliente.
 */
export function referenciaDoModeloPublicado(ativo: {
  id: string; versao: number;
  conteudo: { clausulas: ReadonlyArray<{ titulo: string | null; texto: string }>; contratada: { documento: string } };
}): { modelo: ModeloReferencia; documentoContratada: string | null } {
  const textos = ativo.conteudo.clausulas.flatMap((c) => [c.titulo ?? "", c.texto]).filter((t) => t.trim()).map(semDadoLiteral);
  return { modelo: { id: ativo.id, versao: ativo.versao, textos }, documentoContratada: ativo.conteudo.contratada.documento || null };
}

const MARCA = /\{\{\s*([a-z_.]+)\s*\}\}/g;

/** Campo do modelo → campo da revisão, com o token esperado no texto normalizado (minúsculo, sem acento). */
const ALVOS: Readonly<Record<string, { campo: string; token: string | null }>> = {
  "contratante.nome": { campo: "contratante.nome", token: null },
  "contratante.cpf": { campo: "contratante.cpf", token: "\\d{3}\\.?\\d{3}\\.?\\d{3}-?\\d{2}" },
  "contratante.rg": { campo: "contratante.rg", token: "\\d[\\d.\\-x]{3,14}" },
  "contratante.telefone": { campo: "contratante.telefone", token: "\\(?\\d{2}\\)?\\s?\\d{4,5}-?\\s?\\d{4}" },
  "contratante.email": { campo: "contratante.email", token: "[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\\.[a-z]{2,}" },
  "contratante.endereco": { campo: "contratante.endereco", token: null },
  "aniversariante.nome": { campo: "evento.aniversariante", token: null },
  "aniversariante.idade": { campo: "evento.idade", token: "\\d{1,3}(?: anos?)?" },
  "aniversariante.tema": { campo: "evento.tema", token: null },
  "festa.pacote": { campo: "pacote.nome", token: null },
  "festa.data": { campo: "evento.data", token: "\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}" },
  "festa.data_extenso": { campo: "evento.data", token: "\\d{1,2} de [a-z]+ de \\d{4}" },
  "festa.duracao": { campo: "evento.duracao", token: "\\d{1,2}(?:h\\d{2}| ?horas?| ?h)" },
  "festa.convidados": { campo: "evento.convidados", token: "\\d{1,5}" },
  "valor.total": { campo: "valores.total", token: "r\\$ ?\\d[\\d.]*(?:,\\d{2})?" },
  "valor.pacote": { campo: "valores.preco", token: "r\\$ ?\\d[\\d.]*(?:,\\d{2})?" },
  "valor.adicionais": { campo: "valores.adicionais", token: "r\\$ ?\\d[\\d.]*(?:,\\d{2})?" },
  "pagamento.condicao": { campo: "pagamentos.condicao", token: null },
};
const HORA = "\\d{1,2}(?::\\d{2}|h\\d{0,2})";

/** Contexto mínimo antes do marcador e texto fixo mínimo depois de um campo de texto livre. */
const ANTES_MIN = 12;
const ANTES_MAX = 40;
const DEPOIS_MIN = 3;
const DEPOIS_MAX = 20;

const escapar = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Janela = { chaves: string[]; padrao: RegExp };

/**
 * Para cada marcador: os últimos 12–40 caracteres de texto fixo antes dele (cortados em início de palavra) e, depois,
 * o token do tipo (campos tipados) ou os primeiros 3–20 caracteres de texto fixo (texto livre). Marcadores colados
 * (menos de 3 caracteres entre eles) e marcador sem texto fixo suficiente antes são ignorados. Horário de início e
 * término só entram juntos, quando estão na mesma janela.
 */
function janelas(texto: string): Janela[] {
  const partes: Array<{ literal: string; chave: string | null }> = [];
  let ultimo = 0;
  for (const m of texto.matchAll(MARCA)) {
    partes.push({ literal: normalizarTrecho(texto.slice(ultimo, m.index)), chave: m[1] });
    ultimo = (m.index ?? 0) + m[0].length;
  }
  partes.push({ literal: normalizarTrecho(texto.slice(ultimo)), chave: null });
  const saida: Janela[] = [];
  for (let i = 0; i < partes.length - 1; i += 1) {
    const chave = partes[i].chave!;
    const antes = cortarAntes(partes[i].literal);
    if (antes.length < ANTES_MIN) continue;
    const seguinte = partes[i + 1];
    if (chave === "festa.inicio") {
      // "das {{festa.inicio}} às {{festa.fim}}": o texto entre os dois precisa ter de 1 a 20 caracteres.
      if (seguinte.chave !== "festa.fim" || !seguinte.literal || seguinte.literal.length > DEPOIS_MAX) continue;
      saida.push({ chaves: ["festa.inicio", "festa.fim"], padrao: new RegExp(`${escapar(antes)} ?(${HORA}) ?${escapar(seguinte.literal)} ?(${HORA})(?![0-9a-z])`, "g") });
      continue;
    }
    const alvo = ALVOS[chave];
    if (!alvo) continue;
    if (alvo.token) {
      saida.push({ chaves: [chave], padrao: new RegExp(`${escapar(antes)} ?(${alvo.token})(?![0-9a-z])`, "g") });
      continue;
    }
    const depois = seguinte.literal.slice(0, DEPOIS_MAX);
    if (seguinte.chave !== null && seguinte.literal.length < DEPOIS_MIN) continue;
    if (depois.trim().length < DEPOIS_MIN) continue;
    saida.push({ chaves: [chave], padrao: new RegExp(`${escapar(antes)} ?(\\S.{0,118}?) ?${escapar(depois)}`, "g") });
  }
  return saida;
}

function cortarAntes(literal: string) {
  if (literal.length <= ANTES_MAX) return literal.trim();
  const corte = literal.slice(-ANTES_MAX);
  const espaco = corte.indexOf(" ");
  return (espaco < 0 ? corte : corte.slice(espaco + 1)).trim();
}

/**
 * Casa o contrato importado com as cláusulas do modelo. Só vale janela que aparece UMA vez no documento inteiro;
 * repetida ou ambígua é ignorada. Devolve, por campo da revisão, o valor como está no contrato importado, a página e o
 * trecho original (do importado) que contém o valor. Campo encontrado por duas janelas com valores diferentes é
 * descartado.
 */
export function casarComModelo(paginas: readonly string[], modelo: ModeloReferencia): Record<string, CampoLido> {
  const normalizadas = paginas.map(normalizarComMapa);
  const achados = new Map<string, CampoLido | null>();
  const guardar = (campo: string, lido: CampoLido) => {
    const atual = achados.get(campo);
    if (atual === undefined) achados.set(campo, lido);
    else if (atual && normalizarTrecho(atual.valor ?? "") !== normalizarTrecho(lido.valor ?? "")) achados.set(campo, null);
  };
  for (const texto of modelo.textos) {
    for (const janela of janelas(texto)) {
      const ocorrencias = normalizadas.flatMap((n, i) => [...n.texto.matchAll(janela.padrao)].map((m) => ({ m, i })));
      if (ocorrencias.length !== 1) continue;
      const { m, i } = ocorrencias[0];
      const { mapa } = normalizadas[i];
      const original = paginas[i];
      const inicioJanela = mapa[m.index ?? 0];
      let fimJanela = mapa[(m.index ?? 0) + m[0].length - 1] + 1;
      // A janela pode terminar no meio de uma palavra do texto fixo: o trecho vai até o fim dela (fronteira de token).
      while (fimJanela < original.length && /[\p{L}\p{N}]/u.test(original[fimJanela])) fimJanela += 1;
      const trecho = original.slice(inicioJanela, fimJanela).replace(/\s+/g, " ").trim();
      if (trecho.length > 280) continue;
      const valorOriginal = (grupo: number) => {
        const inicio = (m.index ?? 0) + m[0].indexOf(m[grupo]);
        return original.slice(mapa[inicio], mapa[inicio + m[grupo].length - 1] + 1).replace(/\s+/g, " ").trim();
      };
      if (janela.chaves[0] === "festa.inicio") {
        guardar("evento.horario", { valor: `${valorOriginal(1)} às ${valorOriginal(2)}`, pagina: i + 1, trecho });
        continue;
      }
      guardar(ALVOS[janela.chaves[0]].campo, { valor: valorOriginal(1), pagina: i + 1, trecho });
    }
  }
  return Object.fromEntries([...achados].filter((x): x is [string, CampoLido] => x[1] !== null));
}
