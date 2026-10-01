import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Lint das skills de agentes (tooling, nunca runtime). Toda skill presente precisa estar no registro com o
 * hash atual e uma decisão; skill REJEITADA não pode estar no repositório; nenhuma skill manda executar
 * download remoto, ler secrets, fazer push/deploy ou seguir instruções de URL.
 */
type Registro = {
  skills: Array<{ nome: string; arquivo: string; origem: string; versao: string; sha256: string; revisadoEm: string; permissoes: Record<string, string>; owasp: Record<string, string>; restricoes: string[]; revisaoIndependente: string; decisao: "APROVADA" | "RESTRITA" | "REJEITADA" }>;
  pendentes: Array<{ origem: string; situacao: string; decisao: null }>;
};

const registro = JSON.parse(readFileSync("scripts/skills-registro.json", "utf8")) as Registro;
const hash = (arquivo: string) => createHash("sha256").update(readFileSync(arquivo, "utf8").replace(/\r\n/g, "\n")).digest("hex");

function skillsPresentes() {
  const lista: string[] = [];
  for (const raiz of [".claude/skills", ".codex/skills"]) {
    if (!existsSync(raiz)) continue;
    for (const nome of readdirSync(raiz)) {
      const dir = join(raiz, nome);
      if (statSync(dir).isDirectory()) lista.push(join(dir, "SKILL.md").replaceAll("\\", "/"));
    }
  }
  return lista;
}

test("toda skill presente está registrada com o hash atual, proveniência, data, permissões e decisão", () => {
  const presentes = skillsPresentes();
  assert.ok(presentes.length >= 3);
  for (const arquivo of presentes) {
    const entrada = registro.skills.find((s) => s.arquivo === arquivo);
    assert.ok(entrada, `${arquivo} sem registro: revise com kidmais-skill-security`);
    assert.equal(entrada.sha256, hash(arquivo), `${arquivo} mudou depois da revisão: revise de novo e atualize o hash`);
    assert.ok(entrada.origem && entrada.versao && /^\d{4}-\d{2}-\d{2}$/.test(entrada.revisadoEm), arquivo);
    for (const chave of ["arquivos", "shell", "rede", "secrets", "git", "banco", "producao"]) assert.ok(entrada.permissoes[chave], `${arquivo}: permissão ${chave}`);
    for (let i = 1; i <= 10; i += 1) assert.ok(entrada.owasp[`ASI${String(i).padStart(2, "0")}`], `${arquivo}: ASI${i}`);
    assert.ok(["APROVADA", "RESTRITA", "REJEITADA"].includes(entrada.decisao));
    assert.notEqual(entrada.decisao, "REJEITADA", `${arquivo} foi rejeitada e não pode estar no repositório`);
    if (entrada.decisao === "RESTRITA") assert.ok(entrada.restricoes.length > 0, `${arquivo}: RESTRITA sem restrições escritas`);
  }
});

test("frontmatter mínimo: name e description", () => {
  for (const arquivo of skillsPresentes()) {
    const texto = readFileSync(arquivo, "utf8").replace(/\r\n/g, "\n");
    assert.match(texto, /^---\nname: [a-z0-9-]+\ndescription: .{20,}\n---\n/, arquivo);
  }
});

/** Linha que MANDA fazer algo proibido (sem palavra de negação na mesma linha). */
const PROIBIDO = [/curl[^\n]*\|\s*(ba)?sh/, /\bnpx\s+(?!tsc\b|next\b|eslint\b)[a-z@]/, /\bcat\s+\.env\.local\b|\bsource\s+\.env/, /git push( --force| -f)?\b/, /\btrigger_deploy\b|\bupdate_environment_variables\b/, /\b(leia|siga|execute|carregue) (as )?instru\w+ de https?:/i];
const NEGACAO = /\b(não|nunca|nenhum|nenhuma|sem|proib\w*|recus\w*|reprov\w*|jamais|evite|exige autoriza\w*)\b/i;

test("nenhuma skill manda baixar e executar, ler secrets, fazer push/deploy ou seguir instruções remotas", () => {
  for (const arquivo of skillsPresentes()) {
    for (const [n, linha] of readFileSync(arquivo, "utf8").split(/\r?\n/).entries()) {
      for (const padrao of PROIBIDO) {
        if (padrao.test(linha)) assert.match(linha, NEGACAO, `${arquivo}:${n + 1} manda fazer algo proibido: ${linha.trim()}`);
      }
    }
  }
});

test("skills de terceiros (Demerzel) sem fonte verificável não entram: nada instalado, só pendência registrada", () => {
  const demerzel = registro.pendentes.find((p) => /demerzel/i.test(p.origem));
  assert.ok(demerzel);
  assert.equal(demerzel.decisao, null);
  for (const arquivo of skillsPresentes()) assert.doesNotMatch(arquivo, /demerzel/i, "skill Demerzel só entra depois de revisada e registrada");
  // Tooling não vaza para o runtime: nada em app/, lib/ (exceto este lint) ou components/ lê skills.
  for (const raiz of ["app", "components"]) {
    const pilha = [raiz];
    while (pilha.length) {
      const d = pilha.pop()!;
      for (const nome of readdirSync(d)) {
        const c = join(d, nome);
        if (statSync(c).isDirectory()) pilha.push(c);
        else if (/\.(ts|tsx)$/.test(nome)) assert.doesNotMatch(readFileSync(c, "utf8"), /\.claude\/skills|\.codex\/skills|skills-registro/, c);
      }
    }
  }
});
