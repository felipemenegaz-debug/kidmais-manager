/** Verificações estáticas: não abrem conexão, não executam SQL e não substituem testes PostgreSQL. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';

const ler = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const up = ler('database/migrations/20261009_074a_planos_comerciais.sql');
const down = ler('database/rollback/20261009_074a_planos_comerciais_down.sql');
const antiga = ler('database/migrations/20261007_068_cobranca_assinatura.sql');
const extrair = (sql: string) => sql.match(/CREATE (?:OR REPLACE )?FUNCTION kidmais_068_assinatura_guarda\(\)[\s\S]*?END \$\$;/)![0].replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION');

test('074 rollback restaura literalmente a guarda 068 e recusa qualquer histórico novo sob lock', () => {
    assert.equal(extrair(down), extrair(antiga));
    const lock = down.indexOf('LOCK TABLE');
    const refusal = down.indexOf("RAISE EXCEPTION '074 rollback recusado");
    const drop = down.indexOf('DROP TABLE');
    assert.ok(lock > 0 && refusal > lock && drop > refusal);
    for (const table of ['assinatura_isencoes','assinatura_fundadores','assinatura_contratacoes'])
        assert.ok(down.includes(`EXISTS (SELECT 1 FROM ${table})`));
    assert.doesNotMatch(down, /\bCASCADE\b/i);
});

test('074 recusa guarda divergente e mantém delimitadores das funções íntegros', () => {
    const corpo = extrair(antiga).split('AS $$')[1].split('$$;')[0];
    const hash = createHash('md5').update(corpo.replace(/\s/g, '')).digest('hex');
    assert.ok(up.includes(hash));
    assert.ok(ler('database/checks/20261009_074a_precheck.sql').includes(hash));
    for (const sql of [up,down]) {
        assert.equal((sql.match(/\$\$/g) ?? []).length % 2, 0);
        assert.doesNotMatch(sql, /(?:AS|END) \$(?!\$)/);
    }
});

test('074 preserva transições, teste e identidade do legado; plano exige confirmação persistida', () => {
    const mensagens = [...extrair(antiga).matchAll(/RAISE EXCEPTION ('[^']*')/g)].map(m => m[1]);
    for (const mensagem of mensagens) assert.ok(extrair(up).includes(mensagem), mensagem);
    const transicoes = (s: string) => [...s.matchAll(/\('(?:TESTE|ATIVA|EM_ATRASO|CANCELADA_FIM_PERIODO|ENCERRADA)', '(?:TESTE|ATIVA|EM_ATRASO|CANCELADA_FIM_PERIODO|ENCERRADA)'\)/g)].map(m => m[0]);
    assert.deepEqual(transicoes(extrair(up)), transicoes(extrair(antiga)));
    assert.match(up, /c\.estado = 'CONFIRMADA' AND c\.plano = NEW\.plano AND c\.ciclo = NEW\.ciclo/);
    assert.match(up, /c\.empresa_id = NEW\.empresa_id/);
    assert.match(up, /c\.provedor_assinatura_id = NEW\.provedor_assinatura_id/);
    assert.match(up, /NEW\.situacao <> 'ATIVA'/);
});

test('074 não insere nem altera dados existentes; campanha limitada por índices únicos, não contagem prévia', () => {
    const semComentarios = up.replace(/--[^\n]*/g, '');
    assert.doesNotMatch(semComentarios, /\b(?:INSERT\s+INTO|UPDATE\s+(?:public\.)?\w+\s+SET|DELETE\s+FROM)\b/i);
    assert.match(up, /vaga BETWEEN 1 AND 20/);
    for (const key of ['vaga','empresa','documento']) assert.match(up, new RegExp(`CREATE UNIQUE INDEX assinatura_fundadores_${key}_uk[^;]+WHERE estado <> 'LIBERADA'`));
    assert.match(up, /DEFERRABLE INITIALLY DEFERRED/);
    assert.match(up, /OLD\.estado <> 'RESERVADA'/);
    assert.match(up, /interval '12 months'/);
    assert.match(up, /Empresa isenta não contrata nem ocupa vaga Fundador/);
});

test('074 checks são somente leitura; arquivos não guardam documento real nem migram por CNPJ informado', () => {
    for (const nome of ['precheck','postcheck']) {
        const sql = ler(`database/checks/20261009_074a_${nome}.sql`);
        assert.match(sql, /BEGIN TRANSACTION READ ONLY;/);
        assert.match(sql, /ROLLBACK;/);
        assert.doesNotMatch(sql, /\b(?:INSERT INTO|DELETE FROM|UPDATE\s+\w+\s+SET)\b/i);
    }
    assert.doesNotMatch(up + down, /20119900000160|20\.119\.900/);
    assert.doesNotMatch(up + down, /PLACEHOLDER/);
});
