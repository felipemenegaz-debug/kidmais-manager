import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Teste de Felipe em staging (24/10/2026): com a janela em ~1054 px, o preço do formulário de pacote ficava com 29 px
 * (coluna de 261 px ao lado da lista de pacotes) e os nomes dos horários em Configurações › Agenda apareciam cortados.
 * As grades passam a seguir a largura do próprio bloco (container queries), não a da janela.
 */
const css = (arquivo: string) => readFileSync(arquivo, 'utf8').replace(/\r\n/g, '\n');
/** Corpo de um bloco @container/@media a partir do cabeçalho exato (chaves balanceadas). */
function bloco(texto: string, cabecalho: string) {
  const inicio = texto.indexOf(cabecalho);
  assert.ok(inicio >= 0, `bloco ausente: ${cabecalho}`);
  let nivel = 0;
  for (let i = texto.indexOf('{', inicio); i < texto.length; i++) {
    if (texto[i] === '{') nivel++;
    if (texto[i] === '}' && --nivel === 0) return texto.slice(inicio, i + 1);
  }
  throw new Error('bloco sem fim');
}
const mediaAte800 = (texto: string) => bloco(texto, '@media(max-width:800px) {');

test('preços por quantidade: a lista é contêiner e a grade estreita depende dela, não da janela', () => {
  const precos = css('components/admin/precos-quantidade.module.css');
  assert.match(precos, /\.lista \{[^}]*container:precos-lista \/ inline-size;/);
  const estreito = bloco(precos, '@container precos-lista (max-width: 520px) {');
  assert.match(estreito, /\.linha \{ grid-template-columns:72px minmax\(0,1fr\) 44px; \}/);
  assert.match(estreito, /\.linha > :nth-child\(3\) \{ grid-column:1 \/ -1; grid-row:2; \}/);
  assert.match(estreito, /\.linha > :nth-child\(4\) \{ grid-column:3; grid-row:1; \}/, 'o × fica ao lado do preço');
  assert.doesNotMatch(mediaAte800(precos), /\.linha\b/, 'a grade das linhas não segue mais a largura da janela');
});

test('Configurações › Agenda e assistente: a lista é contêiner; seis colunas só com a lista larga', () => {
  const agenda = css('components/admin/agenda-configuracao.module.css');
  assert.match(agenda, /\.lista \{[^}]*container:agenda-lista \/ inline-size;/);
  const linhas = bloco(agenda, '@container agenda-lista (max-width: 820px) {');
  assert.match(linhas, /\.linhaHorario \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\); \}/);
  assert.match(linhas, /\.linhaHorario > :first-child \{ grid-column:1 \/ -1; \}/, 'o nome ocupa a linha toda');
  assert.match(linhas, /\.cabecalhoHorario \{ display:none !important; \}/);
  // Sem cabeçalho, a capacidade ganha rótulo visível — em elemento aria-hidden, nunca por conteúdo gerado em CSS, para o
  // nome acessível continuar sendo só o texto srOnly (parecer do Astra, 24/10).
  assert.match(linhas, /\.rotuloEstreito \{ display:block;/);
  assert.match(agenda, /^\.rotuloEstreito \{ display:none; \}$/m, 'fora do arranjo estreito o rótulo extra não aparece');
  assert.doesNotMatch(agenda, /::before|[{;\s]content:\s*"/);
  const cartao = bloco(agenda, '@container agenda-lista (max-width: 480px) {');
  assert.match(cartao, /\.cartaoHorario \{ grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\) 44px;/);
  const media = mediaAte800(agenda);
  assert.doesNotMatch(media, /\.linhaHorario|\.cabecalhoHorario/, 'as linhas de horário não seguem mais a largura da janela');
  assert.doesNotMatch(agenda, /@media\(max-width:560px\)/, 'o cartão do assistente também segue a lista');
  // A tela de Configurações usa a lista como contêiner das linhas de horário.
  const tela = readFileSync('components/admin/AgendaConfiguracao.tsx', 'utf8');
  assert.match(tela, /<div className=\{css\.lista\} role="table" aria-label="Horários de festa">/);
  assert.match(tela, /<div className=\{`\$\{css\.linhaHorario\} \$\{css\.cabecalho\} \$\{css\.cabecalhoHorario\}`\} role="row">/);
  assert.match(tela, /<span className=\{ws\.srOnly\}>Festas ao mesmo tempo em \{h\.nome \|\| 'este horário'\}<\/span><span className=\{css\.rotuloEstreito\} aria-hidden="true">Festas ao mesmo tempo<\/span><input inputMode="numeric"/);
});
