import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

// A reautenticação troca a sessão (renovacao { anterior, atual }). Só reautenticarSessao anuncia essa renovação ao
// controle de contexto; uma tela que chame a rota direto tem a página descartada no adminFetch seguinte e a operação
// que exigia a senha (integrar importação, assinar pela Kidmais, conectar WhatsApp) nunca é enviada.
const RAIZ = join(import.meta.dirname, '..', '..');
const PERMITIDO = 'lib/http/admin-fetch.ts';

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return arquivos(caminho);
    return /\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome) ? [caminho] : [];
  });
}

test('nenhuma tela chama a reautenticação sem a renovação anunciada', () => {
  const diretas = ['app', 'components', 'lib'].flatMap((d) => arquivos(join(RAIZ, d)))
    .map((c) => relative(RAIZ, c).replaceAll('\\', '/'))
    .filter((c) => c !== PERMITIDO && /acao:\s*'reautenticar'/.test(readFileSync(join(RAIZ, c), 'utf8')));
  assert.deepEqual(diretas, [], 'use reautenticarSessao de lib/http/admin-fetch');
});

test('as telas que exigem senha usam reautenticarSessao', () => {
  for (const tela of ['components/admin/importacao/IntegracaoContrato.tsx', 'components/admin/ContratoAdmin.tsx', 'components/admin/WhatsappConfiguracao.tsx', 'components/admin/PerfilEmpresa.tsx']) {
    assert.match(readFileSync(join(RAIZ, tela), 'utf8'), /reautenticarSessao\(/, tela);
  }
});
