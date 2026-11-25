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

// ---------------------------------------------------------------------------------------------------------------
// Piloto gratuito (22/10/2026): contratante provisionada pelo painel nasce sem cobrança; "iniciar-teste" cria a
// assinatura em TESTE com o CNPJ do cadastro, para que a Gestão possa contratar pela tela (Fundador incluído).
// ---------------------------------------------------------------------------------------------------------------

const PILOTO_CNPJ = '11444777000161';
async function contratante(chave: string, documento: string | null, status: 'ATIVA' | 'SUSPENSA' = 'ATIVA') {
    ids[chave] = (await client.query<{ id: string }>("INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id", [`e5-${chave.toLowerCase()}-${sufixo}`, `Buffet piloto ${chave}`])).rows[0].id;
    await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [ids[chave]]);
    await client.query(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
        VALUES ($1, $2, $3, 'Responsável piloto', $4, $5, $5)`, [ids[chave], `Buffet piloto ${chave} Ltda`, documento, email(chave.toLowerCase()), ids.dev]);
    if (status === 'SUSPENSA')
        await client.query("UPDATE empresas SET status = 'SUSPENSA' WHERE id = $1", [ids[chave]]);
}

test('piloto: iniciar teste recusa empresa sem documento, com CPF sem a 091 e a chave (CPF_INDISPONIVEL), suspensa, a Kidmais, sem cadastro e prazo fora de 1–90; nada é gravado', async () => {
    await contratante('piloto', PILOTO_CNPJ);
    await contratante('pilotoCpf', '52998224725');
    await contratante('pilotoCpfSemNome', '00000000191');
    await client.query('UPDATE plataforma_empresas_cadastro SET nome_empresarial = NULL WHERE empresa_id = $1', [ids.pilotoCpfSemNome]);
    await contratante('pilotoSemDoc', null);
    await contratante('pilotoSuspensa', '27865757000102', 'SUSPENSA');
    const kidmais = (await client.query<{ id: string }>("SELECT id FROM empresas WHERE codigo = 'kidmais'")).rows[0]?.id;
    assert.ok(kidmais, 'linha de base tem a empresa Kidmais');
    const dev = await sessaoDe(ids.dev);
    const fotografia = async () => [await contar('SELECT count(*)::int AS n FROM empresa_assinaturas'), await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'COMERCIAL_TESTE_INICIADO'")];
    const antes = await fotografia();
    const pedido = (dias: number) => ({ operacao: 'iniciar-teste', dias, motivo: 'Piloto gratuito antes da venda' });
    assert.equal(await erro(operar(dev, ids.pilotoSemDoc, pedido(30))), 'DADOS_INVALIDOS');
    // Decisão A de 22/10/2026: CPF participa do teste, mas só com a 091 e ASSINATURA_CPF_ATIVO (aceite na suíte documento-091).
    assert.equal(await erro(operar(dev, ids.pilotoCpf, pedido(30))), 'CPF_INDISPONIVEL');
    // Revisão completa 22/10 (P2-1): CPF sem nome civil na ficha não inicia teste (o nome do buffet não substitui o titular).
    assert.equal(await erro(operar(dev, ids.pilotoCpfSemNome, pedido(30))), 'DADOS_INVALIDOS');
    assert.equal(await erro(operar(dev, ids.pilotoSuspensa, pedido(30))), 'CONFLITO');
    assert.equal(await erro(operar(dev, kidmais, pedido(30))), 'CONFLITO');
    assert.equal(await erro(operar(dev, ids.semCobranca, pedido(30))), 'DADOS_INVALIDOS', 'empresa sem cadastro administrativo');
    assert.match(await erro(operar(dev, ids.piloto, pedido(91))), /too_big/);
    assert.match(await erro(operar(dev, ids.piloto, pedido(0))), /too_small/);
    assert.equal(await erro(operar(await sessaoDe(ids.gestao), ids.piloto, pedido(30))), 'NAO_ENCONTRADO');
    assert.equal(await erro(operar(await sessaoDe(ids.dev, 10), ids.piloto, pedido(30))), 'REAUTENTICACAO');
    assert.deepEqual(await fotografia(), antes);
});

test('piloto: iniciar teste grava TESTE com o CNPJ do cadastro e o prazo pedido, audita e não mexe em papel, vínculo nem concessão', async () => {
    const dev = await sessaoDe(ids.dev);
    const fotografia = async () => [await contar('SELECT count(*)::int AS n FROM plataforma_desenvolvedores WHERE revogado_em IS NULL'),
        await contar("SELECT count(*)::int AS n FROM memberships WHERE status = 'ATIVA'"), await contar('SELECT count(*)::int AS n FROM empresa_excecoes_comerciais')];
    const antes = await fotografia();
    const r = await operar(dev, ids.piloto, { operacao: 'iniciar-teste', dias: 70, motivo: 'Piloto gratuito até 31/12/2026' }) as unknown as { testeInicio: string; testeFim: string; comercial: { cobrado: boolean; situacao: string; nivel: string; motivo: string; ate: string } };
    assert.equal(Date.parse(r.testeFim) - Date.parse(r.testeInicio), 70 * 86_400_000);
    assert.deepEqual([r.comercial.cobrado, r.comercial.situacao, r.comercial.nivel, r.comercial.motivo, r.comercial.ate], [true, 'TESTE', 'COMPLETO', 'TESTE', r.testeFim]);
    const a = (await client.query('SELECT situacao, plano, documento_teste, provedor, provedor_assinatura_id FROM empresa_assinaturas WHERE empresa_id = $1', [ids.piloto])).rows[0];
    assert.deepEqual([a.situacao, a.plano, a.documento_teste, a.provedor, a.provedor_assinatura_id], ['TESTE', 'UNICO', PILOTO_CNPJ, null, null]);
    const audit = (await client.query("SELECT justificativa, origem, usuario_id, dados_depois FROM auditoria WHERE acao = 'COMERCIAL_TESTE_INICIADO' AND entidade_id = $1", [ids.piloto])).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].justificativa, audit[0].origem, audit[0].usuario_id, audit[0].dados_depois.dias, audit[0].dados_depois.empresaId], ['Piloto gratuito até 31/12/2026', 'PAINEL_DESENVOLVEDOR', ids.dev, 70, ids.piloto]);
    assert.deepEqual(await fotografia(), antes);
    // Segunda vez: a empresa já tem situação comercial (nada muda); a extensão existente passa a valer.
    assert.equal(await erro(operar(dev, ids.piloto, { operacao: 'iniciar-teste', dias: 10, motivo: 'Repetição indevida' })), 'CONFLITO');
    const e = await operar(dev, ids.piloto, { operacao: 'estender-teste', dias: 7, motivo: 'Venda abriu mais tarde' }) as unknown as { testeFim: string };
    assert.equal(Date.parse(e.testeFim) - Date.parse(r.testeFim), 7 * 86_400_000);
    const ficha = await svc.empresas.obterEmpresa(dev as never, ids.piloto as never) as unknown as { comercial: { historico: Array<{ acao: string }> } };
    assert.deepEqual(ficha.comercial.historico.map((h) => h.acao).sort(), ['COMERCIAL_TESTE_ESTENDIDO', 'COMERCIAL_TESTE_INICIADO']);
});

test('piloto + 074a: com a venda ligada, a contratante em teste vê os planos com Fundador e reserva a vaga com o CNPJ; a sem cobrança não', async () => {
    await client.query(readFileSync('database/migrations/20261009_074a_planos_comerciais.sql', 'utf8'));
    const ofertas = carregar('lib/assinatura/ofertas.ts');
    const planos = carregar('lib/assinatura/planos-comerciais.ts') as unknown as { valorComercial: (p: string, c: string, f: boolean) => number; condicoesComerciais: { versao: string } };
    const ligada = { ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox' };
    type Ofertas = { habilitado: boolean; fundador: boolean } | null;
    const ver = (empresa: string, env: Record<string, string>) => withTransaction((tx) => (ofertas.consultarOfertas as unknown as (tx: Client, e: string, env: Record<string, string>) => Promise<Ofertas>)(tx, empresa, env));
    const resumo = (o: Ofertas) => [o?.habilitado, o?.fundador];
    assert.deepEqual(resumo(await ver(ids.piloto, {})), [false, false], 'venda desligada: nada a contratar');
    assert.deepEqual(resumo(await ver(ids.semCobranca, ligada)), [false, false], 'sem assinatura: sem planos');
    assert.deepEqual(resumo(await ver(ids.piloto, ligada)), [true, true]);
    const valor = planos.valorComercial('essencial', 'mensal', true);
    const preparar = (empresa: string) => withTransaction((tx) => (ofertas.prepararOferta as unknown as (tx: Client, e: string, u: string, p: unknown) => Promise<{ desconto_percentual: number; valor_final_centavos: number; fundador_id: string | null }>)(tx, empresa, ids.dev,
        { plano: 'essencial', ciclo: 'MENSAL', valorEsperadoCentavos: valor, versao: planos.condicoesComerciais.versao }));
    const oferta = await preparar(ids.piloto);
    assert.deepEqual([oferta.desconto_percentual, oferta.valor_final_centavos, Boolean(oferta.fundador_id)], [40, valor, true]);
    const vaga = (await client.query('SELECT documento_beneficiario, estado FROM assinatura_fundadores WHERE empresa_id = $1', [ids.piloto])).rows;
    assert.deepEqual(vaga.map((v) => [v.documento_beneficiario, v.estado]), [[PILOTO_CNPJ, 'RESERVADA']]);
    assert.equal(await erro(preparar(ids.semCobranca)), 'EMPRESA_SEM_COBRANCA');
});

// Depois da 074a (contratacao_atual_id): o mesmo conjunto de colunas de production.
test('D-LAN-4: conferidores G-VAZIO e B5 reconhecem o teste do painel (iniciar + estender ×2) e só ele; adulteração ou extensão revogada sai do recorte', async () => {
    type Sq = Record<string, unknown> & { testeAutorizado: (a: string) => string; extensaoAutorizada: (a: string) => string; SQL_DEPENDENCIAS_RECORTE: string };
    const cg = req('../../scripts/conferidor-g-vazio.cjs') as Sq & { sqlContagem: (t: string) => string; SQL_AUDITORIAS_AUTORIZADAS: string };
    const b5 = req('../../scripts/conferencia-b5-producao.cjs') as Sq & { sqlContagem: (t: string, pronto: boolean) => string };
    assert.equal(b5.testeAutorizado('r'), cg.testeAutorizado('r'));
    const dep = (await client.query(cg.SQL_DEPENDENCIAS_RECORTE)).rows[0] as Record<string, boolean>;
    assert.ok(Object.values(dep).every((v) => v === true), `dependências do recorte: ${JSON.stringify(dep)}`);
    const dev = await sessaoDe(ids.dev);
    // Segunda extensão pelo painel (a primeira veio do teste anterior): o teste_fim passa a ser o testeFim da última.
    await operar(dev, ids.piloto, { operacao: 'estender-teste', dias: 3, motivo: 'Segunda extensão do piloto' });
    const autorizado = async (empresa: string) => (await client.query(`SELECT (${cg.testeAutorizado('r')}) IS TRUE AS ok FROM public.empresa_assinaturas r WHERE r.empresa_id = $1`, [empresa])).rows[0]?.ok as boolean;
    const extensoes = async (empresa: string) => (await client.query(`SELECT (${cg.extensaoAutorizada('r')}) IS TRUE AS ok FROM public.empresa_excecoes_comerciais r WHERE r.empresa_id = $1 AND r.tipo = 'EXTENSAO_TESTE' ORDER BY r.criado_em`, [empresa])).rows.map((x) => x.ok as boolean);
    assert.equal(await autorizado(ids.piloto), true, 'iniciado e estendido pelo painel');
    assert.deepEqual(await extensoes(ids.piloto), [true, true]);
    // Fixture gravada direto (sem INICIADO do painel) e vencida: fora do teste autorizado; a extensão dela também.
    assert.equal(await autorizado(ids.teste), false); assert.equal(await autorizado(ids.vencida), false);
    assert.deepEqual(await extensoes(ids.teste), [false]);
    // Contagens dos dois conferidores: só o piloto sai.
    const total = await contar('SELECT count(*)::int AS n FROM empresa_assinaturas');
    const gv = (await client.query(cg.sqlContagem('empresa_assinaturas'))).rows[0];
    assert.deepEqual([Number(gv.n), Number(gv.total)], [total - 1, total]);
    const bb = (await client.query(b5.sqlContagem('empresa_assinaturas', true))).rows[0];
    assert.deepEqual([Number(bb.linhas), Number(bb.fora_do_teste)], [total, total - 1]);
    const ex = (await client.query(b5.sqlContagem('empresa_excecoes_comerciais', true))).rows[0];
    assert.equal(Number(ex.extensoes_sem_vinculo), 1, 'só a extensão da fixture sem INICIADO');
    const gvx = (await client.query(cg.sqlContagem('empresa_excecoes_comerciais'))).rows[0];
    assert.equal(Number(gvx.total) - Number(gvx.n), 2, 'as duas extensões do piloto saem da contagem do G-VAZIO');
    const aut = (await client.query(cg.SQL_AUDITORIAS_AUTORIZADAS)).rows[0];
    assert.deepEqual([Number(aut.iniciados), Number(aut.estendidos)], [
        await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'COMERCIAL_TESTE_INICIADO' AND origem = 'PAINEL_DESENVOLVEDOR' AND dados_depois->>'resultado' = 'SUCESSO'"),
        await contar("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'COMERCIAL_TESTE_ESTENDIDO' AND origem = 'PAINEL_DESENVOLVEDOR' AND dados_depois->>'resultado' = 'SUCESSO'")]);
    // Adulterações (cada uma desfeita por ROLLBACK): nenhuma mantém o piloto no recorte.
    const sob = async (sql: string, params: unknown[]) => { await client.query('BEGIN'); try { await client.query(sql, params); return await autorizado(ids.piloto); } finally { await client.query('ROLLBACK'); } };
    assert.equal(await sob("UPDATE empresa_assinaturas SET teste_fim = teste_fim + interval '1 day' WHERE empresa_id = $1", [ids.piloto]), false, 'prazo fora da auditoria');
    assert.equal(await sob("UPDATE empresa_assinaturas SET provedor = 'ASAAS' WHERE empresa_id = $1", [ids.piloto]), false, 'cobrança ligada');
    assert.equal(await sob("UPDATE empresa_excecoes_comerciais SET revogada_em = clock_timestamp(), revogada_por = $2, motivo_revogacao = 'Revogada no teste' WHERE id = (SELECT id FROM empresa_excecoes_comerciais WHERE empresa_id = $1 AND tipo = 'EXTENSAO_TESTE' ORDER BY criado_em DESC LIMIT 1)", [ids.piloto, ids.dev]), false, 'extensão revogada: lado seguro');
    assert.equal(await sob("INSERT INTO auditoria (cliente_id, ator_tipo, usuario_id, acao, entidade_tipo, entidade_id, dados_antes, dados_depois, justificativa, origem) SELECT cliente_id, ator_tipo, usuario_id, acao, entidade_tipo, entidade_id, dados_antes, dados_depois, justificativa, origem FROM auditoria WHERE acao = 'COMERCIAL_TESTE_INICIADO' AND entidade_id = $1", [ids.piloto]), false, 'dois INICIADO');
    // Astra r1 de código, P1: revogar a PRIMEIRA das duas extensões (a que não define o teste_fim) também tira o piloto do recorte.
    assert.equal(await sob("UPDATE empresa_excecoes_comerciais SET revogada_em = clock_timestamp(), revogada_por = $2, motivo_revogacao = 'Revogada no teste' WHERE id = (SELECT id FROM empresa_excecoes_comerciais WHERE empresa_id = $1 AND tipo = 'EXTENSAO_TESTE' ORDER BY criado_em ASC LIMIT 1)", [ids.piloto, ids.dev]), false, 'primeira extensão revogada');
    // Astra r1 de código, P2: INICIADO sem testeFim (ou com testeFim torto) não sustenta o teste, mesmo com as extensões em ordem.
    // A auditoria é imutável (gatilho da 003): o gatilho sai só dentro da transação do sob, e o ROLLBACK o devolve.
    const sobVarios = async (sqls: string[], params: unknown[]) => { await client.query('BEGIN'); try { for (const s of sqls) await client.query(s, s.includes('$1') ? params : []); return await autorizado(ids.piloto); } finally { await client.query('ROLLBACK'); } };
    const semGatilho = (sql: string) => `ALTER TABLE auditoria DISABLE TRIGGER auditoria_bloquear_update_delete_trg; ${sql}`;
    assert.equal(await sobVarios([semGatilho("SELECT 1"), "UPDATE auditoria SET dados_depois = dados_depois - 'testeFim' WHERE acao = 'COMERCIAL_TESTE_INICIADO' AND entidade_id = $1"], [ids.piloto]), false, 'INICIADO sem testeFim');
    assert.equal(await sobVarios([semGatilho("SELECT 1"), "UPDATE auditoria SET dados_depois = jsonb_set(dados_depois, '{testeFim}', '\"amanha\"') WHERE acao = 'COMERCIAL_TESTE_INICIADO' AND entidade_id = $1"], [ids.piloto]), false, 'INICIADO com testeFim fora do formato');
    assert.equal(await autorizado(ids.piloto), true, 'nada ficou depois dos ROLLBACKs');
    // Astra r1 de código, P1/P2: B-15 no PG. O inventário traz o recorte linha a linha no mesmo comando (mesma fotografia).
    const b5x = b5 as unknown as { sqlDocumentos: (r: boolean) => string; SQL_ORIGENS_091: string; ORIGEM_CONTROLE: string; LEGADO_091: string[]; ORIGENS_091: string[];
        separarControle: (l: unknown[], t: string[]) => { dados: unknown[]; invisiveis: string[] }; inventarioDocumentos: (l: unknown[]) => { empresa_assinaturas: { total: number; foraDoTeste: number | null; recorteLido: number } };
        b15: (db: unknown, e: string, parou: boolean, pronto: boolean) => Promise<{ b15: { inventarioLegado: string; provaArtificialDocumentoLegado: string; legado: { empresa_assinaturas: { total: number; foraDoTeste: number | null } } } }> };
    const linhasDoc = (await client.query(b5x.sqlDocumentos(true))).rows as { origem: string; fora_do_teste: boolean | null }[];
    // Astra r3 de código, P1: uma linha de controle de visibilidade por relação do legado, no mesmo comando.
    const sep = b5x.separarControle(linhasDoc, b5x.LEGADO_091);
    assert.deepEqual(sep.invisiveis, []);
    const inv = b5x.inventarioDocumentos(sep.dados);
    assert.deepEqual([inv.empresa_assinaturas.total, inv.empresa_assinaturas.recorteLido, inv.empresa_assinaturas.foraDoTeste], [total, total, total - 1]);
    assert.ok(linhasDoc.filter((l) => l.origem === 'assinatura_fundadores').every((l) => l.fora_do_teste === null));
    // Decisão do B-15 com o banco reduzido ao piloto (e depois piloto + uma assinatura fora do teste), tudo desfeito no fim.
    // As transações READ ONLY do B-15 viram SAVEPOINTs dentro da transação do teste (o PG não aninha BEGIN).
    const aninhado = { query: (sql: string, p?: unknown[]) => client.query(sql === 'BEGIN TRANSACTION READ ONLY' ? 'SAVEPOINT b15' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT b15' : sql, p) };
    const decisao = async (manter: string[]) => {
        await client.query('BEGIN');
        try {
            // Histórico comercial não se apaga (gatilhos da 074 e FKs): modo réplica só nesta transação (SET LOCAL); o ROLLBACK desfaz tudo.
            await client.query("SET LOCAL session_replication_role = 'replica'");
            await client.query('DELETE FROM assinatura_fundadores');
            await client.query('DELETE FROM empresa_assinaturas WHERE NOT (empresa_id = ANY($1::uuid[]))', [manter]);
            return (await b5x.b15(aninhado, 'aplicada', false, true)).b15;
        } finally { await client.query('ROLLBACK'); }
    };
    const so = await decisao([ids.piloto]);
    assert.equal(so.inventarioLegado, 'SO_TESTE_AUTORIZADO', JSON.stringify(so));
    assert.match(so.provaArtificialDocumentoLegado, /^NAO_APLICAVEL_TESTE_AUTORIZADO/);
    const fora = await decisao([ids.piloto, ids.teste]);
    assert.equal(fora.inventarioLegado, 'COM_LINHAS', JSON.stringify(fora));
    assert.equal(fora.legado.empresa_assinaturas.foraDoTeste, 1);
    assert.match(fora.provaArtificialDocumentoLegado, /^EXIGIDA/);
    assert.equal(await contar('SELECT count(*)::int AS n FROM empresa_assinaturas'), total, 'as assinaturas voltaram');
    // Astra r2 de código, P1: com RLS ativa numa relação do predicado (papel sem bypass), a prova não some em silêncio: o recorte de
    // cada linha sai NULL no mesmo comando e o B-15 fica INDETERMINADO. Papel e RLS existem só nesta transação (ROLLBACK no fim).
    const comoLeitor = async <T>(rls: string[], fn: () => Promise<T>, manter?: string[]) => {
        await client.query('BEGIN');
        try {
            if (manter) {
                // Base reduzida como na decisão acima (sem Fundador), para que só o recorte decida entre "só teste" e INDETERMINADA.
                await client.query("SET LOCAL session_replication_role = 'replica'");
                await client.query('DELETE FROM assinatura_fundadores');
                await client.query('DELETE FROM empresa_assinaturas WHERE NOT (empresa_id = ANY($1::uuid[]))', [manter]);
            }
            await client.query('CREATE ROLE kidmais_b15_leitor_r3 NOLOGIN NOSUPERUSER NOBYPASSRLS');
            await client.query('GRANT USAGE ON SCHEMA public TO kidmais_b15_leitor_r3');
            await client.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO kidmais_b15_leitor_r3');
            for (const t of rls) await client.query(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
            await client.query('SET LOCAL ROLE kidmais_b15_leitor_r3');
            return await fn();
        } finally { await client.query('ROLLBACK'); }
    };
    const recorteComo = (rls: string[]) => comoLeitor(rls, async () => ((await client.query(b5x.sqlDocumentos(true))).rows as { origem: string; fora_do_teste: boolean | null }[]).filter((l) => l.origem === 'empresa_assinaturas'));
    // Controle: o mesmo papel, sem RLS, lê o recorte inteiro e acha o piloto.
    const controle = await recorteComo([]);
    assert.equal(controle.length, total);
    assert.ok(controle.every((l) => typeof l.fora_do_teste === 'boolean'));
    assert.equal(controle.filter((l) => l.fora_do_teste === false).length, 1);
    for (const t of ['auditoria', 'empresa_excecoes_comerciais']) {
        const linhas = await recorteComo([t]);
        assert.equal(linhas.length, total, t);
        assert.ok(linhas.every((l) => l.fora_do_teste === null), `RLS em ${t}: recorte NULL em todas as linhas`);
        const inv2 = b5x.inventarioDocumentos(linhas);
        assert.equal(inv2.empresa_assinaturas.foraDoTeste, null, `RLS em ${t}: nada publicado`);
    }
    // Pela função do B-15 inteira, com a base só do piloto: o mesmo papel sem RLS chega a "só teste"; com RLS só na auditoria,
    // INDETERMINADA, nunca "só teste" nem "fora".
    const b15Como = (rls: string[]) => comoLeitor(rls, async () => (await b5x.b15(aninhado, 'aplicada', false, true)).b15, [ids.piloto]);
    const soComo = await b15Como([]);
    assert.equal(soComo.inventarioLegado, 'SO_TESTE_AUTORIZADO', JSON.stringify(soComo));
    const indet = await b15Como(['auditoria']);
    assert.match(indet.provaArtificialDocumentoLegado, /^INDETERMINADA \(assinaturas com linha e recorte/, JSON.stringify(indet));
    assert.notEqual(indet.inventarioLegado, 'SO_TESTE_AUTORIZADO');
    assert.equal(indet.legado.empresa_assinaturas.foraDoTeste, null);
    // Sem SELECT numa relação do predicado o PG recusa o comando inteiro (42501): falha nomeada, nunca contagem.
    await assert.rejects(comoLeitor([], async () => {
        await client.query('RESET ROLE'); await client.query('REVOKE SELECT ON public.auditoria FROM kidmais_b15_leitor_r3'); await client.query('SET LOCAL ROLE kidmais_b15_leitor_r3');
        return client.query(b5x.sqlDocumentos(true));
    }), (e: { code?: string }) => e.code === '42501');
    // D-LAN-4 r4 (Astra r3, P1): RLS que esconde o legado aparece na linha de controle do PRÓPRIO comando (falsa), mesmo
    // com zero linhas lidas; o mesmo papel sem RLS tem todas verdadeiras. Assim a conferência prévia não é a única prova. (Origens 091: não existem neste banco; cobertas no unitário.)
    type Ctl = { origem: string; doc: string; visivel: boolean | null };
    const controleComo = (rls: string[], sql: string) => comoLeitor(rls, async () => ((await client.query(sql)).rows as Ctl[]).filter((l) => l.origem === b5x.ORIGEM_CONTROLE));
    for (const [sql, tabs] of [[b5x.sqlDocumentos(true), b5x.LEGADO_091], [b5x.sqlDocumentos(false), b5x.LEGADO_091]] as [string, string[]][]) {
        const livre = await controleComo([], sql);
        assert.deepEqual(livre.map((l) => [l.doc, l.visivel]), tabs.map((x) => [x, true]));
        for (const t of tabs) {
            const linhas = await comoLeitor([t], async () => (await client.query(sql)).rows as Ctl[]);
            const ctl = linhas.filter((l) => l.origem === b5x.ORIGEM_CONTROLE);
            assert.deepEqual(ctl.map((l) => [l.doc, l.visivel]), tabs.map((x) => [x, x !== t]), 'RLS em ' + t);
            assert.equal(linhas.filter((l) => l.origem === t).length, 0, 'RLS sem política esconde todas as linhas de ' + t);
            assert.deepEqual(b5x.separarControle(linhas, tabs).invisiveis, [t]);
        }
    }
    assert.equal(await contar("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'kidmais_b15_leitor_r3'"), 0, 'o papel não ficou');
});

test('G-VAZIO r3: prova de descarga no PostgreSQL real (sessão em transação aberta ou ativa = sem prova, mesmo parada há mais de 11 s; sessão que a sonda não enxerga = sem prova; todas ociosas há 11 s = provada; a própria sessão não conta)', { timeout: 120_000 }, async () => {
    type Esc = { total: number | null; invisiveis: number | null; recentes: number | null; descarregados: boolean };
    const cg = req('../../scripts/conferidor-g-vazio.cjs') as { lerEscritores: (db: Client) => Promise<Esc>; OCIOSO_MINIMO_S: number; VERSAO_MINIMA_STATS: number };
    assert.ok(Number((await client.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0].v) >= cg.VERSAO_MINIMA_STATS, 'cluster de prova com estatísticas cumulativas');
    const sonda = await conectarDescartavel({ travar: false });
    const escritor = await conectarDescartavel({ travar: false });
    const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
        // Escritor que gravou e ficou em transação aberta: o PG não descarrega as estatísticas dele.
        await escritor.query('BEGIN');
        await escritor.query('SELECT 1');
        const aberta = await cg.lerEscritores(sonda);
        assert.equal(aberta.descarregados, false, JSON.stringify(aberta));
        assert.ok((aberta.recentes ?? 0) >= 1 && aberta.invisiveis === 0, JSON.stringify(aberta));
        // Parada em transação aberta há mais de 11 s continua sem prova: só "idle" conta como descarregada.
        await pausa((cg.OCIOSO_MINIMO_S + 1) * 1000);
        const abertaAntiga = await cg.lerEscritores(sonda);
        assert.equal(abertaAntiga.descarregados, false, JSON.stringify(abertaAntiga));
        assert.ok((abertaAntiga.recentes ?? 0) >= 1, JSON.stringify(abertaAntiga));
        await escritor.query('ROLLBACK');
        // Sessão ativa (comando em curso) também não prova nada.
        const ativa = escritor.query('SELECT pg_sleep(3)');
        await pausa(600);
        const emCurso = await cg.lerEscritores(sonda);
        assert.equal(emCurso.descarregados, false, JSON.stringify(emCurso));
        await ativa;
        // Ociosa há uns 3 s (menos de 11 s): ainda sem prova.
        await pausa(3000);
        const logo = await cg.lerEscritores(sonda);
        assert.equal(logo.descarregados, false, JSON.stringify(logo));
        // Todas as outras sessões ociosas há mais de 11 s: provada; a sonda lê várias vezes e nunca conta a si mesma.
        await pausa((cg.OCIOSO_MINIMO_S + 1) * 1000);
        const ok = await cg.lerEscritores(sonda);
        assert.deepEqual({ ...ok, total: ok.total !== null && ok.total >= 2 }, { total: true, invisiveis: 0, recentes: 0, descarregados: true }, JSON.stringify(ok));
        // Papel sem pg_read_all_stats vê as outras sessões sem estado: invisíveis, nunca "descarregadas".
        await sonda.query('CREATE ROLE kidmais_escritores_cego_r3 NOLOGIN NOSUPERUSER');
        try {
            await sonda.query('SET ROLE kidmais_escritores_cego_r3');
            const cego = await cg.lerEscritores(sonda);
            assert.equal(cego.descarregados, false, JSON.stringify(cego));
            assert.ok((cego.invisiveis ?? 0) >= 1, JSON.stringify(cego));
        } finally { await sonda.query('RESET ROLE'); await sonda.query('DROP ROLE kidmais_escritores_cego_r3'); }
    } finally {
        await escritor.query('ROLLBACK').catch(() => undefined);
        await encerrarDescartavel(escritor);
        await encerrarDescartavel(sonda);
    }
});
