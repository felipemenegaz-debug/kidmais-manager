import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../../comercial/postgres-descartavel.ts';
import { hashSnapshotContrato } from '../../contratos/services/snapshot-core.ts';
import { carregarModulo } from '../../acessos/teste-carregador.ts';

/**
 * 066 — chave Pix da empresa e Pix copia e cola das parcelas, no PostgreSQL DESCARTÁVEL (modelo "atual" + 066
 * aplicada aqui). Cobre: pre/postcheck, CHECKs do banco, Gestão + reautenticação, versão, auditoria mascarada,
 * isolamento entre empresas (parcela e configuração), saldo da parcela no valor do QR e rollback.
 */
const sql = (arquivo: string) => readFileSync(arquivo, 'utf8');
const MIGRATION = 'database/migrations/20261006_066_pix_recebimento_empresa.sql';
const ROLLBACK = 'database/rollback/20261006_066_pix_recebimento_empresa_down.sql';
const PRE = 'database/checks/20261006_066_precheck.sql';
const POS = 'database/checks/20261006_066_postcheck.sql';

type Fn = (...args: never[]) => Promise<never>;
let client: Client;
const codigo = () => `pix${randomBytes(3).toString('hex')}`;
const ids: Record<string, string> = {};
let pix: Record<string, Fn>;

async function erroDe(p: Promise<unknown>) {
    try {
        await p;
        return 'OK';
    } catch (error) {
        return (error as { code?: string }).code ?? (error as Error).message;
    }
}

async function empresa(nome: string) {
    const id = (await client.query<{ id: string }>("INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id", [codigo(), nome])).rows[0].id;
    await client.query("UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid", [id]);
    return id;
}

async function usuario() {
    return (await client.query<{ id: string }>(
        "INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Pix teste', $2, 'ADMINISTRATIVO', true) RETURNING id",
        [`${codigo()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
}

/** Contrato assinado com uma parcela de R$ 1.250,00 em aberto (mesma cadeia da suíte da baixa). */
async function parcelaEmAberto(empresaId: string) {
    const pacote = (await client.query<{ id: string }>("INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Festa Pix', 1, true, true) RETURNING id", [empresaId, codigo().toUpperCase()])).rows[0].id;
    const tabela = (await client.query<{ id: string }>("INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela Pix', '2026-01-01', false, $2::uuid) RETURNING id", [codigo(), empresaId])).rows[0].id;
    const preco = (await client.query<{ id: string }>("INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 1250, 'PADRAO') RETURNING id", [tabela, pacote])).rows[0].id;
    const agenda = (await client.query<{ id: string }>("INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, 'Agenda Pix', '10:00', '18:00', 9) RETURNING id", [codigo()])).rows[0].id;
    const cliente = (await client.query<{ id: string }>("INSERT INTO clientes (nome_completo, empresa_id) VALUES ('Cliente Pix', $1::uuid) RETURNING id", [empresaId])).rows[0].id;
    const fechamento = (await client.query<{ id: string }>(
        `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
           categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
         VALUES ('2026-11-20', '14:00', '18:00', $1::uuid, $5::uuid, $2::uuid, $3::uuid, $4::uuid, 'PADRAO', 'PADRAO', 20, 20, 1250, 1250, 1250, 'ATENDIMENTO_KIDMAIS', $6::uuid, 'AGUARDANDO_PAGAMENTO') RETURNING id`,
        [agenda, pacote, tabela, preco, empresaId, cliente])).rows[0].id;
    const contrato = (await client.query<{ id: string }>("INSERT INTO contratos (fechamento_id, status, assinado_em) VALUES ($1::uuid, 'ASSINADO', now()) RETURNING id", [fechamento])).rows[0].id;
    const snapshot = { comercial: { valorFinalContrato: 1250 }, evento: { data: '2026-11-20' } };
    const versao = (await client.query<{ id: string }>(
        `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
         VALUES ($1::uuid, 1, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP') RETURNING id`,
        [contrato, JSON.stringify(snapshot), hashSnapshotContrato(snapshot), 'd'.repeat(64)])).rows[0].id;
    const pagamento = (await client.query<{ id: string }>('INSERT INTO pagamentos (contrato_versao_id, valor_total_contratado) VALUES ($1::uuid, 1250) RETURNING id', [versao])).rows[0].id;
    const plano = (await client.query<{ id: string }>("INSERT INTO pagamento_planos (pagamento_id, numero_versao, meio_pagamento, modalidade, quantidade_parcelas) VALUES ($1::uuid, 1, 'PIX', 'AVISTA', 1) RETURNING id", [pagamento])).rows[0].id;
    return (await client.query<{ id: string }>("INSERT INTO pagamento_parcelas (plano_id, numero, valor_previsto, vencimento, confirma_reserva) VALUES ($1::uuid, 1, 1250, '2026-11-01', false) RETURNING id", [plano])).rows[0].id;
}

const agora = () => new Date().toISOString();
const sessao = (usuarioId: string, autenticadoEm = agora()) => ({ usuario_id: usuarioId, autenticado_em: autenticadoEm, papel: 'ADMINISTRATIVO' });
const tenant = (empresaId: string, usuarioId: string, papelAtual: string) => ({ empresaComprovada: empresaId, membershipId: 'm', usuarioId, papelAtual });
const ctx = { requestId: randomUUID(), ip: null, userAgent: 'teste-066' };
const HOJE = '2026-10-06';

test.before(async () => {
    client = await conectarDescartavel();
    const withTransaction = async <T>(w: (tx: Client) => Promise<T>) => w(client);
    pix = carregarModulo('lib/pagamentos/pix/recebimento.ts', { 'db/postgres': { db: () => client, withTransaction } }, new Map()) as Record<string, Fn>;
});

test.after(async () => {
    if (client)
        await encerrarDescartavel(client);
});

test('066: precheck, migration e postcheck; reaplicar e precheck depois recusam', async () => {
    await client.query(sql(PRE));
    assert.equal(await pix.pixInstalado(client as never), false as never);
    await client.query(sql(MIGRATION));
    await client.query(sql(POS));
    assert.equal(await pix.pixInstalado(client as never), true as never);
    await assert.rejects(client.query(sql(MIGRATION)), /066 já aplicada/);
    await client.query('ROLLBACK').catch(() => undefined);
    await assert.rejects(client.query(sql(PRE)), /já aplicada/);
});

test('banco recusa chave fora do formato do tipo, nome acima de 25 e empresa inexistente', async () => {
    const empresaC = await empresa('Buffet Pix C');
    const usuarioC = await usuario();
    const inserir = (tipo: string, chave: string, nome = 'Buffet', empresaId = empresaC) => client.query(
        'INSERT INTO empresa_pix_recebimento (empresa_id, tipo_chave, chave, nome_recebedor, cidade_recebedor, atualizado_por) VALUES ($1, $2, $3, $4, $5, $6)',
        [empresaId, tipo, chave, nome, 'Recife', usuarioC]);
    for (const [tipo, chave] of [['EMAIL', 'Maiuscula@Buffet.com'], ['CPF', '123'], ['TELEFONE', '11999998888'], ['ALEATORIA', 'x'], ['OUTRO', 'a@b.com']])
        assert.equal(await erroDe(inserir(tipo, chave)), '23514', tipo + ' ' + chave);
    assert.equal(await erroDe(inserir('EMAIL', 'a@b.com', 'N'.repeat(26))), '23514');
    assert.equal(await erroDe(inserir('EMAIL', 'a@b.com', 'Buffet', '00000000-0000-4000-8000-000000000000')), '23503');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM empresa_pix_recebimento')).rows[0].n, 0);
});

// Contrato ASSINADO só passa na verificação diferida da formalização se a transação não for confirmada (mesma técnica
// da suíte da baixa): fixtures, configuração e Pix da parcela rodam numa transação desfeita no último teste.
test('fixtures: duas empresas, Gestão e Equipe em A, Gestão em B, parcela em aberto em cada uma', async () => {
    await client.query('BEGIN');
    ids.a = await empresa('Buffet Pix A');
    ids.b = await empresa('Buffet Pix B');
    ids.gestaoA = await usuario();
    ids.equipeA = await usuario();
    ids.gestaoB = await usuario();
    ids.parcelaA = await parcelaEmAberto(ids.a);
    ids.parcelaB = await parcelaEmAberto(ids.b);
});

test('configuração: Equipe recusada; reautenticação vencida recusada; Gestão salva normalizada; versão protege; auditoria mascarada', async () => {
    const salvar = (s: unknown, t: unknown, corpo: Record<string, unknown>) => pix.alterarConfiguracaoPix(client as never, t as never, s as never, { acao: 'salvar', ...corpo } as never, ctx as never);
    const corpo = { tipoChave: 'EMAIL', chave: ' Financeiro@BuffetA.com.br ', nomeRecebedor: 'Buffet Alegria Comércio de Festas Ltda', cidadeRecebedor: 'São José dos Campos', versao: null };
    assert.equal(await erroDe(salvar(sessao(ids.equipeA), tenant(ids.a, ids.equipeA, 'ADMINISTRATIVO'), corpo)), 'PIX_SEM_PERMISSAO');
    assert.equal(await erroDe(salvar(sessao(ids.gestaoA, new Date(Date.now() - 10 * 60_000).toISOString()), tenant(ids.a, ids.gestaoA, 'REPRESENTANTE_AUTORIZADO'), corpo)), 'PERFIL_REAUTENTICACAO');
    assert.equal(await erroDe(salvar(sessao(ids.gestaoA), tenant(ids.a, ids.gestaoA, 'REPRESENTANTE_AUTORIZADO'), { ...corpo, tipoChave: 'CPF' })), 'PIX_CHAVE_INVALIDA');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM empresa_pix_recebimento')).rows[0].n, 0, 'nada gravado nas recusas');

    const r = await salvar(sessao(ids.gestaoA), tenant(ids.a, ids.gestaoA, 'REPRESENTANTE_AUTORIZADO'), corpo) as unknown as { configuracao: { versao: number; chaveMascarada: string } };
    assert.equal(r.configuracao.versao, 1);
    assert.doesNotMatch(r.configuracao.chaveMascarada, /financeiro@/);
    const linha = (await client.query('SELECT tipo_chave, chave, nome_recebedor, cidade_recebedor FROM empresa_pix_recebimento WHERE empresa_id = $1', [ids.a])).rows[0];
    assert.deepEqual(linha, { tipo_chave: 'EMAIL', chave: 'financeiro@buffeta.com.br', nome_recebedor: 'Buffet Alegria Comercio d', cidade_recebedor: 'Sao Jose dos Ca' });
    assert.equal(await erroDe(salvar(sessao(ids.gestaoA), tenant(ids.a, ids.gestaoA, 'REPRESENTANTE_AUTORIZADO'), corpo)), 'PIX_VERSAO', 'versão nula com chave existente');
    await salvar(sessao(ids.gestaoA), tenant(ids.a, ids.gestaoA, 'REPRESENTANTE_AUTORIZADO'), { ...corpo, tipoChave: 'TELEFONE', chave: '(81) 99999-0000', nomeRecebedor: 'Buffet A', cidadeRecebedor: 'Recife', versao: 1 });
    assert.equal(await erroDe(salvar(sessao(ids.gestaoA), tenant(ids.a, ids.gestaoA, 'REPRESENTANTE_AUTORIZADO'), { ...corpo, versao: 1 })), 'PIX_VERSAO', 'versão antiga');

    const audit = (await client.query<{ acao: string; texto: string }>(
        "SELECT acao, coalesce(dados_antes::text, '') || coalesce(dados_depois::text, '') AS texto FROM auditoria WHERE entidade_tipo = 'EMPRESA_PIX_RECEBIMENTO' AND entidade_id = $1 ORDER BY criado_em", [ids.a])).rows;
    assert.deepEqual(audit.map((a) => a.acao), ['PIX_RECEBIMENTO_CONFIGURADO', 'PIX_RECEBIMENTO_CONFIGURADO']);
    assert.ok(audit.every((a) => !a.texto.includes('financeiro@buffeta') && !a.texto.includes('5581999990000')), 'chave sempre mascarada na auditoria');
});

test('Pix da parcela: valor do saldo e chave da própria empresa; parcela de outra empresa = 404; empresa sem chave = 409', async () => {
    const r = await pix.pixDaParcela(client as never, tenant(ids.a, ids.equipeA, 'ADMINISTRATIVO') as never, ids.parcelaA as never, HOJE as never) as unknown as { copiaECola: string; valorCentavos: number; qrSvg: string; txid: string };
    assert.equal(r.valorCentavos, 125000);
    assert.match(r.copiaECola, /^000201/);
    assert.match(r.copiaECola, /0114\+5581999990000/);
    assert.match(r.copiaECola, /54071250\.00/);
    assert.match(r.copiaECola, new RegExp(`05${String(r.txid.length).padStart(2, '0')}${r.txid}`));
    assert.match(r.qrSvg, /^<svg/);
    assert.equal(await erroDe(pix.pixDaParcela(client as never, tenant(ids.b, ids.gestaoB, 'REPRESENTANTE_AUTORIZADO') as never, ids.parcelaA as never, HOJE as never)), 'PIX_NAO_CONFIGURADO', 'B sem chave');
    await client.query("INSERT INTO empresa_pix_recebimento (empresa_id, tipo_chave, chave, nome_recebedor, cidade_recebedor, atualizado_por) VALUES ($1, 'EMAIL', 'b@buffetb.com', 'Buffet B', 'Olinda', $2)", [ids.b, ids.gestaoB]);
    assert.equal(await erroDe(pix.pixDaParcela(client as never, tenant(ids.b, ids.gestaoB, 'REPRESENTANTE_AUTORIZADO') as never, ids.parcelaA as never, HOJE as never)), 'PARCELA_NAO_ENCONTRADA', 'B não alcança a parcela de A');
    const deB = await pix.pixDaParcela(client as never, tenant(ids.b, ids.gestaoB, 'REPRESENTANTE_AUTORIZADO') as never, ids.parcelaB as never, HOJE as never) as unknown as { copiaECola: string };
    assert.match(deB.copiaECola, /b@buffetb\.com/);
    assert.doesNotMatch(deB.copiaECola, /5581999990000/);
    await client.query("UPDATE pagamento_parcelas SET status = 'CANCELADA' WHERE id = $1", [ids.parcelaB]);
    assert.equal(await erroDe(pix.pixDaParcela(client as never, tenant(ids.b, ids.gestaoB, 'REPRESENTANTE_AUTORIZADO') as never, ids.parcelaB as never, HOJE as never)), 'PARCELA_SEM_SALDO');
});

test('remoção pela Gestão com versão; rollback da 066 recusa com chave cadastrada e passa sem; sem a 066 o Pix responde indisponível', async () => {
    const versaoA = (await client.query('SELECT versao FROM empresa_pix_recebimento WHERE empresa_id = $1', [ids.a])).rows[0].versao as number;
    assert.equal(await erroDe(pix.alterarConfiguracaoPix(client as never, tenant(ids.a, ids.gestaoA, 'REPRESENTANTE_AUTORIZADO') as never, sessao(ids.gestaoA) as never, { acao: 'remover', versao: versaoA + 5, confirmar: true } as never, ctx as never)), 'PIX_VERSAO');
    await pix.alterarConfiguracaoPix(client as never, tenant(ids.a, ids.gestaoA, 'REPRESENTANTE_AUTORIZADO') as never, sessao(ids.gestaoA) as never, { acao: 'remover', versao: versaoA, confirmar: true } as never, ctx as never);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM auditoria WHERE acao = 'PIX_RECEBIMENTO_REMOVIDO' AND entidade_id = $1", [ids.a])).rows[0].n, 1);
    await client.query('ROLLBACK');
    const empresaD = await empresa('Buffet Pix D');
    const usuarioD = await usuario();
    await client.query("INSERT INTO empresa_pix_recebimento (empresa_id, tipo_chave, chave, nome_recebedor, cidade_recebedor, atualizado_por) VALUES ($1, 'EMAIL', 'd@buffetd.com', 'Buffet D', 'Natal', $2)", [empresaD, usuarioD]);
    await assert.rejects(client.query(sql(ROLLBACK)), /rollback recusado/);
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query('DELETE FROM empresa_pix_recebimento WHERE empresa_id = $1', [empresaD]);
    await client.query(sql(ROLLBACK));
    assert.equal(await erroDe(pix.pixDaParcela(client as never, tenant(ids.a, ids.equipeA, 'ADMINISTRATIVO') as never, ids.parcelaA as never, HOJE as never)), 'PIX_INDISPONIVEL');
    await client.query(sql(MIGRATION));
    await client.query(sql(POS));
});
