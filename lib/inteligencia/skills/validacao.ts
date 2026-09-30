import { createHash } from "node:crypto";
import { normalizar } from "../texto-pt.ts";
import { MARCADORES_PERMITIDOS, skillSchema, type MotivoRecusaSkill, type Skill } from "./contrato.ts";

/**
 * Validação de skills: integridade (hash), proveniência, revisão, coerência de escopo e CONTEÚDO.
 *
 * A varredura de conteúdo é heurística e conservadora (recusa na dúvida): ela existe para que uma skill nunca
 * carregue autoridade — preço/valor, desconto, permissão/papel/acesso, lançamento financeiro, alteração de
 * contrato, desvio de Policy/Human Gate, instrução remota ou segredo. Não substitui a revisão humana; a revisão
 * humana também não dispensa a varredura.
 */

/** JSON canônico (chaves ordenadas) do que a revisão cobre: tudo menos `hash` e `revisao`. */
function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(",")}]`;
  if (valor && typeof valor === "object") {
    return `{${Object.keys(valor as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonico((valor as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(valor);
}

export function hashSkill(skill: Omit<Skill, "hash" | "revisao"> & Partial<Pick<Skill, "hash" | "revisao">>): string {
  const { hash: _h, revisao: _r, ...coberto } = skill;
  void _h;
  void _r;
  return createHash("sha256").update(canonico(coberto), "utf8").digest("hex");
}

const PADROES: ReadonlyArray<[MotivoRecusaSkill, RegExp[]]> = [
  ["CONTEUDO_PRECO", [/r\$\s*\d/, /\b\d+([.,]\d+)?\s*(reais|mil reais)\b/, /\b(preco|valor|custa|custo|mensalidade)\b[^.]{0,40}\b\d{2,}\b/]],
  ["CONTEUDO_DESCONTO", [/\b(desconto|descontos|cupom|cupons|abatimento|abater|de graca|gratuit\w*)\b/, /\b\d{1,3}\s?%\s*(off|a menos)\b/]],
  ["CONTEUDO_PERMISSAO", [/\b(permiss\w*|rbac|papeis|papel de (gestao|admin\w*|representante))\b/, /\b(conced\w*|liber\w*|d[ae]r?)\b[^.]{0,20}\bacesso\b/, /\b(torn\w*|promov\w*)\b[^.]{0,30}\badmin\w*\b/]],
  ["CONTEUDO_FINANCEIRO", [/\b(registr\w*|confirm\w*|baix\w*|estorn\w*|quit\w*|lanc\w*|reembols\w*|devolv\w*)\b[^.]{0,40}\b(pagamento|pagamentos|parcela|parcelas|recebimento|recebimentos|pix|boleto)\b/]],
  ["CONTEUDO_CONTRATO", [/\b(alter\w*|edit\w*|mud\w*|cancel\w*|rescind\w*|anul\w*)\b[^.]{0,30}\bcontrato\w*\b/]],
  ["CONTEUDO_DESVIO_POLITICA", [
    /\b(ignore|ignora|ignorar|desconsidere|pule|pular|contorne|burle)\b[^.]{0,40}\b(politica\w*|regra\w*|confirmac\w*|aprovac\w*|verificac\w*|human gate)\b/,
    /\bsem (pedir |precisar de )?(confirmac\w*|aprovac\w*)\b/, /\b(execute|confirme|aprove|faca)\b[^.]{0,20}\b(sozinh\w*|automatic\w*|direto)\b/,
    /\bsystem prompt\b/, /\bvoce agora e\b/, /\bmodo (desenvolvedor|admin|root)\b/,
  ]],
  ["CONTEUDO_REMOTO", [/https?:\/\//, /\bwww\./, /\b(baixe|baixar|download|curl|wget|npx|npm install)\b/, /\b(siga|leia|carregue|busque)\b[^.]{0,30}\b(instruc\w*|arquivo|url|link|endereco)\b/]],
  ["CONTEUDO_SEGREDO", [/\b(senha|senhas|token|tokens|api[_ ]?key|chave de api|secret\w*|database_url|credencia\w*)\b/, /\.env\b/]],
];

const MARCADOR = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Controle, largura zero, direção de texto e BOM (montado por código para não depender de caracteres invisíveis na fonte). */
const OCULTOS = new RegExp(`[${[[0x0, 0x8], [0xb, 0xc], [0xe, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff]]
  .map(([a, b]) => `\\u${a.toString(16).padStart(4, "0")}-\\u${b.toString(16).padStart(4, "0")}`).join("")}]`);

/** Todos os textos da skill (inclusive títulos), para a varredura. */
function textos(skill: Skill): Array<{ texto: string; template?: Skill["conteudo"]["templates"][number] }> {
  const c = skill.conteudo;
  return [
    ...(c.tom ? [{ texto: c.tom }] : []),
    ...c.instrucoes.map((texto) => ({ texto })),
    ...c.procedimentos.flatMap((p) => [{ texto: p.titulo }, ...p.passos.map((texto) => ({ texto }))]),
    ...c.objecoes.flatMap((o) => [{ texto: o.objecao }, { texto: o.resposta }]),
    ...c.templates.flatMap((t) => [{ texto: t.titulo }, { texto: t.texto, template: t }]),
    ...skill.restricoes.map((texto) => ({ texto })),
  ];
}

export function varrerConteudo(skill: Skill): MotivoRecusaSkill[] {
  const motivos = new Set<MotivoRecusaSkill>();
  for (const { texto, template } of textos(skill)) {
    // Marcadores saem da varredura: o valor vem do Core, nunca da skill.
    // Caractere oculto/de controle ou palavra com escrita mista (homoglifo) em skill: recusa — nunca "limpa" e aceita.
    if (OCULTOS.test(texto) || texto.split(/\s+/).some((p) => /\p{Script=Latin}/u.test(p) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(p))) motivos.add("CONTEUDO_OCULTO");
    // NFKC: letras de largura total viram as comuns antes da varredura ("ｄｅｓｃｏｎｔｏ" ⇒ "desconto").
    const semMarcadores = texto.normalize("NFKC").replace(MARCADOR, " ");
    const n = normalizar(semMarcadores);
    for (const [motivo, padroes] of PADROES) if (padroes.some((p) => p.test(n))) motivos.add(motivo);
    for (const [, nome] of texto.matchAll(MARCADOR)) {
      if (!(MARCADORES_PERMITIDOS as readonly string[]).includes(nome)) motivos.add("MARCADOR_DESCONHECIDO");
      else if (!template || !template.marcadores.includes(nome as never)) motivos.add("MARCADOR_NAO_DECLARADO");
    }
  }
  return [...motivos];
}

export type SkillValidada = { ok: true; skill: Skill } | { ok: false; motivos: MotivoRecusaSkill[]; id: string | null };

/** Só passa skill íntegra, revisada sobre ESTE conteúdo, com escopo coerente e sem autoridade no conteúdo. */
export function validarSkill(bruto: unknown): SkillValidada {
  const lido = skillSchema.safeParse(bruto);
  const id = typeof (bruto as { id?: unknown })?.id === "string" ? (bruto as { id: string }).id : null;
  if (!lido.success) return { ok: false, motivos: ["SCHEMA_INVALIDO"], id };
  const skill = lido.data;
  const motivos = new Set<MotivoRecusaSkill>();

  if (hashSkill(skill) !== skill.hash) motivos.add("HASH_DIVERGENTE");
  const r = skill.revisao;
  if (r.estado === "REJEITADA") motivos.add("REVISAO_REJEITADA");
  else if (r.estado === "PENDENTE" || !r.revisor || !r.revisadoEm) motivos.add("REVISAO_PENDENTE");
  if (r.hashRevisado !== skill.hash) motivos.add("REVISAO_DE_OUTRO_CONTEUDO");
  if (r.estado === "RESTRITA" && skill.restricoes.length === 0) motivos.add("RESTRITA_SEM_RESTRICOES");

  if (skill.proveniencia.origem === "TERCEIRO") {
    if (!/^[0-9a-f]{40}$/.test(skill.proveniencia.referencia)) motivos.add("TERCEIRO_SEM_COMMIT");
    if (!r.revisor) motivos.add("TERCEIRO_SEM_REVISOR");
  }

  const { empresaId, estabelecimentoId } = skill.escopo;
  const escopoOk = skill.nivel === "PLATAFORMA" ? empresaId === null && estabelecimentoId === null && skill.proveniencia.origem !== "EMPRESA"
    : skill.nivel === "EMPRESA" ? empresaId !== null && estabelecimentoId === null
      : empresaId !== null && estabelecimentoId !== null;
  if (!escopoOk) motivos.add("ESCOPO_INCOERENTE");

  for (const m of varrerConteudo(skill)) motivos.add(m);
  return motivos.size ? { ok: false, motivos: [...motivos], id: skill.id } : { ok: true, skill };
}
