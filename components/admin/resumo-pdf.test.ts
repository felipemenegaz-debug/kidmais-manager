import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { criarPdfResumo, dimensoesJpeg, nomeArquivoResumo, type ResumoParaPdf } from './resumo-pdf.ts';

function resumo(extra: Partial<ResumoParaPdf> = {}): ResumoParaPdf {
  return {
    numeroVersao: 2,
    classificacao: 'Versão vigente',
    secoes: [
      { titulo: 'Contratante e aniversariante', linhas: [['Contratante', 'Maria Conceição (Teste)'], ['Aniversariante', 'Aniversariante fictício']] },
      { titulo: 'Festa', linhas: [['Data', '26/06/2027'], ['Pacote', 'Festa Completa']] },
    ],
    parcelas: [{ rotulo: 'Parcela 1', valor: 'R$ 8.811,00', vencimento: '26/06/2027', estado: 'PARCIAL' }],
    avisoFinanceiro: 'Posição financeira atual consultada.',
    ...extra,
  };
}

/** Texto dos operadores Tj, já decodificado de Latin-1 e sem escapes. */
function textoDoPdf(pdf: Uint8Array) {
  const bruto = Buffer.from(pdf).toString('latin1');
  return [...bruto.matchAll(/\((.*?)(?<!\\)\) Tj/g)].map((m) => m[1].replace(/\\([()\\])/g, '$1')).join('\n');
}

function paginas(pdf: Uint8Array) {
  return Number(Buffer.from(pdf).toString('latin1').match(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/)?.[1]);
}

test('PDF real: cabeçalho, xref válido e conteúdo do mesmo resumo exibido', () => {
  const pdf = criarPdfResumo(resumo());
  const bruto = Buffer.from(pdf).toString('latin1');
  assert.ok(bruto.startsWith('%PDF-1.4'));
  assert.ok(bruto.trimEnd().endsWith('%%EOF'));
  const xref = Number(bruto.match(/startxref\n(\d+)\n/)?.[1]);
  assert.equal(bruto.slice(xref, xref + 4), 'xref');
  // Cada offset do xref aponta exatamente para "N 0 obj".
  for (const [i, linha] of bruto.slice(xref).split('\n').slice(3).filter((l) => / 00000 n /.test(l)).entries()) {
    const offset = Number(linha.slice(0, 10));
    assert.equal(bruto.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`);
  }
  const texto = textoDoPdf(pdf);
  for (const esperado of ['Resumo da Contratação', 'Maria Conceição (Teste)', 'Festa Completa', 'R$ 8.811,00', 'PARCIAL', 'Não substitui o contrato jurídico', 'Página 1 de 1']) {
    assert.ok(texto.includes(esperado), esperado);
  }
  assert.equal(paginas(pdf), 1);
});

test('não inclui menu, sidebar nem atalhos do Admin', () => {
  const texto = textoDoPdf(criarPdfResumo(resumo()));
  for (const proibido of ['Menu administrativo', 'Dashboard', 'Perguntar ao Kidmais', 'Sair', 'Voltar a Contratos', 'Imprimir']) {
    assert.equal(texto.includes(proibido), false, proibido);
  }
});

test('multipágina: conteúdo longo pagina e numera todas as páginas', () => {
  const longa = Array.from({ length: 60 }, (_, i) => [`Item ${i + 1}`, `Observação operacional número ${i + 1} com texto suficiente para quebrar a linha em mais de uma linha dentro da coluna de valor.`] as [string, string]);
  const parcelas = Array.from({ length: 40 }, (_, i) => ({ rotulo: `Parcela ${i + 1}`, valor: 'R$ 100,00', vencimento: '01/01/2028', estado: 'PENDENTE' }));
  const pdf = criarPdfResumo(resumo({ secoes: [{ titulo: 'Observações', linhas: longa }], parcelas }));
  const total = paginas(pdf);
  assert.ok(total >= 3, `páginas: ${total}`);
  const texto = textoDoPdf(pdf);
  for (let n = 1; n <= total; n += 1) assert.ok(texto.includes(`Página ${n} de ${total}`));
  assert.ok(texto.includes('Item 60'));
  assert.ok(texto.includes('Parcela 40'));
  // Cabeçalho da tabela repetido quando a tabela atravessa páginas.
  assert.ok((texto.match(/VENCIMENTO/g) ?? []).length >= 2);
  // Nenhum texto é desenhado abaixo da margem inferior (y < 30) nem fora da página.
  for (const m of Buffer.from(pdf).toString('latin1').matchAll(/1 0 0 1 ([\d.]+) ([\d.-]+) Tm/g)) {
    assert.ok(Number(m[2]) >= 30 && Number(m[1]) < 595, `posição ${m[1]},${m[2]}`);
  }
});

test('texto é escapado e caracteres fora do Latin-1 não quebram o PDF', () => {
  const pdf = criarPdfResumo(resumo({ secoes: [{ titulo: 'Observações', linhas: [['Equipe', 'Parênteses ) ( e barra \\ — “aspas” 🎉 ✓']] }] }));
  const bruto = Buffer.from(pdf).toString('latin1');
  assert.match(bruto, /Parênteses \\\) \\\( e barra \\\\ - "aspas" \? \?/);
});

test('nome de arquivo amigável e seguro', () => {
  assert.equal(nomeArquivoResumo('Maria Conceição da Silva', '2027-06-26'), 'Resumo_Contratacao_Maria_Conceicao_da_Silva_2027-06-26.pdf');
  assert.equal(nomeArquivoResumo('../../etc/passwd', 'x'), 'Resumo_Contratacao_etc_passwd_sem_data.pdf');
  assert.equal(nomeArquivoResumo('', '2027-01-01'), 'Resumo_Contratacao_Cliente_2027-01-01.pdf');
});

test('logo JPEG real é embutido com as dimensões lidas do arquivo', () => {
  const bytes = new Uint8Array(readFileSync(new URL('../../public/assets/contratos/kidmais-logo-template-v1.jpg', import.meta.url)));
  const dimensoes = dimensoesJpeg(bytes);
  assert.deepEqual(dimensoes, { largura: 1400, altura: 578 });
  const pdf = criarPdfResumo(resumo(), { bytes, ...dimensoes! });
  assert.match(Buffer.from(pdf).toString('latin1'), /\/Subtype \/Image \/Width 1400 \/Height 578 .*\/DCTDecode/);
  assert.equal(dimensoesJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
});

test('a tela oferece Baixar PDF e Imprimir sem chamar API de escrita', () => {
  const source = readFileSync(new URL('./ResumoContratacao.tsx', import.meta.url), 'utf8');
  assert.match(source, /Baixar PDF/);
  assert.match(source, />Imprimir</);
  assert.match(source, /link\.download = nomeArquivoResumo/);
  assert.doesNotMatch(source, /method:\s*['"](?:POST|PUT|PATCH|DELETE)/);
  // Baixar não chama window.print.
  const baixar = source.slice(source.indexOf('async function baixarPdf'), source.indexOf('export default function'));
  assert.doesNotMatch(baixar, /print\(/);
});
