import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * Painel comercial do desenvolvedor (E5) no PostgreSQL DESCARTÁVEL: modelo "063" + 067 + 068 aplicadas aqui.
 * Intervenções só com concessão de desenvolvedor, senha recente, motivo e prazo; auditadas; nunca concedem papel,
 * vínculo ou concessão de desenvolvedor; empresa sem cobrança não recebe exceção; ficha e lista mostram o comercial.
 */
const req = createRequire(import.meta.url);
process.env.ADMIN_AUTH_SECRET = `segredo-sintetico-de-teste-${'x'.repeat(24)}`;
process.env.EMAIL_PROVIDER = 'desativado';

type Fn = (...args: never[]) => Promise<never>;
type Mod = Record<string, Fn>;
let client: Client;
const cache = new Map<string, Record<string, unknown>>();
const carregar = (f: string) => carregarModulo(f, { 'db/postgres': { db: () => client, withTransaction } }, cache) as Mod;
async function withTransaction<T>(work: (tx: Client) => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try {
        const r = await work(client);
        await client.query('COMMIT');
        return r;
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}
const sufixo = randomBytes(3).toString('hex');
const email = (nome: string) => `e5-${nome}-${sufixo}@exemplo.test`;
const ctx = () => ({ requestId: randomUUID(), ip: null, userAgent: 'teste-e5' });
const ids: Record<string, string> = {};
let svc: { auth: Mod; comercial: Mod; empresas: Mod };
const deps = () => ({ withTransaction, registrarAuditoria: (carregar('lib/clientes/repositories/auditoria.repository.ts') as unknown as { registrarAuditoria: Fn }).registrarAuditoria });
const contar = async (sql: string, params: unknown[] = []) => (await client.query<{ n: number }>(sql, params)).rows[0].n;
async function sessaoDe(usuarioId: string, reautenticadoHaMin = 0) {
    const nova = await withTransaction((tx) => (svc.auth.criarSessaoAdministrativa as unknown as (tx: Client, u: string, ip: null, ua: null) => Promise<{ token: string }>)(tx, usuarioId, null, null));
    if (reautenticadoHaMin > 0)
        await client.query(`UPDATE sessoes_administrativas SET criado_em = clock_timestamp() - make_interval(mins => $2), autenticado_em = clock_timestamp() - make_interval(mins => $2) WHERE revogado_em IS NULL AND usuario_id = $1`, [usuarioId, reautenticadoHaMin]);
    return (svc.auth.consultarSessao as unknown as (t: string) => Promise<Record<string, string>>)(nova.token);
}
async function erro(p: Promise<unknown>) {
    try {
        await p;
        return 'OK';
    }
    catch (e) {
        return (e as { code?: string }).code ?? (e as Error).message;
    }
}
const operar = (sessao: unknown, empresaId: string, dados: unknown) => svc.comercial.operarComercial(sessao as never, empresaId as never, dados as never, ctx() as never, deps() as never);

test.before(async () => {
    client = await conectarDescartavel();
    svc = { auth: carregar('lib/autenticacao/service.ts'), comercial: carregar('lib/desenvolvedor/comercial.ts'), empresas: carregar('lib/desenvolvedor/empresas.ts') };
});
test.after(async () => {
    if (client)
        await encerrarDescartavel(client);
});

test('E5: 067 + 068 aplicadas; fixtures sintéticas (dev, Gestão, empresas com e sem cobrança)', async () => {
    for (const f of ['database/migrations/20261006_067_modelo_comercial_empresa.sql', 'database/checks/20261007_068_precheck.sql', 'database/migrations/20261007_068_cobranca_assinatura.sql', 'database/checks/20261007_068_postcheck.sql'])
        await client.query(readFileSync(f, 'utf8'));
    const senha = (carregar('lib/autenticacao/senha.ts') as unknown as { criarHashSenha: (s: string) => Promise<string> }).criarHashSenha;
    for (const chave of ['dev', 'gestao'])
        ids[chave] = (await client.query<{ id: string }>("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel) VALUES ($1, $2, $3, 'ADMINISTRATIVO') RETURNING id",
            [email(chave), `Pessoa ${chave}`, await senha(`senha-${chave}-e5`)])).rows[0].id;
    // Senha trocada antes das sessões do teste (uma sessão autenticada antes da troca não vale).
    await client.query("UPDATE usuarios_administrativos SET senha_alterada_em = clock_timestamp() - interval '1 hour' WHERE id = ANY($1::uuid[])", [[ids.dev, ids.gestao]]);
    const cli = req('../../scripts/admin-provision.cjs') as { alterarDesenvolvedor: (c: Client, i: Record<string, string>) => Promise<unknown> };
    await cli.alterarDesenvolvedor(client, { operacao: 'conceder', email: email('dev'), operador: 'Teste E5', motivo: 'Desenvolvedor sintético' });
    for (const [chave, docTeste, inicio, fim] of [['teste', '11222333000181', '-2 days', '13 days'], ['vencida', '45723174000110', '-100 days', '-85 days'], ['semCobranca', null, null, null]] as const) {
        ids[chave] = (await client.query<{ id: string }>("INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id", [`e5-${chave.toLowerCase()}-${sufixo}`, `Buffet E5 ${chave}`])).rows[0].id;
        await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [ids[chave]]);
        if (docTeste)
            await client.query("INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim, documento_teste) VALUES ($1, 'TESTE', clock_timestamp() + $3::interval, clock_timestamp() + $4::interval, $2)", [ids[chave], docTeste, inicio, fim]);
    }
    const m = (await client.query<{ id: string }>("INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id", [ids.teste, ids.gestao])).rows[0].id;
    await client.query("UPDATE memberships SET status = 'ATIVA' WHERE id = $1", [m]);
});

test('autorização: Gestão sem concessão → 404; desenvolvedor sem senha recente → reautenticação; nada muda', async () => {
    const antes = await contar('SELECT count(*)::int AS n FROM empresa_excecoes_comerciais');
    assert.equal(await erro(operar(await sessaoDe(ids.gestao), ids.teste, { operacao: 'estender-teste', dias: 5, motivo: 'Tentativa sem concessão' })), 'NAO_ENCONTRADO');
    assert.equal(await erro(operar(await sessaoDe(ids.dev, 10), ids.teste, { operacao: 'estender-teste', dias: 5, motivo: 'Senha antiga' })), 'REAUTENTICACAO');
    // Motivo curto: recusado pela validação (ZodError → 400 DADOS_INVALIDOS na rota) antes de abrir a transação.
    assert.match(await erro(operar(await sessaoDe(ids.dev), ids.teste, { operacao: 'estender-teste', dias: 5, motivo: 'oi' })), /too_small/);
    assert.equal(await contar('SELECT count(*)::int AS n FROM empresa_excecoes_comerciais'), antes);
});

test('estender teste: prazo avança, exceção e auditoria com motivo; nenhum papel, vínculo ou concessão de desenvolvedor muda', async () => {
    const dev = await sessaoDe(ids.dev);
    const fotografia = async () => [await contar('SELECT count(*)::int AS n FROM plataforma_desenvolvedores WHERE revogado_em IS NULL'),
        await contar("SELECT count(*)::int AS n FROM memberships WHERE status = 'ATIVA'"), await contar("SELECT count(*)::int AS n FROM usuarios_administrativos WHERE papel = 'REPRESENTANTE_AUTORIZADO'")];
    const antes = await fotografia();
    const fimAntes = (await client.query("SELECT teste_fim FROM empresa_assinaturas WHERE empresa_id = $1", [ids.teste])).rows[0].teste_fim as Date;
    const r = await operar(dev, ids.teste, { operacao: 'estender-teste', dias: 7, motivo: 'Implantação atrasada pela plataforma' }) as unknown as { testeFim: string; comercial: { nivel: string } };
    assert.equal(Date.parse(r.testeFim) - fimAntes.getTime(), 7 * 86_400_000);
    assert.equal(r.comercial.nivel, 'COMPLETO');
    const audit = (await client.query("SELECT justificativa, origem, usuario_id, dados_depois FROM auditoria WHERE acao = 'COMERCIAL_TESTE_ESTENDIDO' AND entidade_id = $1", [ids.teste])).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].justificativa, audit[0].origem, audit[0].usuario_id, audit[0].dados_depois.dias, audit[0].dados_depois.empresaId], ['Implantação atrasada pela plataforma', 'PAINEL_DESENVOLVEDOR', ids.dev, 7, ids.teste]);
    assert.deepEqual(await fotografia(), antes);
});

test('cortesia em empresa vencida libera; revogação devolve; empresa sem cobrança recusa; tudo auditado', async () => {
    const dev = await sessaoDe(ids.dev);
    const c = await operar(dev, ids.vencida, { operacao: 'conceder-excecao', tipo: 'CORTESIA', dias: 30, motivo: 'Parceiro de lançamento' }) as unknown as { excecaoId: string; comercial: { nivel: string; motivo: string } };
    assert.deepEqual([c.comercial.nivel, c.comercial.motivo], ['COMPLETO', 'EXCECAO_COMERCIAL']);
    assert.equal(await erro(operar(dev, ids.teste, { operacao: 'revogar-excecao', excecaoId: c.excecaoId, motivo: 'Empresa errada' })), 'NAO_ENCONTRADO');
    const r = await operar(dev, ids.vencida, { operacao: 'revogar-excecao', excecaoId: c.excecaoId, motivo: 'Parceria encerrada' }) as unknown as { comercial: { nivel: string } };
    assert.equal(r.comercial.nivel, 'BLOQUEADO');
    assert.equal(await erro(operar(dev, ids.semCobranca, { operacao: 'conceder-excecao', tipo: 'ACESSO_TEMPORARIO', dias: 5, motivo: 'Sem assinatura' })), 'CONFLITO');
    assert.equal(await contar("SELECT count(*)::int AS n FROM auditoria WHERE entidade_id = $1 AND acao IN ('COMERCIAL_EXCECAO_CONCEDIDA', 'COMERCIAL_EXCECAO_REVOGADA')", [ids.vencida]), 2);
});

test('ficha e lista mostram plano, situação, datas, exceções e histórico; empresa sem cobrança aparece como tal', async () => {
    const dev = await sessaoDe(ids.dev);
    const ficha = await svc.empresas.obterEmpresa(dev as never, ids.vencida as never) as unknown as { comercial: { cobrado: boolean; situacao: string; nivel: string; excecoes: Array<{ tipo: string; vigente: boolean; motivo: string }>; historico: Array<{ acao: string }> } };
    assert.deepEqual([ficha.comercial.cobrado, ficha.comercial.situacao, ficha.comercial.nivel], [true, 'TESTE', 'BLOQUEADO']);
    assert.deepEqual(ficha.comercial.excecoes.map((x) => [x.tipo, x.vigente, x.motivo]), [['CORTESIA', false, 'Parceiro de lançamento']]);
    assert.deepEqual(ficha.comercial.historico.map((h) => h.acao).sort(), ['COMERCIAL_EXCECAO_CONCEDIDA', 'COMERCIAL_EXCECAO_REVOGADA']);
    const lista = await svc.empresas.listarEmpresas(dev as never, {} as never) as unknown as { itens: Array<{ id: string; comercial: { cobrado: boolean; nivel: string } }> };
    const por = Object.fromEntries(lista.itens.map((i) => [i.id, i.comercial]));
    assert.deepEqual([por[ids.teste].cobrado, por[ids.teste].nivel], [true, 'COMPLETO']);
    assert.deepEqual([por[ids.semCobranca].cobrado, por[ids.semCobranca].nivel], [false, 'COMPLETO']);
});
