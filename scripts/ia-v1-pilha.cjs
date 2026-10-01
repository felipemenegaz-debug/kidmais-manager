/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Prova da pilha de PRs do AI Module V1 (depois da Foundation).
 *
 * As fases do V1 são branches empilhadas sobre `staging` (cada fase parte da anterior) e serão integradas
 * nessa ordem. Para cada fase do manifesto (scripts/ia-v1-pilha.json):
 *   1. resolve o commit da fase (`commit` fixo; senão a branch local; a branch em uso é a árvore de trabalho);
 *   2. confere a ordem: base ⊆ fase 1 ⊆ fase 2 ⊆ … (cada uma é ancestral da seguinte);
 *   3. extrai o commit (`git archive`, somente leitura) numa pasta temporária e roda TypeScript e os testes
 *      unitários (*.test.ts, sem *.postgres.test.ts) — cada PR compila e passa sozinho, na ordem de merge.
 *
 * Nada aqui acessa banco, rede, env ou escreve no repositório.
 * Uso: node scripts/ia-v1-pilha.cjs [--so-ordem] [--fase JEV_V1]
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const raiz = path.resolve(__dirname, "..");
const manifesto = JSON.parse(fs.readFileSync(path.join(__dirname, "ia-v1-pilha.json"), "utf8"));
const args = process.argv.slice(2);

function git(...argumentos) {
  const r = spawnSync("git", argumentos, { cwd: raiz, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${argumentos.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

const ancestral = (a, b) => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: raiz }).status === 0;

/** Commit de cada fase; a branch em uso é validada na árvore de trabalho (ainda pode não ter commit). */
function resolverFases() {
  const atual = git("branch", "--show-current");
  const erros = [];
  const fases = manifesto.fases.map((fase) => {
    if (fase.commit) return { ...fase, alvo: git("rev-parse", `${fase.commit}^{commit}`) };
    if (fase.branch === atual) return { ...fase, alvo: "ARVORE" };
    const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${fase.branch}^{commit}`], { cwd: raiz, encoding: "utf8" });
    if (r.status !== 0) { erros.push(`${fase.pr}: branch ${fase.branch} não existe localmente`); return { ...fase, alvo: null }; }
    return { ...fase, alvo: r.stdout.trim() };
  });
  const base = git("rev-parse", `${manifesto.base}^{commit}`);
  let anterior = base;
  fases.forEach((fase, i) => {
    if (!fase.alvo) return;
    if (fase.alvo === "ARVORE") {
      if (i !== fases.length - 1) erros.push(`${fase.pr}: a branch em uso (${fase.branch}) só pode ser a última fase listada`);
      if (!ancestral(anterior, "HEAD")) erros.push(`${fase.pr}: HEAD não descende da fase anterior`);
      anterior = "HEAD";
      return;
    }
    if (!ancestral(anterior, fase.alvo)) erros.push(`${fase.pr}: não descende da fase anterior (${anterior.slice(0, 7)})`);
    anterior = fase.alvo;
  });
  return { fases, erros };
}

function testesDe(dir) {
  const encontrados = [];
  const caminhar = (d) => {
    for (const item of fs.readdirSync(d, { withFileTypes: true })) {
      if (item.name === "node_modules" || item.name.startsWith(".")) continue;
      const c = path.join(d, item.name);
      if (item.isDirectory()) caminhar(c);
      else if (item.name.endsWith(".test.ts") && !item.name.endsWith(".postgres.test.ts")) encontrados.push(path.relative(dir, c));
    }
  };
  for (const pasta of ["app", "components", "lib"]) if (fs.existsSync(path.join(dir, pasta))) caminhar(path.join(dir, pasta));
  return encontrados.sort();
}

function montar(fase) {
  if (fase.alvo === "ARVORE") return { dir: raiz, temporario: false };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kidmais-ia-v1-${fase.pr.toLowerCase()}-`));
  const tar = path.join(dir, "fase.tar");
  git("-c", "core.autocrlf=false", "archive", "--format=tar", "-o", tar, fase.alvo);
  const extraido = spawnSync("tar", ["-xf", "fase.tar"], { cwd: dir, encoding: "utf8" });
  fs.rmSync(tar, { force: true });
  if (extraido.status !== 0) throw new Error(`tar: ${extraido.stderr}`);
  fs.symlinkSync(path.join(raiz, "node_modules"), path.join(dir, "node_modules"), "junction");
  return { dir, temporario: true };
}

function rodar(nome, dir, argumentos) {
  const inicio = Date.now();
  const r = spawnSync(process.execPath, argumentos, { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  const saida = `${r.stdout}\n${r.stderr}`;
  const resumo = saida.match(/^# (tests|pass|fail) \d+$/gm)?.join(" · ") ?? "";
  return { nome, ok: r.status === 0, segundos: Math.round((Date.now() - inicio) / 1000), resumo, saida };
}

function main() {
  const { fases, erros } = resolverFases();
  console.log(`Pilha V1: ${fases.length} fase(s) sobre ${manifesto.base}.`);
  for (const f of fases) console.log(`  · ${f.pr} ← ${f.branch} ${f.alvo === "ARVORE" ? "(árvore de trabalho)" : f.alvo ? f.alvo.slice(0, 10) : "(ausente)"}`);
  if (erros.length) {
    console.error(erros.map((e) => `  ✖ ${e}`).join("\n"));
    process.exit(1);
  }
  console.log("  ✔ cada fase descende da anterior (ordem de merge)");
  if (args.includes("--so-ordem")) return;
  const pedido = args.includes("--fase") ? args[args.indexOf("--fase") + 1] : null;
  const tsc = path.join(raiz, "node_modules", "typescript", "lib", "tsc.js");
  let falhou = false;
  for (const fase of fases.filter((f) => !pedido || f.pr === pedido)) {
    const { dir, temporario } = montar(fase);
    try {
      const tipos = rodar("tsc", dir, [tsc, "--noEmit", "-p", "."]);
      const testes = rodar("testes", dir, ["--experimental-strip-types", "--test", "--test-reporter=tap", ...testesDe(dir)]);
      for (const r of [tipos, testes]) {
        console.log(`${r.ok ? "✔" : "✖"} ${fase.pr} · ${r.nome} (${r.segundos}s) ${r.resumo}`);
        if (!r.ok) {
          falhou = true;
          const relevantes = r.saida.split("\n").filter((l) => /error TS|not ok|AssertionError|Error:|Cannot find/.test(l)).slice(0, 40);
          console.log(relevantes.map((l) => `    ${l}`).join("\n"));
        }
      }
    } finally {
      if (temporario) {
        // Remove o junction ANTES da pasta: a limpeza nunca pode alcançar o node_modules real.
        const link = path.join(dir, "node_modules");
        try { fs.unlinkSync(link); } catch { /* já removido */ }
        if (fs.existsSync(link)) console.error(`  ! junction não removido; pasta temporária mantida: ${dir}`);
        else fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  if (falhou) process.exit(1);
  console.log("PASS: cada fase da pilha V1 compila e passa nos testes unitários sozinha, na ordem de merge.");
}

main();
