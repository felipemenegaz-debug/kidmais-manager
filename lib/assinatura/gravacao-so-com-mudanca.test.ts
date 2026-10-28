import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * B-14 (plano rev. 8.1, §3.3.1): no processamento compartilhado de cobrança, todo UPDATE só grava quando algum valor muda.
 * Teste estático: cada `UPDATE <tabela> SET` destes seis módulos tem a guarda `IS DISTINCT FROM` no próprio comando ou a
 * etiqueta `// B14: <classe>` logo antes da chamada. A prova de comportamento é a idempotência por fotografia (PostgreSQL);
 * este teste só impede que um UPDATE novo entre sem classificação.
 */
const RAIZ = path.resolve(import.meta.dirname, '..', '..');
export const MODULOS = [
    'lib/creditos/pagamento.ts', 'lib/creditos/ledger.ts', 'lib/assinatura/sincronizacao.ts', 'lib/assinatura/ofertas.ts',
    'lib/assinatura/devolucao-registro.ts', 'lib/assinatura/reconciliacao-contratacao.ts',
];
const CLASSES = ['observação', 'transição', 'efeito', 'fora', 'pessoa'] as const;

export type Atualizacao = { arquivo: string; linha: number; tabela: string; comando: string; etiqueta: string | null };

/** Encontra cada UPDATE … SET, recorta o comando até o fim do literal e lê a etiqueta B14 acima da chamada. */
export function atualizacoes(arquivo: string, texto: string): Atualizacao[] {
    const linhas = texto.split('\n');
    const achadas: Atualizacao[] = [];
    linhas.forEach((l, i) => {
        const m = /\bUPDATE\s+([a-z_]+)\s+SET\b/.exec(l);
        if (!m || /^\s*(\/\/|\*)/.test(l)) return;
        const aspas = l.slice(0, m.index).match(/[`'"](?=[^`'"]*$)/)?.[0] ?? '`';
        let comando = l.slice(m.index);
        for (let j = i + 1; j < linhas.length && !comando.slice(1).includes(aspas); j++) comando += '\n' + linhas[j];
        let ini = i;
        while (ini > 0 && !/tx\.query\(/.test(linhas[ini]) && i - ini < 3) ini--;
        const acima = linhas[ini - 1] ?? '';
        const etiqueta = /\/\/ B14: (\S+)/.exec(acima)?.[1] ?? null;
        achadas.push({ arquivo, linha: i + 1, tabela: m[1], comando: comando.slice(0, comando.indexOf(aspas, 1) + 1 || undefined), etiqueta });
    });
    return achadas;
}

export function semGuarda(a: Atualizacao) {
    return !/IS DISTINCT FROM/.test(a.comando) && !(a.etiqueta && CLASSES.includes(a.etiqueta as (typeof CLASSES)[number]));
}

test('todo UPDATE do processamento compartilhado tem guarda IS DISTINCT FROM ou etiqueta B14', () => {
    const todas = MODULOS.flatMap((m) => atualizacoes(m, fs.readFileSync(path.join(RAIZ, m), 'utf8')));
    assert.ok(todas.length >= 40, `poucos UPDATE encontrados (${todas.length}): o recorte deixou de ver o código`);
    const faltando = todas.filter(semGuarda).map((a) => `${a.arquivo}:${a.linha} (${a.tabela})`);
    assert.deepEqual(faltando, []);
});

test('transição exige estado de origem no WHERE', () => {
    const todas = MODULOS.flatMap((m) => atualizacoes(m, fs.readFileSync(path.join(RAIZ, m), 'utf8')));
    const fracas = todas.filter((a) => a.etiqueta === 'transição' && !/IS DISTINCT FROM/.test(a.comando)
        && !/WHERE[\s\S]*(\bIN\s*\(|<>|IS NULL|=\s*'[A-Z_]+')/.test(a.comando)).map((a) => `${a.arquivo}:${a.linha}`);
    assert.deepEqual(fracas, []);
});

test('o recorte reconhece guarda, etiqueta e ausência das duas', () => {
    const fonte = [
        "await tx.query('UPDATE t SET a = $2 WHERE id = $1 AND a IS DISTINCT FROM $2', [x]);",
        '// B14: observação — cursor.',
        "await tx.query('UPDATE t SET visto_em = now() WHERE id = $1', [x]);",
        "await tx.query('UPDATE t SET a = $2 WHERE id = $1', [x]);",
        '// B14: inventada — não vale.',
        "await tx.query('UPDATE t SET b = $2 WHERE id = $1', [x]);",
        '// FOR NO KEY UPDATE em comentário não conta.',
    ].join('\n');
    const achadas = atualizacoes('x.ts', fonte);
    assert.deepEqual(achadas.map((a) => [a.linha, semGuarda(a)]), [[1, false], [3, false], [4, true], [6, true]]);
});
