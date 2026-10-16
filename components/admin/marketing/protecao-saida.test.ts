import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

/**
 * R-H1 (16/10/2026): o guardião do histórico só protege travessias sucessivas se ouvir `popstate` ANTES do App Router
 * (no window vale a ordem de registro). As provas de navegador (App Router real e roteador sintético) ficam fora do
 * repositório; aqui fica a amarração que elas pressupõem.
 */
const ler = (f: string) => fs.readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8');

test('AdminShell instala o guardião do histórico no TOPO do módulo (avaliado antes dos efeitos do AppRouter)', () => {
  const shell = ler('components/admin/AdminShell.tsx');
  assert.match(shell, /^import \{ instalarGuardiaoDeHistorico \} from '\.\/marketing\/protecao-saida';$/m);
  // Chamada em nível de módulo: linha sem indentação, antes da primeira função/componente do arquivo.
  const chamada = shell.search(/^instalarGuardiaoDeHistorico\(\);$/m);
  const primeiraFuncao = shell.search(/^(export )?(default )?(async )?function /m);
  assert.ok(chamada > 0, 'chamada no topo do módulo');
  assert.ok(primeiraFuncao < 0 || chamada < primeiraFuncao, 'antes de qualquer componente');
});

test('guardião: barra a travessia antes do roteador, volta pela CHAVE e não usa entradas-guarda com Navigation API', () => {
  const hook = ler('components/admin/marketing/protecao-saida.ts');
  const guardiao = hook.slice(hook.indexOf('export function instalarGuardiaoDeHistorico'), hook.indexOf('const MARCA'));
  assert.match(guardiao, /addEventListener\('popstate'/);
  assert.match(guardiao, /stopImmediatePropagation\(\)/);
  assert.match(guardiao, /irPara\(nav, a\.chave\)/, 'volta para a entrada protegida por chave (traverseTo), não por deslocamento');
  assert.doesNotMatch(guardiao, /history\.(go|back|forward|pushState)\(/, 'sem deslocamentos relativos nem entradas novas');
  assert.match(guardiao, /if \(!nav\?\.currentEntry \|\| !a \|\| a\.liberado\(\)\) return;/, 'sem proteção ativa (ou liberada), nada é interceptado');
});
