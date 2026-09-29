import { createHash } from "node:crypto";
import type { CatalogoSkills, ConteudoSkill, FinalidadeSkill, NivelSkill, SkillAplicavel } from "../extensoes.ts";
import type { MotivoRecusaSkill, Skill } from "./contrato.ts";
import { validarSkill } from "./validacao.ts";

/**
 * Catálogo de skills: resolução PLATAFORMA → EMPRESA → ESTABELECIMENTO.
 *
 * - Plataforma: skills versionadas no código (plataforma.ts), validadas ao montar o catálogo.
 * - Empresa e estabelecimento: vêm de um `RepositorioSkills`. A persistência por empresa exige estrutura nova
 *   (migration) — decisão humana pendente; até lá a composição usa `repositorioSemSkillsDeEmpresa`
 *   (só plataforma). Tudo o que vem do repositório é validado de novo a cada leitura.
 * - Isolamento: o escopo de cada skill é reconferido contra a empresa/estabelecimento COMPROVADOS (defesa em
 *   profundidade, mesmo que o repositório já filtre). Skill de outra empresa nunca é considerada.
 * - Mescla: níveis inferiores refinam (tom, formatação, itens com a mesma chave) e ACRESCENTAM instruções e
 *   restrições; nunca removem restrição da plataforma. Permissões: interseção (só podem estreitar).
 */
export interface RepositorioSkills {
  /** Skills da empresa e dos estabelecimentos dela (brutas; o catálogo valida). */
  listar(empresaId: string): Promise<readonly unknown[]>;
}

/** Composição atual: sem armazenamento por empresa (decisão humana pendente) ⇒ só skills da plataforma. */
export const repositorioSemSkillsDeEmpresa: RepositorioSkills = Object.freeze({ listar: async () => [] });

/** Para testes e fixtures: devolve TUDO, de propósito — o catálogo é que precisa isolar por escopo. */
export function repositorioEmMemoria(skills: readonly unknown[]): RepositorioSkills {
  return { listar: async () => skills };
}

export type AlertaSkill = { codigo: "SKILL_RECUSADA" | "REPOSITORIO_INDISPONIVEL"; id: string | null; nivel: NivelSkill | null; motivos: readonly MotivoRecusaSkill[] };

const ORDEM_NIVEL: Readonly<Record<NivelSkill, number>> = { PLATAFORMA: 0, EMPRESA: 1, ESTABELECIMENTO: 2 };

function porChave<T>(base: readonly T[], extra: readonly T[], chave: (item: T) => string): T[] {
  const mapa = new Map<string, T>();
  for (const item of [...base, ...extra]) mapa.set(chave(item), item);
  return [...mapa.values()];
}

function mesclar(cadeia: readonly Skill[]): { conteudo: ConteudoSkill; restricoes: string[]; classes: Set<"READ" | "SUGGEST"> } {
  let conteudo: ConteudoSkill = { tom: null, instrucoes: [], procedimentos: [], objecoes: [], templates: [], formatacao: { maxParagrafos: null, usarListas: null } };
  const restricoes: string[] = [];
  let classes = null as Set<"READ" | "SUGGEST"> | null;
  for (const s of cadeia) {
    const c = s.conteudo;
    conteudo = {
      tom: c.tom ?? conteudo.tom,
      instrucoes: [...new Set([...conteudo.instrucoes, ...c.instrucoes])],
      procedimentos: porChave(conteudo.procedimentos, c.procedimentos, (p) => p.titulo),
      objecoes: porChave(conteudo.objecoes, c.objecoes, (o) => o.objecao),
      templates: porChave(conteudo.templates, c.templates, (t) => t.id),
      formatacao: {
        maxParagrafos: c.formatacao.maxParagrafos ?? conteudo.formatacao.maxParagrafos,
        usarListas: c.formatacao.usarListas ?? conteudo.formatacao.usarListas,
      },
    };
    restricoes.push(...s.restricoes.filter((r) => !restricoes.includes(r)));
    const proprias = new Set(s.permissoes.classes);
    classes = classes === null ? proprias : new Set([...classes].filter((x) => proprias.has(x)));
  }
  return { conteudo, restricoes, classes: classes ?? new Set() };
}

export type OpcoesCatalogo = {
  plataforma: readonly unknown[];
  repositorio: RepositorioSkills;
  alertar?: (alerta: AlertaSkill) => void;
};

export function criarCatalogoSkills(opcoes: OpcoesCatalogo): CatalogoSkills & { plataformaValidas: readonly Skill[] } {
  const alertar = (a: AlertaSkill) => {
    try {
      opcoes.alertar?.(a);
    } catch {
      // Alerta nunca derruba a resolução.
    }
  };
  const plataforma: Skill[] = [];
  for (const bruto of opcoes.plataforma) {
    const v = validarSkill(bruto);
    if (v.ok && v.skill.nivel === "PLATAFORMA") plataforma.push(v.skill);
    else alertar({ codigo: "SKILL_RECUSADA", id: v.ok ? v.skill.id : v.id, nivel: "PLATAFORMA", motivos: v.ok ? ["ESCOPO_INCOERENTE"] : v.motivos });
  }

  async function candidatas(empresaId: string, estabelecimentoId: string | null): Promise<Skill[]> {
    let brutas: readonly unknown[] = [];
    try {
      brutas = await opcoes.repositorio.listar(empresaId);
    } catch {
      // Repositório fora do ar: segue só com a plataforma (conteúdo seguro), com alerta.
      alertar({ codigo: "REPOSITORIO_INDISPONIVEL", id: null, nivel: null, motivos: [] });
    }
    const daEmpresa: Skill[] = [];
    for (const bruto of brutas) {
      const v = validarSkill(bruto);
      if (!v.ok) {
        alertar({ codigo: "SKILL_RECUSADA", id: v.id, nivel: null, motivos: v.motivos });
        continue;
      }
      const s = v.skill;
      const mesmaEmpresa = s.escopo.empresaId === empresaId;
      if (s.nivel === "EMPRESA" && mesmaEmpresa) daEmpresa.push(s);
      else if (s.nivel === "ESTABELECIMENTO" && mesmaEmpresa && estabelecimentoId !== null && s.escopo.estabelecimentoId === estabelecimentoId) daEmpresa.push(s);
      // PLATAFORMA vinda do repositório, outra empresa ou outro estabelecimento: ignorada (nunca eleva nem vaza).
    }
    return [...plataforma, ...daEmpresa];
  }

  return {
    plataformaValidas: plataforma,
    async resolver(alvo) {
      const todas = (await candidatas(alvo.empresaId, alvo.estabelecimentoId)).filter((s) => s.finalidades.includes(alvo.finalidade as FinalidadeSkill));
      // Específica da capacidade (2) > geral da finalidade (1); skill de outra capacidade não conta.
      const pontua = (s: Skill) => (alvo.capacidade && s.capacidades.includes(alvo.capacidade) ? 2 : s.capacidades.length === 0 ? 1 : 0);
      const ids = [...new Set(todas.filter((s) => pontua(s) > 0).map((s) => s.id))];
      if (!ids.length) return null;
      const melhor = ids.map((id) => {
        const cadeia = todas.filter((s) => s.id === id && pontua(s) > 0).sort((a, b) => ORDEM_NIVEL[a.nivel] - ORDEM_NIVEL[b.nivel]);
        return { id, cadeia, pontos: Math.max(...cadeia.map(pontua)), profundidade: ORDEM_NIVEL[cadeia.at(-1)!.nivel] };
      }).sort((a, b) => b.pontos - a.pontos || b.profundidade - a.profundidade || a.id.localeCompare(b.id))[0];
      const { conteudo, restricoes, classes } = mesclar(melhor.cadeia);
      // Sem nenhuma classe comum (um nível estreitou tudo), a skill não se aplica.
      if (classes.size === 0) return null;
      const topo = melhor.cadeia.at(-1)!;
      const aplicavel: SkillAplicavel = {
        id: melhor.id,
        versao: topo.versao,
        hash: createHash("sha256").update(melhor.cadeia.map((s) => s.hash).join(":"), "utf8").digest("hex"),
        nivel: topo.nivel,
        cadeia: melhor.cadeia.map((s) => ({ nivel: s.nivel, versao: s.versao, hash: s.hash })),
        conteudo,
        restricoes,
      };
      return aplicavel;
    },
  };
}
