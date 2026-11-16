import type { DbExecutor } from "../db/contracts.ts";
import { SatisfacaoError } from "./erros.ts";

/**
 * Estado da 111 (links de avaliação e auditoria da PS-3), lido SÓ do catálogo, numa instrução que não cita as tabelas
 * da 111 — o código ramifica em JS antes de qualquer SQL que dependa delas (plano PS-3, F' + PS3-R21-P3-2).
 *
 * Os gatilhos são conferidos pela relação, pela função (assinatura), pela habilitação compatível com a sessão normal
 * (O/A) e pelo evento/nível (tgtype); gatilho homônimo em outra tabela, desligado ou com outro evento não conta. O
 * postcheck da 111 usa este MESMO manifesto (um teste estático confere). Nada aqui é coordenação com DDL concorrente: o
 * procedimento de volta exige quiescência, e a rota trata 42P01 como "não instalado" só como rede de segurança.
 */
export type EstadoInstalacao111 = "COMPLETA" | "AUSENTE" | "PARCIAL";

/** tgtype: 1 por linha, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE. */
export const OBJETOS_111 = {
  tabelas: ["satisfacao_links_avaliacao", "satisfacao_auditoria"],
  funcoes: ["kidmais111_link_guarda()", "kidmais111_auditoria_somente_insercao()", "kidmais111_auditoria_coerencia()"],
  gatilhos: [
    { nome: "satisfacao_links_guarda", tabela: "satisfacao_links_avaliacao", funcao: "kidmais111_link_guarda()", tipo: 19 },
    { nome: "satisfacao_auditoria_imutavel", tabela: "satisfacao_auditoria", funcao: "kidmais111_auditoria_somente_insercao()", tipo: 27 },
    { nome: "satisfacao_auditoria_truncate", tabela: "satisfacao_auditoria", funcao: "kidmais111_auditoria_somente_insercao()", tipo: 34 },
    { nome: "satisfacao_auditoria_coerencia", tabela: "satisfacao_auditoria", funcao: "kidmais111_auditoria_coerencia()", tipo: 7 },
  ],
  restricoes: [
    { nome: "satisfacao_links_uk", tabela: "satisfacao_links_avaliacao", tipo: "u" },
    { nome: "satisfacao_links_unidade_fk", tabela: "satisfacao_links_avaliacao", tipo: "f" },
    { nome: "satisfacao_links_url", tabela: "satisfacao_links_avaliacao", tipo: "c" },
    { nome: "satisfacao_auditoria_unidade_fk", tabela: "satisfacao_auditoria", tipo: "f" },
    { nome: "satisfacao_auditoria_tarefa_fk", tabela: "satisfacao_auditoria", tipo: "f" },
    { nome: "satisfacao_auditoria_acao", tabela: "satisfacao_auditoria", tipo: "c" },
    { nome: "satisfacao_auditoria_nulidade", tabela: "satisfacao_auditoria", tipo: "c" },
    { nome: "satisfacao_auditoria_urls", tabela: "satisfacao_auditoria", tipo: "c" },
  ],
} as const;

const literal = (texto: string) => `'${texto.replace(/'/g, "''")}'`;
const relacao = (tabela: string) => `to_regclass(${literal(`public.${tabela}`)})`;
const funcao = (assinatura: string) => `to_regprocedure(${literal(`public.${assinatura}`)})`;

/** Uma expressão booleana por objeto esperado (texto fixo, gerado do manifesto). */
const ITENS = [
  ...OBJETOS_111.tabelas.map((t) => `${relacao(t)} IS NOT NULL`),
  ...OBJETOS_111.funcoes.map((f) => `${funcao(f)} IS NOT NULL`),
  ...OBJETOS_111.gatilhos.map((g) => `EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgname = ${literal(g.nome)} AND NOT tg.tgisinternal
      AND tg.tgrelid = ${relacao(g.tabela)} AND tg.tgfoid = ${funcao(g.funcao)} AND tg.tgenabled IN ('O', 'A') AND tg.tgtype = ${g.tipo})`),
  ...OBJETOS_111.restricoes.map((r) => `EXISTS (SELECT 1 FROM pg_constraint co WHERE co.conname = ${literal(r.nome)} AND co.conrelid = ${relacao(r.tabela)}
      AND co.contype = ${literal(r.tipo)} AND co.convalidated)`),
  `EXISTS (SELECT 1 FROM pg_constraint co JOIN pg_index i ON i.indexrelid = co.conindid WHERE co.conname = 'satisfacao_links_uk'
      AND co.conrelid = ${relacao("satisfacao_links_avaliacao")} AND i.indnullsnotdistinct)`,
];
// Começa por SELECT (o marcador vem depois): a exportação confere que todo SQL da leitura é consulta.
export const SQL_ESTADO_111 = `SELECT /* satisfacao:instalacao-111 */ ARRAY[${ITENS.map((i) => `(${i})`).join(",\n  ")}] AS itens`;

export async function estadoInstalacao111(tx: DbExecutor): Promise<EstadoInstalacao111> {
  const itens = (await tx.query<{ itens: boolean[] }>(SQL_ESTADO_111)).rows[0]?.itens ?? [];
  const presentes = itens.filter((i) => i === true).length;
  if (presentes === 0) return "AUSENTE";
  return presentes === ITENS.length ? "COMPLETA" : "PARCIAL";
}

/** Recusa controlada (503) quando a 111 não está íntegra; chamar ANTES de ler ou travar qualquer linha. */
export async function exigirInstalacao111(tx: DbExecutor): Promise<void> {
  const estado = await estadoInstalacao111(tx);
  if (estado === "AUSENTE") throw new SatisfacaoError("NAO_INSTALADO", "Este recurso da pesquisa ainda não está instalado.", 503);
  if (estado === "PARCIAL") {
    console.error("[satisfacao] 111 parcial: conclusão e links recusados");
    throw new SatisfacaoError("INSTALACAO_INCOMPLETA", "Este recurso da pesquisa está indisponível no momento.", 503);
  }
}
