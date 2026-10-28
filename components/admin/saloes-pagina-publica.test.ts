import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { avisoPaginaPublica, MINIMO_SALOES_PRONTOS } from './saloes-pagina-publica.ts';

/**
 * Configurações › Salões: o aviso sobre a página pública "Conheça os salões" segue a flag SALOES_PUBLICOS (era um texto
 * fixo dizendo que a página não estava ligada). Não promete exibição: o painel soma a empresa inteira, e o portão público
 * exige agenda por salão e 2 salões prontos na mesma unidade (revisão do Astra, 28/10/2026).
 */
test('aviso: desligada; ligada diz só a regra (agenda por salão e 2 prontos na mesma unidade), sem prometer exibição', () => {
  assert.equal(MINIMO_SALOES_PRONTOS, 2, 'o mesmo mínimo dos portões públicos (≥ 2 salões prontos)');
  assert.equal(avisoPaginaPublica(false), 'A página pública dos salões está desligada neste ambiente.');
  assert.equal(avisoPaginaPublica(true),
    'A página pública dos salões está ligada neste ambiente. Para aparecer ao cliente, é necessário ter agenda por salão e pelo menos 2 salões prontos na mesma unidade.');
  assert.doesNotMatch(avisoPaginaPublica(true), /aparecem para o cliente|faltam?\s\d/, 'nenhuma promessa nem contagem da empresa inteira');
});

test('rota devolve só o booleano da flag; tela usa o aviso e não tem mais o texto fixo', () => {
  const rota = readFileSync('app/api/admin/configuracoes/saloes/route.ts', 'utf8');
  assert.match(rota, /const paginaPublica = saloesPublicosLigados\(\);/);
  assert.match(rota, /return \{ instalacao, gestao, paginaPublica, saloes: \[\] \};/, 'também sem a 102 instalada');
  assert.doesNotMatch(rota, /SALOES_PUBLICOS\s*[:=]/, 'nenhum valor de env devolvido além do booleano');
  const tela = readFileSync('components/admin/SaloesApresentacaoLista.tsx', 'utf8');
  assert.doesNotMatch(tela, /ainda não está ligada/);
  assert.match(tela, /avisoPaginaPublica\(dados\.paginaPublica === true\)/);
  assert.doesNotMatch(tela, /filter\(\(s\) => s\.pronto\)/, 'o aviso não usa a contagem da empresa inteira');
});
