import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MARCA_KIDMAIS, textosMarca } from './marca-publica.ts';
import { REGRAS_LEGADAS, REGRAS_NEUTRAS } from '../comercial/regras-pagamento.ts';

test('endereço atual mantém a marca Kidmais; outra empresa recebe nome próprio e redação neutra', () => {
    assert.deepEqual(textosMarca(MARCA_KIDMAIS), { kidmais: true, nome: 'Kidmais', a: 'a Kidmais', A: 'A Kidmais', da: 'da Kidmais',
        pela: 'pela Kidmais', equipe: 'equipe Kidmais', titulo: 'Kidmais', daMaiusculo: 'da KIDMAIS', pagamento: REGRAS_LEGADAS });
    const outra = textosMarca({ kidmais: false, nome: '  Buffet Alegria  ', pagamento: REGRAS_NEUTRAS });
    assert.equal(outra.nome, 'Buffet Alegria');
    assert.doesNotMatch(JSON.stringify(Object.values(outra)), /kidmais|cielo/i);
    assert.equal(textosMarca({ kidmais: false, nome: ' ', pagamento: REGRAS_NEUTRAS }).nome, 'Buffet');
});

// Toda menção à Kidmais nas telas públicas precisa estar atrás da marca (endereço atual) ou ser código interno.
const PERMITIDAS = [/CONTATO_KIDMAIS/, /ATENDIMENTO_KIDMAIS/, /origemInterna \? "Atendimento Kidmais"/, /marca\.kidmais \?/, /\{marca\.kidmais && /, /equipe = 'equipe Kidmais'/];
const PROTEGIDAS = ['Falar com a Kidmais no WhatsApp'];
for (const arquivo of ['components/fechamento/FechamentoWizard.tsx', 'components/fechamento/CalendarioDisponibilidade.tsx', 'components/disponibilidade/DisponibilidadePublica.tsx']) {
    test(`sem Kidmais fixa para outra empresa: ${arquivo}`, () => {
        const linhas = readFileSync(arquivo, 'utf8').replace(/\r\n/g, '\n').split('\n');
        const soltas = linhas.flatMap((linha, i) => {
            if (!/kidmais/i.test(linha) || PERMITIDAS.some((p) => p.test(linha))) return [];
            if (PROTEGIDAS.some((t) => linha.includes(t)) && linhas.slice(Math.max(0, i - 10), i).some((l) => /\{marca\.kidmais && /.test(l))) return [];
            return [`${i + 1}: ${linha.trim()}`];
        });
        assert.deepEqual(soltas, []);
        assert.doesNotMatch(linhas.join('\n'), /<KidmaisBrand\b/, 'cabeçalho passa por MarcaPublicaCabecalho');
    });
}

test('páginas /b/<código> usam o nome da própria empresa e metadados neutros, fora dos buscadores', () => {
    for (const pagina of ['fechamento', 'disponibilidade'])
        assert.match(readFileSync(`app/b/[empresa]/${pagina}/page.tsx`, 'utf8'), /<MarcaPublicaProvider nome=\{empresa\.nome\} pagamento=\{empresa\.pagamento\}>/);
    const guarda = readFileSync('app/b/[empresa]/empresa-publica.ts', 'utf8');
    assert.match(guarda, /nome = await nomePublicoDaEmpresa\(db\(\), escopo\.empresaId\)/);
    assert.match(guarda, /pagamento = \(await lerRegrasPagamento\(db\(\), escopo\.empresaId\)\) \?\? ANTES_DA_077/);
    assert.match(guarda, /icons: \{ icon: \[\{ url: "\/icone-orcamento\.svg"/);
    assert.match(guarda, /robots: \{ index: false, follow: false \}/);
    assert.doesNotMatch(guarda, /Kidmais"/);
});
