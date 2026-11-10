import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { criarPdfResumo, dimensoesJpeg, larguraNegrito, LETRAS_POR_BASE, nomeArquivoResumo, normalizarNomePdf, normalizarTextoPdf, type ResumoParaPdf } from './resumo-pdf.ts';

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

test('marca: outra empresa sai com o próprio nome; sem marca, sem nome; nunca Kidmais', () => {
  const comNome = textoDoPdf(criarPdfResumo(resumo({ marca: { kidmais: false, nome: 'Buffet Fictício' } })));
  assert.ok(comNome.includes('Buffet Fictício'));
  for (const texto of [comNome, textoDoPdf(criarPdfResumo(resumo()))]) assert.equal(/kidmais/i.test(texto), false);
});

test('larguras da F2: tabela completa e valores da fonte', () => {
  assert.equal(larguraNegrito('W', 1000), 944);
  assert.equal(larguraNegrito('i', 1000), 278);
  assert.equal(larguraNegrito('Á', 1000), 722);
  assert.equal(larguraNegrito('~', 1000), 584);
  assert.equal(larguraNegrito('€', 1000), 556);
  assert.equal(larguraNegrito('✓', 1000), 1000);
});

test('marca: nome de 160 caracteres sai inteiro, entre o topo e a faixa, sem invadir a coluna da direita, com e sem logo', () => {
  const jpeg = new Uint8Array(readFileSync(new URL('../../public/assets/contratos/kidmais-logo-template-v1.jpg', import.meta.url)));
  const larga = { bytes: jpeg, largura: 400, altura: 100 };
  const logos = [null, { ...larga, ...dimensoesJpeg(jpeg) }, larga];
  const nomes = [
    'W'.repeat(160),
    'Á'.repeat(160),
    Array.from({ length: 9 }, () => 'W'.repeat(17)).join(' ').slice(0, 160),
    Array.from({ length: 17 }, (_, i) => 'Buffet' + String(i).padStart(2, '0')).join(' ').padEnd(160, 'x'),
    'Buffet Estrela Encantada',
  ];
  for (const logo of logos) for (const nome of nomes) {
    const bruto = Buffer.from(criarPdfResumo(resumo({ marca: { kidmais: false, nome } }), logo as never)).toString('latin1');
    const linhas = [...bruto.matchAll(/BT \/F2 ([\d.]+) Tf [^\n]*?1 0 0 1 ([\d.]+) ([\d.]+) Tm \(([^)]*)\) Tj ET/g)]
      .map((m) => ({ tamanho: Number(m[1]), x: Number(m[2]), y: Number(m[3]), texto: m[4] }))
      .filter((l) => l.x < 400 && l.y > 748 && l.y < 810);
    assert.ok(linhas.length > 0, 'nome presente');
    assert.equal(linhas.map((l) => l.texto).join('').replace(/\s/g, ''), Buffer.from(nome.replace(/\s/g, ''), 'latin1').toString('latin1'));
    for (const l of linhas) {
      assert.ok(l.y - l.tamanho * 0.21 >= 750, 'acima da faixa: ' + l.y);
      assert.ok(l.x + larguraNegrito(l.texto, l.tamanho) <= 400, 'largura: ' + l.texto);
      if (logo) assert.ok(l.x > 48, 'ao lado da logo');
    }
  }
});

test('não inclui menu, sidebar nem atalhos do Admin', () => {
  const texto = textoDoPdf(criarPdfResumo(resumo()));
  for (const proibido of ['Menu administrativo', 'Dashboard', 'Perguntar ao Copiloto', 'Perguntar ao Kidmais', 'Sair', 'Voltar a Contratos', 'Imprimir']) {
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

test('glifos WinAnsi fora do Latin-1 saem nos bytes da fonte; acento estranho vira a letra base', () => {
  const nome = 'Œuvre € Šárka Žofie ™ œ ‰ Ÿ ăn';
  const pdf = criarPdfResumo(resumo({ marca: { kidmais: false, nome } }));
  const bytes = Buffer.from(pdf);
  const esperado = Buffer.concat([Buffer.from([0x8c]), Buffer.from('uvre ', 'latin1'), Buffer.from([0x80]), Buffer.from(' ', 'latin1'), Buffer.from([0x8a]),
    Buffer.from('árka ', 'latin1'), Buffer.from([0x8e]), Buffer.from('ofie ', 'latin1'), Buffer.from([0x99]), Buffer.from(' ', 'latin1'), Buffer.from([0x9c]),
    Buffer.from(' ', 'latin1'), Buffer.from([0x89]), Buffer.from(' ', 'latin1'), Buffer.from([0x9f]), Buffer.from(' an', 'latin1')]);
  assert.ok(bytes.includes(esperado), 'nome com os bytes WinAnsi');
  assert.ok(!bytes.includes(Buffer.from('?uvre', 'latin1')), 'sem troca por ?');
  assert.equal(larguraNegrito('Œ€™', 10), (1000 + 556 + 1000) * 10 / 1000);
  assert.equal(larguraNegrito('œŠ', 10), (944 + 667) * 10 / 1000);
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

/** Oráculo independente: bytes 0x80–0x9F da WinAnsiEncoding (PDF 32000, anexo D). */
const WIN_ANSI_80_9F: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹',
  0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™',
  0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};
const decodificarWinAnsi = (latin1: string) => Array.from(latin1, (c) => WIN_ANSI_80_9F[c.charCodeAt(0)] ?? c).join('');

function linhasDoNome(pdf: Uint8Array) {
  const bruto = Buffer.from(pdf).toString('latin1');
  return [...bruto.matchAll(/BT \/F2 ([\d.]+) Tf [^\n]*?1 0 0 1 ([\d.]+) ([\d.]+) Tm \((.*?)(?<!\\)\) Tj ET/g)]
    .map((m) => ({ tamanho: Number(m[1]), x: Number(m[2]), y: Number(m[3]), texto: decodificarWinAnsi(m[4].replace(/\\([()\\])/g, '$1')) }))
    .filter((l) => l.x < 400 && l.y > 748 && l.y < 810);
}

test('nome do buffet: glifos WinAnsi preservados sem trocas tipográficas, extraídos e encaixados com e sem logo', () => {
  const jpeg = new Uint8Array(readFileSync(new URL('../../public/assets/contratos/kidmais-logo-template-v1.jpg', import.meta.url)));
  const logos = [null, { bytes: jpeg, ...dimensoesJpeg(jpeg) }, { bytes: jpeg, largura: 400, altura: 100 }];
  const todos = Object.values(WIN_ANSI_80_9F).join('');
  const casos: Array<[string, string]> = [
    ['Buffet “Sol” – Festa — Ação… • A·B ‘x’', 'Buffet “Sol” – Festa — Ação… • A·B ‘x’'],
    ['Buffet Țară 東京', 'Buffet Tara ??'],
    ['Buffet Ƶara Ⱥlfa Ɓeta 東京', 'Buffet Zara Alfa Beta ??'],
    ['Buffet Ʉrsula ʉgo Ᵽaula ᵽedro ɦugo', 'Buffet Ursula ugo Paula pedro hugo'],
    ['Buffet ǅemal ǈubica ﬁesta Ａna', 'Buffet Džemal Ljubica fiesta Ana'],
    ['Buffet Sol℠ Ⓐ ㎏', 'Buffet Sol? ? ?'],
    ['Buffet Ɵlga ɵlga ɪris Ɪris', 'Buffet Olga olga Iris Iris'],
    ['Buffet Gaŀla / Gal·la', 'Buffet Gal·la / Gal·la'],
    ['Buffet ẛ ᵊ', 'Buffet s ?'],
    ['Buffet Œuvre € Šárka • “Festa”—… Łódź Đakovo 東京', 'Buffet Œuvre € Šárka • “Festa”—… Lódz Dakovo ??'],
    ['Œuvre € ' + todos, 'Œuvre € ' + todos],
    [(todos + ' ').repeat(6).slice(0, 160), (todos + ' ').repeat(6).slice(0, 160).trim()],
  ];
  for (const logo of logos) for (const [nome, esperado] of casos) {
    const linhas = linhasDoNome(criarPdfResumo(resumo({ marca: { kidmais: false, nome } }), logo as never));
    assert.ok(linhas.length > 0, 'nome presente');
    assert.equal(linhas.map((l) => l.texto).join('').replace(/\s/g, ''), esperado.replace(/\s/g, ''), 'nome extraído');
    for (const l of linhas) {
      assert.ok(l.y - l.tamanho * 0.21 >= 750, 'acima da faixa: ' + l.y);
      assert.ok(l.x + larguraNegrito(l.texto, l.tamanho) <= 400, 'largura: ' + l.texto);
      if (logo) assert.ok(l.x > 48, 'ao lado da logo');
    }
  }
});

test('texto comum do Resumo mantém as trocas tipográficas de antes; só o nome muda', () => {
  const texto = textoDoPdf(criarPdfResumo(resumo({ secoes: [{ titulo: 'Observações', linhas: [['Equipe', 'A – B “c” …']] }] })));
  assert.match(texto, /A - B "c" \.\.\./);
});

test('as mesmas letras no cabeçalho e no corpo: a tabela de letras sem decomposição vale só para o nome', () => {
  const frase = 'Łódź – Đakovo “Festa” Ƶara';
  const pdf = criarPdfResumo(resumo({ marca: { kidmais: false, nome: 'Equipe ' + frase }, secoes: [{ titulo: 'Observações', linhas: [['Equipe', frase]] }] }));
  assert.equal(linhasDoNome(pdf).map((l) => l.texto).join(' '), 'Equipe Lódz – Dakovo “Festa” Zara', 'cabeçalho com a letra base');
  assert.match(textoDoPdf(pdf), /\?ódz - \?akovo "Festa" \?ara/, 'corpo como antes da tabela');
});

test('tabela de letras do nome: cada letra vira a sua base no nome e continua "?" no texto comum', () => {
  const letras = Object.entries(LETRAS_POR_BASE).flatMap(([base, grupo]) => Array.from(grupo, (letra) => [letra, base] as const));
  assert.ok(letras.length >= 270, 'tabela gerada pelos nomes Unicode');
  assert.equal(new Set(letras.map(([letra]) => letra)).size, letras.length, 'sem letra repetida');
  for (const [letra, base] of letras) {
    assert.match(base, /^[A-Za-z]$/);
    assert.equal(letra.normalize('NFD'), letra, letra + ': o NFD não decompõe');
    assert.equal(normalizarNomePdf('Buffet ' + letra), 'Buffet ' + base, letra + ' no nome');
    assert.equal(normalizarTextoPdf('Equipe ' + letra), 'Equipe ?', letra + ' no texto comum, como na r4');
  }
});

test('nome que se expande (dígrafo de compatibilidade) fica acima da faixa e, se não couber, termina em "…"', () => {
  const jpeg = new Uint8Array(readFileSync(new URL('../../public/assets/contratos/kidmais-logo-template-v1.jpg', import.meta.url)));
  let cortados = 0;
  for (const logo of [null, { bytes: jpeg, ...dimensoesJpeg(jpeg) }, { bytes: jpeg, largura: 400, altura: 100 }]) {
    const bruto = Buffer.from(criarPdfResumo(resumo({ marca: { kidmais: false, nome: 'Ǳ'.repeat(160) } }), logo as never)).toString('latin1');
    // Sem filtro de altura: uma linha do nome abaixo da faixa também precisa aparecer aqui.
    const linhas = [...bruto.matchAll(/BT \/F2 ([\d.]+) Tf [^\n]*?1 0 0 1 ([\d.]+) ([\d.]+) Tm \((.*?)(?<!\\)\) Tj ET/g)]
      .map((m) => ({ tamanho: Number(m[1]), x: Number(m[2]), y: Number(m[3]), texto: decodificarWinAnsi(m[4]) }))
      .filter((l) => /^[DZ]+…?$/.test(l.texto));
    assert.ok(linhas.length > 1, 'nome em várias linhas');
    for (const l of linhas) {
      assert.ok(l.y - l.tamanho * 0.21 >= 751 - 1e-6, `linha em y=${l.y} invade a faixa`);
      assert.ok(l.x < 400 && l.x + larguraNegrito(l.texto, l.tamanho) <= 388 + 1e-6, 'antes da coluna da direita');
    }
    const junto = linhas.map((l) => l.texto).join('');
    if (junto !== 'DZ'.repeat(160)) {
      cortados += 1;
      assert.match(junto, /…$/, 'cortado com reticências');
      assert.ok('DZ'.repeat(160).startsWith(junto.slice(0, -1)), 'prefixo do nome');
    }
  }
  assert.ok(cortados > 0, 'ao menos uma variante passa pelo corte');
});
