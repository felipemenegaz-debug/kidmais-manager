import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { iniciarTeste } from './servico.ts';
import { prepararOferta, type PedidoOferta } from './ofertas.ts';
import { arquivarVersoesVigentes, enviarCopiaComprovante, lerComprovante, sinteseContratacao, versaoArquivada } from './comprovante.ts';
import { linhasComprovante } from './comprovante-texto.ts';
import { DOCUMENTOS, hashDocumento, textoCanonico } from '../cadastro/documentos-legais.ts';

/**
 * 096 — comprovante da contratação e arquivo das versões dos documentos legais (grupo B do parecer de apoio, 22/10/2026),
 * no PostgreSQL DESCARTÁVEL sobre o modelo 089. E-mail FALSO; documentos SINTÉTICOS com DV calculado:
 *   1. sem a 096: a contratação segue como antes, sem comprovante (código antes da migration);
 *   2. 096: precheck, aplicação, postcheck, reaplicação recusada, rollback vazio e reaplicação;
 *   3. arquivo das versões: idempotente, SHA-256 conferido pelo banco, imutável, mesma versão com outro texto recusada;
 *   4. oferta nova grava o comprovante na mesma transação (contratante mascarado, condições, versões); retomada não duplica;
 *      comprovante imutável; síntese e leitura;
 *   5. cópia por e-mail: chave desligada não envia; enviada uma vez; falha registrada sem apagar; registro único;
 *   6. rollback recusado com comprovante registrado.
 */
const ler = (f: string) => readFileSync(f, 'utf8');
const SQL = {
    pre: ler('database/checks/20261022_096_precheck.sql'), up: ler('database/migrations/20261022_096_comprovante_contratacao.sql'),
    post: ler('database/checks/20261022_096_postcheck.sql'), down: ler('database/rollback/20261022_096_comprovante_contratacao_down.sql'),
};
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';
const ENV = { ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox' };
const PEDIDO: PedidoOferta = { plano: 'essencial', ciclo: 'MENSAL', valorEsperadoCentavos: 11820, versao: '2026-10-20' };

let client: Client;
let usuario = '';
let seq = 0;
const q = (texto: string, params: unknown[] = []) => client.query(texto, params);
async function emTx<T>(acao: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try { const r = await acao(); await client.query('COMMIT'); return r; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
}
const withTransaction = <T>(t: (tx: never) => Promise<T>) => emTx(() => t(client as never));
async function erro(p: Promise<unknown>) { try { await p; return 'OK'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } }
function cnpj(n: number) {
    const base = `7${String(n).padStart(7, '0')}0001`;
    const dv = (b: string) => { let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r <= 1 ? 0 : 11 - r; };
    const d1 = dv(base); return base + d1 + dv(base + d1);
}
async function empresaEmTeste() {
    const n = ++seq;
    const empresaId = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Comprovante', 'PROVISIONAMENTO') RETURNING id", [`cv${n}${randomBytes(3).toString('hex')}`])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [empresaId]);
    await q(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
        VALUES ($1, 'Festas Comprovante Ltda', $2, 'Responsável', $3, $4, $4)`, [empresaId, cnpj(n), `cv${n}@example.test`, usuario]);
    await emTx(() => iniciarTeste(client as never, { empresaId, documento: cnpj(n) }));
    return { empresaId, documento: cnpj(n) };
}
const oferta = (empresaId: string) => emTx(() => prepararOferta(client as never, empresaId, usuario, PEDIDO, ENV));
const contar = async (sql: string, p: unknown[] = []) => Number((await q(sql, p)).rows[0].n);

test.before(async () => {
    if (!opt()) return;
    client = await conectarDescartavel();
    usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão Comprovante', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
        [`cv${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

let antes = '';
test('1. sem a 096: a contratação segue como antes, sem comprovante', { skip: !opt() }, async () => {
    assert.equal((await q("SELECT to_regclass('public.assinatura_comprovantes') IS NULL AS ok")).rows[0].ok, true);
    const { empresaId } = await empresaEmTeste();
    const o = await oferta(empresaId);
    assert.equal(o.estado, 'EM_ABERTO');
    antes = empresaId;
});

test('2. 096: precheck, aplicação, postcheck, reaplicação recusada, rollback vazio e reaplicação', { skip: !opt() }, async () => {
    await q(SQL.pre); await q(SQL.up); await q(SQL.post);
    await assert.rejects(q(SQL.up), /096 já aplicada/); await q('ROLLBACK').catch(() => undefined);
    await assert.rejects(q(SQL.pre), /aplicação anterior ou parcial/);
    await q(SQL.down);
    assert.equal((await q("SELECT to_regclass('public.assinatura_comprovantes') IS NULL AS ok")).rows[0].ok, true);
    await q(SQL.pre); await q(SQL.up); await q(SQL.post);
    // Oferta anterior à 096 continua sem comprovante (nada retroativo).
    assert.equal(await contar('SELECT count(*)::int AS n FROM assinatura_comprovantes WHERE empresa_id = $1', [antes]), 0);
});

test('3. arquivo das versões: idempotente, SHA-256 conferido pelo banco, imutável; mesma versão com outro texto recusada', { skip: !opt() }, async () => {
    const v1 = await emTx(() => arquivarVersoesVigentes(client as never));
    const v2 = await emTx(() => arquivarVersoesVigentes(client as never));
    assert.deepEqual(v1, v2);
    assert.deepEqual(v1, { DPA: DOCUMENTOS.DPA.versao, TERMOS_USO: DOCUMENTOS.TERMOS_USO.versao, PRIVACIDADE: DOCUMENTOS.PRIVACIDADE.versao });
    assert.equal(await contar('SELECT count(*)::int AS n FROM documentos_legais_versoes'), 3);
    for (const d of Object.values(DOCUMENTOS)) {
        const a = await emTx(() => versaoArquivada(client as never, d.documento, d.versao));
        assert.equal(a?.conteudo, textoCanonico(d)); assert.equal(a?.hash, hashDocumento(d));
        assert.equal(createHash('sha256').update(a!.conteudo, 'utf8').digest('hex'), a!.hash);
    }
    await assert.rejects(q("INSERT INTO documentos_legais_versoes (documento, versao, hash, conteudo) VALUES ('TERMOS_USO', '2026-01-01', $1, 'texto')", ['0'.repeat(64)]),
        /documentos_legais_versoes_conteudo_hash_check/);
    await assert.rejects(q("UPDATE documentos_legais_versoes SET conteudo = conteudo WHERE documento = 'DPA'"), /imutável/);
    await assert.rejects(q("DELETE FROM documentos_legais_versoes WHERE documento = 'DPA'"), /não é apagado/);
    // Texto mudou sem nova versão: o arquivo recusa (a versão aceita precisa corresponder ao texto guardado).
    const original = DOCUMENTOS.DPA.secoes;
    DOCUMENTOS.DPA.secoes = [...original, { titulo: 'Sintético', paragrafos: ['mudança sem nova versão'] }];
    try { assert.match(await erro(emTx(() => arquivarVersoesVigentes(client as never))), /já foi arquivada com outro texto/); }
    finally { DOCUMENTOS.DPA.secoes = original; }
});

let empresaB = '';
let ofertaB = '';
test('4. oferta nova grava o comprovante na mesma transação; retomada não duplica; imutável; síntese e leitura', { skip: !opt() }, async () => {
    const { empresaId, documento } = await empresaEmTeste();
    const o = await oferta(empresaId);
    const c = await emTx(() => lerComprovante(client as never, empresaId));
    assert.ok(c);
    assert.equal(c.contratacaoId, o.id);
    assert.deepEqual(c.contratante, { tipo: 'PJ', nome: 'Festas Comprovante Ltda', nomeComercial: 'Buffet Comprovante', documento: `${'*'.repeat(10)}${documento.slice(-4)}` });
    assert.ok(!JSON.stringify(c).includes(documento), 'documento completo não vai para o comprovante');
    assert.deepEqual([c.condicoes.plano, c.condicoes.ciclo, c.condicoes.valorFinalCentavos, c.condicoes.fundador], ['ESSENCIAL', 'MENSAL', 11820, { reservada: true, pagueAte: null }]);
    assert.deepEqual(c.documentos.map((d) => [d.documento, d.versao]).sort(), [['DPA', DOCUMENTOS.DPA.versao], ['PRIVACIDADE', DOCUMENTOS.PRIVACIDADE.versao], ['TERMOS_USO', DOCUMENTOS.TERMOS_USO.versao]]);
    const texto = linhasComprovante(c).join('\n');
    assert.match(texto, /Recebemos sua confirmação em .+ \(horário de Brasília\)/);
    assert.match(texto, new RegExp(`impressão digital ${hashDocumento(DOCUMENTOS.TERMOS_USO)}`));
    // Retomada da mesma oferta: nenhum comprovante novo.
    const de_novo = await oferta(empresaId);
    assert.equal(de_novo.id, o.id);
    assert.equal(await contar('SELECT count(*)::int AS n FROM assinatura_comprovantes WHERE empresa_id = $1', [empresaId]), 1);
    // Imutável: condições, contratante e versões não mudam; sem DELETE.
    await assert.rejects(q("UPDATE assinatura_comprovantes SET condicoes = '{}' WHERE contratacao_id = $1", [o.id]), /comprovante é imutável/);
    await assert.rejects(q('DELETE FROM assinatura_comprovantes WHERE contratacao_id = $1', [o.id]), /não é apagado/);
    await assert.rejects(q(`INSERT INTO assinatura_comprovantes (contratacao_id, empresa_id, usuario_id, contratante, condicoes, termos_versao, privacidade_versao, dpa_versao)
        VALUES ($1, $2, $3, '{}', '{}', '1999-01-01', '1999-01-01', '1999-01-01')`, [o.id, empresaId, usuario]), /versões do comprovante não arquivadas|duplicate key/);
    const s = await emTx(() => sinteseContratacao(client as never, empresaId));
    assert.equal(s.comprovante?.contratacaoId, o.id);
    assert.match(s.fornecedora, /\[RAZÃO SOCIAL DO NOVO CNPJ\]/, 'identidade da Kidmais segue por marcador (decisão de Felipe)');
    assert.deepEqual(s.documentos.map((d) => d.documento).sort(), ['DPA', 'PRIVACIDADE', 'TERMOS_USO']);
    empresaB = empresaId; ofertaB = o.id;
});

test('5. cópia por e-mail: chave desligada não envia; enviada uma vez; falha registrada sem apagar; registro único', { skip: !opt() }, async () => {
    const enviados: { para: string; assunto: string; texto: string; idempotencia?: string }[] = [];
    const ok = { withTransaction, enviarEmail: async (m: { para: string; assunto: string; texto: string; idempotencia?: string }) => { enviados.push(m); return { provedor: 'arquivo' as const, idExterno: null }; } };
    const entrada = { empresaId: empresaB, contratacaoId: ofertaB, usuarioId: usuario };
    assert.equal(await enviarCopiaComprovante(ok as never, entrada, {}), 'DESLIGADO');
    assert.equal(enviados.length, 0);
    assert.equal(await enviarCopiaComprovante(ok as never, entrada, { ASSINATURA_COMPROVANTE_EMAIL: 'true' }), 'ENVIADO');
    assert.equal(enviados.length, 1);
    assert.match(enviados[0].texto, /Recebemos sua confirmação/); assert.equal(enviados[0].idempotencia, `comprovante:${ofertaB}`);
    assert.equal(await enviarCopiaComprovante(ok as never, entrada, { ASSINATURA_COMPROVANTE_EMAIL: 'true' }), 'NADA_A_FAZER');
    assert.equal(enviados.length, 1, 'uma cópia só');
    // Falha: registrada, comprovante intacto e disponível.
    const { empresaId } = await empresaEmTeste();
    const o = await oferta(empresaId);
    const falho = { withTransaction, enviarEmail: async () => { throw new Error('provedor de e-mail fora'); } };
    assert.equal(await enviarCopiaComprovante(falho as never, { empresaId, contratacaoId: o.id, usuarioId: usuario }, { ASSINATURA_COMPROVANTE_EMAIL: 'true' }), 'FALHOU');
    const c = await emTx(() => lerComprovante(client as never, empresaId));
    assert.ok(c?.emailFalhouEm && !c.emailEnviadoEm);
    await assert.rejects(q('UPDATE assinatura_comprovantes SET email_enviado_em = now() WHERE contratacao_id = $1', [o.id]), /só o envio da cópia por e-mail é registrado, uma vez/);
});

test('6. rollback da 096 recusado com comprovante registrado; estado parcial recusado', { skip: !opt() }, async () => {
    await assert.rejects(q(SQL.down), /rollback recusado: já há versão arquivada ou comprovante/);
    await q('ROLLBACK').catch(() => undefined);
    await q('BEGIN');
    try {
        await q('DROP TRIGGER assinatura_comprovantes_096_guarda ON assinatura_comprovantes');
        await assert.rejects(q(SQL.down.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')), /migration ausente ou parcial/);
    } finally { await q('ROLLBACK'); }
    await q(SQL.post);
});
