import { db } from "@/lib/db/postgres";
import { criarRepositorioSkillsPostgres } from "@/lib/ia-persistencia/skills";
import { CHAVE_CATALOGO_SKILLS, type RegistroExtensoes } from "@/lib/inteligencia/extensoes";
import { criarCatalogoSkills } from "@/lib/inteligencia/skills/catalogo";
import { SKILLS_PLATAFORMA } from "@/lib/inteligencia/skills/plataforma";

/**
 * Composição da feature SKILLS: playbooks de runtime entram no CORE só pelo ponto de extensão.
 * Base da PLATAFORMA (código revisado) + camadas da EMPRESA e do ESTABELECIMENTO lidas de `ia_skills` (058, somente
 * leitura; sem a tabela, só a plataforma). A conversa decide as camadas permitidas (AI_SKILLS_EMPRESA_ENABLED,
 * allowlist, unidade comprovada) e o catálogo revalida tudo. Skill recusada vira alerta (só id, nível e motivos).
 */
export function registrarSkills(registro: RegistroExtensoes) {
  registro.definir(CHAVE_CATALOGO_SKILLS, () => criarCatalogoSkills({
    plataforma: SKILLS_PLATAFORMA,
    repositorio: criarRepositorioSkillsPostgres({ executor: db }),
    alertar: (alerta) => console.error(`[Kidmais Skills alerta] ${JSON.stringify(alerta)}`),
  }));
}
