import { CHAVE_CATALOGO_SKILLS, type RegistroExtensoes } from "@/lib/inteligencia/extensoes";
import { criarCatalogoSkills, repositorioSemSkillsDeEmpresa } from "@/lib/inteligencia/skills/catalogo";
import { SKILLS_PLATAFORMA } from "@/lib/inteligencia/skills/plataforma";

/**
 * Composição da feature SKILLS: playbooks de runtime entram no CORE só pelo ponto de extensão.
 * Só skills da PLATAFORMA: o armazenamento por empresa/estabelecimento exige estrutura nova (migration),
 * decisão humana pendente. Skill recusada vira alerta operacional (só id, nível e motivos; nunca conteúdo).
 */
export function registrarSkills(registro: RegistroExtensoes) {
  registro.definir(CHAVE_CATALOGO_SKILLS, () => criarCatalogoSkills({
    plataforma: SKILLS_PLATAFORMA,
    repositorio: repositorioSemSkillsDeEmpresa,
    alertar: (alerta) => console.error(`[Kidmais Skills alerta] ${JSON.stringify(alerta)}`),
  }));
}
