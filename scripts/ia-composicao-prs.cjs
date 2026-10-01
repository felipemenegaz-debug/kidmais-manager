/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Prova de PRs separáveis do Kidmais Intelligence (B2).
 *
 * Para cada estágio do manifesto (ex.: CORE sozinho; CORE+ACTIONS; CORE+ACTIONS+DOCUMENT; ...):
 *   1. extrai o commit base (`git archive`, somente leitura no repositório) numa pasta temporária;
 *   2. copia por cima só os arquivos dos PRs do estágio;
 *   3. nos arquivos marcados, remove as linhas `// @pr:X` de PRs fora do estágio;
 *   4. roda TypeScript (tsc --noEmit) e os testes unitários (*.test.ts, sem *.postgres.test.ts).
 *
 * Antes, confere o manifesto: todo arquivo alterado em relação à base pertence a exatamente um PR,
 * e todo arquivo do manifesto existe. Nada aqui acessa banco, rede, env ou o repositório para escrita.
 *
 * Manifesto CONGELADO (`ate`): a Foundation já foi integrada (merge em `ate`). Diff, existência e conteúdo
 * dos arquivos vêm desse commit, não da árvore de trabalho: a prova continua reproduzível depois que a
 * branch segue com outras mudanças (ex.: PRs posteriores que não pertencem a este manifesto).
 *
 * Uso: node scripts/ia-composicao-prs.cjs [--so-manifesto] [--estagio CORE,ACTIONS]
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const raiz = path.resolve(__dirname, "..");
const manifesto = JSON.parse(fs.readFileSync(path.join(__dirname, "ia-prs-manifesto.json"), "utf8"));
const args = process.argv.slice(2);

function git(...argumentos) {
  const r = spawnSync("git", argumentos, { cwd: raiz, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${argumentos.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** Conteúdo binário-seguro de um arquivo no commit congelado (sem conversão de fim de linha). */
function conteudoCongelado(arquivo) {
  const r = spawnSync("git", ["-c", "core.autocrlf=false", "show", `${manifesto.ate}:${arquivo}`], { cwd: raiz, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git show ${manifesto.ate}:${arquivo}: ${r.stderr}`);
  return r.stdout;
}

function existe(arquivo) {
  if (!manifesto.ate) return fs.existsSync(path.join(raiz, arquivo));
  return spawnSync("git", ["cat-file", "-e", `${manifesto.ate}:${arquivo}`], { cwd: raiz }).status === 0;
}

function conferirManifesto() {
  if (manifesto.ate) git("cat-file", "-e", `${manifesto.ate}^{commit}`);
  const alterados = new Set((manifesto.ate
    ? git("diff", "--name-only", manifesto.base, manifesto.ate).split("\n")
    : [
      ...git("diff", "--name-only", manifesto.base).split("\n"),
      ...git("ls-files", "--others", "--exclude-standard").split("\n"),
    ]).map((l) => l.trim()).filter(Boolean));
  const dono = new Map();
  const erros = [];
  for (const [pr, arquivos] of Object.entries(manifesto.prs)) {
    for (const arquivo of arquivos) {
      if (dono.has(arquivo)) erros.push(`${arquivo}: em ${dono.get(arquivo)} e em ${pr}`);
      dono.set(arquivo, pr);
      if (!existe(arquivo)) erros.push(`${arquivo}: listado em ${pr} mas não existe`);
    }
  }
  for (const arquivo of alterados) if (!dono.has(arquivo)) erros.push(`${arquivo}: alterado mas fora do manifesto`);
  for (const [arquivo, pr] of Object.entries(manifesto.marcados)) {
    if (dono.get(arquivo) !== pr) erros.push(`${arquivo}: marcado para ${pr} mas pertence a ${dono.get(arquivo)}`);
  }
  for (const [pr, deps] of Object.entries(manifesto.dependencias)) {
    for (const d of deps) if (manifesto.ordem.indexOf(d) >= manifesto.ordem.indexOf(pr)) erros.push(`${pr} depende de ${d}, que vem depois`);
  }
  for (const estagio of manifesto.estagios) {
    for (const pr of estagio) for (const d of manifesto.dependencias[pr]) if (!estagio.includes(d)) erros.push(`estágio ${estagio.join("+")}: ${pr} exige ${d}`);
  }
  return { erros, total: dono.size, alterados: alterados.size };
}

/** Remove linhas marcadas de PRs fora do estágio. Linha marcada sem PR conhecido é erro. */
function filtrarMarcadas(texto, estagio, arquivo) {
  return texto.split(/(?<=\n)/).filter((linha) => {
    const m = linha.match(/\/\/ @pr:([A-Z]+)\s*$/);
    if (!m) return true;
    if (!manifesto.ordem.includes(m[1])) throw new Error(`${arquivo}: marca desconhecida @pr:${m[1]}`);
    return estagio.includes(m[1]);
  }).join("");
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

function montar(estagio) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kidmais-ia-${estagio.join("-").toLowerCase()}-`));
  // Caminho relativo ao cwd: tar do Git Bash lê "C:" como host remoto.
  const tar = path.join(dir, "base.tar");
  // Conteúdo do repositório (LF), como no CI: sem a conversão CRLF do checkout Windows.
  git("-c", "core.autocrlf=false", "archive", "--format=tar", "-o", tar, manifesto.base);
  const extraido = spawnSync("tar", ["-xf", "base.tar"], { cwd: dir, encoding: "utf8" });
  fs.rmSync(tar, { force: true });
  if (extraido.status !== 0) throw new Error(`tar: ${extraido.stderr}`);
  for (const pr of estagio) {
    for (const arquivo of manifesto.prs[pr]) {
      const destino = path.join(dir, arquivo);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      if (manifesto.ate) fs.writeFileSync(destino, conteudoCongelado(arquivo));
      else fs.copyFileSync(path.join(raiz, arquivo), destino);
    }
  }
  for (const arquivo of Object.keys(manifesto.marcados)) {
    const destino = path.join(dir, arquivo);
    if (fs.existsSync(destino)) fs.writeFileSync(destino, filtrarMarcadas(fs.readFileSync(destino, "utf8"), estagio, arquivo));
  }
  fs.symlinkSync(path.join(raiz, "node_modules"), path.join(dir, "node_modules"), "junction");
  return dir;
}

function rodar(nome, dir, argumentos) {
  const inicio = Date.now();
  const r = spawnSync(process.execPath, argumentos, { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  const saida = `${r.stdout}\n${r.stderr}`;
  const resumo = saida.match(/^# (tests|pass|fail) \d+$/gm)?.join(" · ") ?? "";
  return { nome, ok: r.status === 0, segundos: Math.round((Date.now() - inicio) / 1000), resumo, saida };
}

function main() {
  const { erros, total, alterados } = conferirManifesto();
  console.log(`Manifesto: ${total} arquivos em ${Object.keys(manifesto.prs).length} PRs; ${alterados} alterados em relação a ${manifesto.base}.`);
  if (erros.length) {
    console.error(erros.map((e) => `  ✖ ${e}`).join("\n"));
    process.exit(1);
  }
  console.log("  ✔ todo arquivo alterado pertence a exatamente um PR");
  if (args.includes("--so-manifesto")) return;
  const pedido = args.includes("--estagio") ? args[args.indexOf("--estagio") + 1].split(",") : null;
  const estagios = pedido ? [pedido] : manifesto.estagios;
  const tsc = path.join(raiz, "node_modules", "typescript", "lib", "tsc.js");
  let falhou = false;
  for (const estagio of estagios) {
    const nome = estagio.join("+");
    const dir = montar(estagio);
    try {
      const tipos = rodar("tsc", dir, [tsc, "--noEmit", "-p", "."]);
      const testes = rodar("testes", dir, ["--experimental-strip-types", "--test", "--test-reporter=tap", ...testesDe(dir)]);
      for (const r of [tipos, testes]) {
        console.log(`${r.ok ? "✔" : "✖"} ${nome} · ${r.nome} (${r.segundos}s) ${r.resumo}`);
        if (!r.ok) {
          falhou = true;
          const relevantes = r.saida.split("\n").filter((l) => /error TS|not ok|AssertionError|Error:|Cannot find/.test(l)).slice(0, 40);
          console.log(relevantes.map((l) => `    ${l}`).join("\n"));
        }
      }
    } finally {
      // Remove o junction ANTES da pasta: a limpeza nunca pode alcançar o node_modules real.
      const link = path.join(dir, "node_modules");
      try { fs.unlinkSync(link); } catch { /* já removido */ }
      if (fs.existsSync(link)) console.error(`  ! junction não removido; pasta temporária mantida: ${dir}`);
      else fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  if (falhou) process.exit(1);
  console.log("PASS: cada estágio compila e passa nos testes unitários sozinho.");
}

main();
