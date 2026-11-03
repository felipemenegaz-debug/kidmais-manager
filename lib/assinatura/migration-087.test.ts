/** Verificações estáticas da 087: não abrem conexão nem executam SQL e não substituem a suíte PostgreSQL. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { TIPOS_AVISO } from './avisos.ts';
import { PREFIXO_IDEMPOTENCIA_AVISO } from './avisos-mensagens.ts';

const ler = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const up = ler('database/migrations/20261019_087_assinatura_avisos.sql');
const pre = ler('database/checks/20261019_087_precheck.sql');
const post = ler('database/checks/20261019_087_postcheck.sql');
const down = ler('database/rollback/20261019_087_assinatura_avisos_down.sql');
const lista = (sql: string, coluna: string) => sql.match(new RegExp(`${coluna} text NOT NULL[^,]*?CHECK \\(${coluna} IN \\(([^)]*)\\)\\)`, 's'))![1].match(/'([A-Z0-9_]+)'/g)!.map((s) => s.slice(1, -1));

test('087: transação única, recusa reaplicação e exige a 068; não altera nenhuma tabela existente', () => {
    assert.match(up, /^-- PREPARADA, NÃO APLICADA/);
    assert.equal(up.match(/^BEGIN;$/gm)?.length, 1);
    assert.equal(up.match(/^COMMIT;$/gm)?.length, 1);
    assert.match(up, /RAISE EXCEPTION '087 exige a 068 instalada\.'/);
    assert.match(up, /RAISE EXCEPTION '087 já aplicada total ou parcialmente\.'/);
    assert.doesNotMatch(up, /\bALTER TABLE\b|\bDROP\b|\bUPDATE\s+(?!OR)\w+\s+SET\b|\bDELETE FROM\b|\bTRUNCATE\s+(?!ON\b)\w/i);
    assert.equal((up.match(/\$\$/g) ?? []).length % 2, 0);
    assert.match(up, /SET search_path = pg_catalog, pg_temp/);
});

test('087: tipos e chave idempotente iguais aos do código; UNIQUE por evento e pessoa', () => {
    assert.deepEqual(lista(up, 'tipo'), [...TIPOS_AVISO]);
    assert.deepEqual(lista(up, 'estado'), ['PENDENTE', 'ENVIANDO', 'ENVIADO', 'INCERTO', 'DESCARTADO', 'DEVOLVIDO']);
    assert.ok(up.includes(`mensagem->>'idempotencia' = '${PREFIXO_IDEMPOTENCIA_AVISO}' || id::text`));
    assert.match(up, /CONSTRAINT assinatura_avisos_087_um_por_evento UNIQUE \(empresa_id, tipo, marco, destinatario_id\)/);
    assert.ok(ler('lib/assinatura/avisos-repositorio.ts').includes('ON CONFLICT ON CONSTRAINT assinatura_avisos_087_um_por_evento DO NOTHING'));
});

test('087: guarda append-only, conteúdo imutável, só Gestão ativa da própria empresa e transições do envio', () => {
    assert.match(up, /IF TG_OP IN \('DELETE','TRUNCATE'\) THEN RAISE EXCEPTION/);
    assert.match(up, /m\.papel = 'REPRESENTANTE_AUTORIZADO' AND u\.ativo/);
    assert.match(up, /m\.empresa_id = NEW\.empresa_id AND m\.usuario_id = NEW\.destinatario_id AND m\.status = 'ATIVA'/);
    assert.match(up, /Destino e mensagem do aviso são imutáveis/);
    assert.match(up, /\(OLD\.estado = 'PENDENTE' AND NEW\.estado IN \('ENVIANDO','DESCARTADO'\)\)/);
    assert.match(up, /\(OLD\.estado = 'ENVIANDO' AND NEW\.estado IN \('ENVIADO','INCERTO'\)\)/);
    assert.match(up, /\(OLD\.estado = 'ENVIADO' AND NEW\.estado = 'DEVOLVIDO'\)\)/);
    assert.match(up, /BEFORE INSERT OR UPDATE OR DELETE ON assinatura_avisos FOR EACH ROW/);
    assert.match(up, /BEFORE TRUNCATE ON assinatura_avisos FOR EACH STATEMENT/);
});

test('087: checks somente leitura sem dados pessoais; rollback recusa histórico, sob lock e sem CASCADE', () => {
    for (const sql of [pre, post]) {
        assert.match(sql, /^-- PREPARADO, NÃO EXECUTADO\. Somente leitura/);
        assert.match(sql, /BEGIN TRANSACTION READ ONLY;/);
        assert.match(sql, /ROLLBACK;\s*$/);
        assert.doesNotMatch(sql, /mensagem|email|destinatario_id/);
    }
    assert.match(post, /assinatura_avisos_087_guarda','assinatura_avisos_087_truncate/);
    const lock = down.indexOf('LOCK TABLE public.assinatura_avisos'), recusa = down.indexOf("RAISE EXCEPTION '087: rollback recusado com histórico.'"), drop = down.indexOf('DROP TABLE');
    assert.ok(lock > 0 && recusa > lock && drop > recusa);
    assert.doesNotMatch(down, /\bCASCADE\b/i);
});
