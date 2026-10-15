import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Celular: o menu fixo do admin não pode cobrir o título da conversa nem o botão "Voltar às conversas", que fica logo
// acima dele (validação no navegador de 04/10/2026, HEAD 78ed9d8: com o título a 72px o menu cobria o início do botão).
const shell = readFileSync('components/admin/shell.module.css', 'utf8');
const css = readFileSync('components/admin/atendimento/atendimento.module.css', 'utf8');
const tela = readFileSync('components/admin/atendimento/AtendimentoWhatsapp.tsx', 'utf8');

function menuFixo() {
  const m = shell.match(/@media\(max-width:(\d+)px\)[\s\S]*?\.menu \{[^}]*top:(\d+)px;[^}]*height:(\d+)px/);
  assert.ok(m, 'regra do menu fixo encontrada');
  return { largura: Number(m![1]), base: Number(m![2]) + Number(m![3]) };
}

test('botão "Voltar às conversas" fica abaixo do menu quando o título é rolado ou focado', () => {
  const menu = menuFixo();
  const voltar = css.match(/@media\(max-width:(\d+)px\)\{[^@]*?\.voltar\{display:inline-flex!important;[^}]*margin-bottom:(\d+)px\}/);
  assert.ok(voltar, 'regra que mostra o botão no celular encontrada');
  const [larguraVoltar, margem] = [Number(voltar![1]), Number(voltar![2])];
  const alturaBotao = Number(css.match(/\.pagina button\{[^}]*min-height:(\d+)px/)![1]);
  const regra = css.match(/@media\(max-width:(\d+)px\)\{\.pagina \.voltar~h2,\.pagina \.voltar~h2:focus\{scroll-margin-top:(\d+)px\}\}/);
  assert.ok(regra, 'regra do título depois do botão encontrada');
  const [larguraRegra, margemTitulo] = [Number(regra![1]), Number(regra![2])];
  assert.ok(larguraRegra >= larguraVoltar, 'vale em toda a faixa em que o botão aparece');
  assert.ok(larguraVoltar <= menu.largura, 'nessa faixa o menu é fixo');
  // Topo do botão = margem do título − margem do botão − altura do botão; precisa ficar abaixo do menu.
  const topoBotao = margemTitulo - margem - alturaBotao;
  assert.ok(topoBotao >= menu.base + 8, `botão começa em ${topoBotao}px; menu termina em ${menu.base}px (folga mínima de 8px)`);
});

test('no JSX o botão é irmão imediatamente anterior ao título (o seletor .voltar~h2 alcança o título)', () => {
  const trecho = tela.match(/className=\{styles\.voltar\}[^>]*>Voltar às conversas<\/button>([\s\S]*?)<h2 ref=\{tituloConversa\}/);
  assert.ok(trecho, 'botão e título encontrados na ordem');
  // Entre os dois só pode haver o fragmento (<>), que não cria elemento no DOM.
  const abertos = [...trecho![1].matchAll(/<([a-zA-Z][\w.]*)[\s>]/g)].map(m => m[1]);
  assert.deepEqual(abertos, [], 'nenhum elemento entre o botão e o título');
});
