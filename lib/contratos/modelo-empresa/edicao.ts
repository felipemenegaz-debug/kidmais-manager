import type { ConteudoModelo } from "./conteudo.ts";
import { versaoEstrutura, versaoTexto, type ClausulaTela, type ValorFixo } from "./valores-fixos.ts";

/**
 * Edição do modelo na tela (plano modelo de contrato v3, fase 2): funções PURAS sobre um único objeto de conteúdo.
 * Cada cláusula ganha um id estável de tela (gerado ao abrir, nunca enviado ao servidor), usado no cursor, nas
 * sugestões e na edição. O componente só chama estas funções.
 */
export type ConteudoTela = Omit<ConteudoModelo, "clausulas"> & { clausulas: ClausulaTela[] };
export type Resultado = { ok: true; conteudo: ConteudoTela; cursor?: Cursor } | { ok: false; motivo: string };

/** Cursor dentro do texto de uma cláusula, válido só enquanto o texto daquela cláusula for o mesmo. */
export type Cursor = { idClausula: string; inicio: number; fim: number; versaoTexto: string };
/** Destino do "Inserir": o cursor (modo edição) ou o fim de uma cláusula escolhida (modo leitura). */
export type Destino = { tipo: "cursor"; cursor: Cursor } | { tipo: "fim"; idClausula: string };

export function comIds(conteudo: ConteudoModelo, novoId: () => string): ConteudoTela {
  return { ...conteudo, clausulas: conteudo.clausulas.map((c) => ({ id: novoId(), titulo: c.titulo, texto: c.texto })) };
}

export function semIds(conteudo: ConteudoTela): ConteudoModelo {
  return { ...conteudo, clausulas: conteudo.clausulas.map(({ titulo, texto }) => ({ titulo, texto })) };
}

const indice = (c: ConteudoTela, id: string) => c.clausulas.findIndex((x) => x.id === id);
const comClausula = (c: ConteudoTela, i: number, nova: ClausulaTela): ConteudoTela => ({ ...c, clausulas: c.clausulas.map((x, k) => (k === i ? nova : x)) });

/** O cursor ainda vale? (cláusula existe, texto igual ao do momento da seleção e posições dentro dele) */
export function cursorValido(c: ConteudoTela, cursor: Cursor | null): cursor is Cursor {
  if (!cursor) return false;
  const cl = c.clausulas[indice(c, cursor.idClausula)];
  return Boolean(cl) && versaoTexto(cl.texto) === cursor.versaoTexto && cursor.inicio >= 0 && cursor.inicio <= cursor.fim && cursor.fim <= cl.texto.length;
}

/**
 * Destino do "Inserir" a partir do estado da tela: o cursor só vale se for da cláusula que está EM EDIÇÃO agora e se o
 * texto não mudou. Fora da edição (ou com seleção de outra cláusula), null: a tela pergunta a cláusula e insere no fim.
 */
export function destinoDoInserir(c: ConteudoTela, cursor: Cursor | null, editando: string | null): Destino | null {
  if (!editando || !cursor || cursor.idClausula !== editando || !cursorValido(c, cursor)) return null;
  return { tipo: "cursor", cursor };
}

export function inserirCampo(c: ConteudoTela, destino: Destino, chave: string): Resultado {
  const marca = `{{${chave}}}`;
  if (destino.tipo === "cursor") {
    if (!cursorValido(c, destino.cursor)) return { ok: false, motivo: "O texto mudou depois da seleção. Clique de novo onde o campo deve entrar." };
    const i = indice(c, destino.cursor.idClausula);
    const cl = c.clausulas[i];
    const texto = cl.texto.slice(0, destino.cursor.inicio) + marca + cl.texto.slice(destino.cursor.fim);
    const pos = destino.cursor.inicio + marca.length;
    return { ok: true, conteudo: comClausula(c, i, { ...cl, texto }), cursor: { idClausula: cl.id, inicio: pos, fim: pos, versaoTexto: versaoTexto(texto) } };
  }
  const i = indice(c, destino.idClausula);
  if (i < 0) return { ok: false, motivo: "Essa cláusula não existe mais." };
  const cl = c.clausulas[i];
  const texto = `${cl.texto.replace(/\s+$/, "")} ${marca}`;
  return { ok: true, conteudo: comClausula(c, i, { ...cl, texto }) };
}

/**
 * Troca um valor fixo pelo campo. Recusa qualquer divergência: cláusula sumiu, texto editado (versaoTexto), cláusula
 * movida/inserida/removida (versaoEstrutura), número exibido diferente da posição ou trecho diferente no lugar.
 */
export function trocarPorCampo(c: ConteudoTela, s: ValorFixo): Resultado {
  const i = indice(c, s.idClausula);
  if (i < 0) return { ok: false, motivo: "Essa cláusula não existe mais. Confira as sugestões de novo." };
  const cl = c.clausulas[i];
  if (versaoTexto(cl.texto) !== s.versaoTexto) return { ok: false, motivo: "O texto da cláusula mudou. Confira as sugestões de novo." };
  if (versaoEstrutura(c.clausulas) !== s.versaoEstrutura || i + 1 !== s.numero) return { ok: false, motivo: "As cláusulas mudaram de lugar. Confira as sugestões de novo." };
  if (cl.texto.slice(s.inicio, s.fim) !== s.trecho) return { ok: false, motivo: "O trecho não está mais no lugar. Confira as sugestões de novo." };
  return { ok: true, conteudo: comClausula(c, i, { ...cl, texto: cl.texto.slice(0, s.inicio) + s.substituto + cl.texto.slice(s.fim) }) };
}

export function moverClausula(c: ConteudoTela, id: string, delta: -1 | 1): Resultado {
  const i = indice(c, id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= c.clausulas.length) return { ok: false, motivo: "Não é possível mover esta cláusula." };
  const l = [...c.clausulas];
  [l[i], l[j]] = [l[j], l[i]];
  return { ok: true, conteudo: { ...c, clausulas: l } };
}

export function removerClausula(c: ConteudoTela, id: string): Resultado {
  if (indice(c, id) < 0) return { ok: false, motivo: "Essa cláusula não existe mais." };
  if (c.clausulas.length === 1) return { ok: false, motivo: "O contrato precisa de pelo menos uma cláusula." };
  return { ok: true, conteudo: { ...c, clausulas: c.clausulas.filter((x) => x.id !== id) } };
}

export function alterarTexto(c: ConteudoTela, id: string, parte: "titulo" | "texto", valor: string): Resultado {
  const i = indice(c, id);
  if (i < 0) return { ok: false, motivo: "Essa cláusula não existe mais." };
  const cl = c.clausulas[i];
  return { ok: true, conteudo: comClausula(c, i, parte === "texto" ? { ...cl, texto: valor } : { ...cl, titulo: valor || null }) };
}

export function adicionarClausula(c: ConteudoTela, novoId: () => string): Resultado {
  return { ok: true, conteudo: { ...c, clausulas: [...c.clausulas, { id: novoId(), titulo: null, texto: "Nova cláusula." }] } };
}
