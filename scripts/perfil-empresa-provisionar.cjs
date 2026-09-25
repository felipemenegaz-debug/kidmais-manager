/* eslint-disable @typescript-eslint/no-require-imports */
// Procedimento posterior às migrations 026, 027 e 028 e aos serviços de autorização.
// Não contém empresa, CNPJ, e-mail nem concessão reais. Não executa ao ser importado.
const { randomBytes } = require('node:crypto');
const readline = require('node:readline/promises');

const CAPACIDADES = [
    'PERFIL_CONSULTAR',
    'PERFIL_EDITAR_RASCUNHO',
    'PERFIL_APLICAR',
    'PERFIL_ADMINISTRAR_CONCESSOES',
];

function autorizado(argv = process.argv, env = process.env) {
    return argv.includes('--autorizado-por-felipe') && env.KIDMAIS_PERFIL_PROVISIONAR === 'CONFIRMAR';
}

function recusarBancoReal(connection) {
    let caminho = '';
    try {
        caminho = new URL(connection).pathname;
    } catch {
        caminho = String(connection);
    }
    if (/kidmais_manager/i.test(caminho))
        throw Error('Recusado: não usar o banco kidmais_manager.');
}

function validarDestino(connection, declarado) {
    recusarBancoReal(connection);
    let url;
    try {
        url = new URL(connection);
    } catch {
        throw Error('Conexão inválida.');
    }
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
        throw Error('Protocolo PostgreSQL obrigatório.');
    const banco = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!declarado || declarado.host !== url.hostname || declarado.banco !== banco)
        throw Error('O host e o banco declarados não conferem com a conexão. O nome do banco não prova o ambiente.');
    if (declarado.ambiente !== 'staging' && declarado.ambiente !== 'producao')
        throw Error('Informe o ambiente explicitamente: staging ou producao.');
    if (declarado.ambiente === 'producao' && declarado.confirmacaoProducao !== 'AUTORIZAR-PRODUCAO')
        throw Error('Produção exige confirmação explícita separada.');
    return { host: url.hostname, banco, ambiente: declarado.ambiente };
}

function mascaraConta(email) {
    const [local, dominio] = String(email).trim().toLowerCase().split('@');
    if (!local || !dominio)
        throw Error('Conta inválida.');
    return `${local.slice(0, 1)}***@${dominio.slice(0, 1)}***`;
}

function confirmarSinal(esperado, digitado) {
    if (digitado !== esperado)
        throw Error('O sinal da conta não confere.');
}

/** @param {{ isTTY?: boolean }} [entrada] */
function exigirTerminalInterativo(entrada = process.stdin) {
    if (!entrada.isTTY)
        throw Error('Use um terminal local interativo.');
}

function lerOculto(entrada, saida, prompt) {
    saida.write(prompt);
    if (typeof entrada.setRawMode === 'function')
        entrada.setRawMode(true);
    entrada.resume();
    return new Promise((resolve, reject) => {
        let value = '';
        const cleanup = () => {
            entrada.off('data', receive);
            if (typeof entrada.setRawMode === 'function')
                entrada.setRawMode(false);
            entrada.pause();
            saida.write('\n');
        };
        const receive = (chunk) => {
            for (const char of chunk.toString('utf8')) {
                if (char === '\u0003') {
                    cleanup();
                    reject(Error('Operação cancelada.'));
                    return;
                }
                if (char === '\r' || char === '\n') {
                    cleanup();
                    resolve(value);
                    return;
                }
                if (char === '\u007f' || char === '\b')
                    value = [...value].slice(0, -1).join('');
                else if (char >= ' ')
                    value += char;
            }
        };
        entrada.on('data', receive);
    });
}

async function registrarConcessaoInicial(client, input) {
    await client.query(
        `INSERT INTO auditoria (
           cliente_id, ator_tipo, usuario_id, acao, entidade_tipo, entidade_id,
           dados_antes, dados_depois, justificativa, origem, request_id, ip, user_agent
         ) VALUES (NULL,'USUARIO',$1,'PERFIL_CONCESSAO_INICIAL','PERFIL_EMPRESA',$2,NULL,$3::jsonb,$4,'PERFIL_PROVISIONAMENTO',$5,NULL,NULL)`,
        [
            input.operadorId,
            input.empresaId,
            JSON.stringify({
                empresaId: input.empresaId,
                unidadeId: input.unidadeId,
                contaId: input.contaId,
                capacidades: CAPACIDADES,
                referencia: input.referencia,
                ambiente: input.ambiente,
            }),
            input.motivo,
            input.requestId,
        ],
    );
}

async function lerGestaoTravada(client, usuarioId) {
    return (await client.query(
        'SELECT id,papel,ativo FROM usuarios_administrativos WHERE id=$1 FOR UPDATE',
        [usuarioId],
    )).rows[0] ?? null;
}

function gestaoAtiva(conta) {
    return Boolean(conta && conta.ativo && conta.papel === 'REPRESENTANTE_AUTORIZADO');
}

async function provisionar(client, input) {
    if (!input.operadorId || !input.contaId || String(input.referencia).trim().length < 3 || String(input.motivo).trim().length < 3)
        throw Error('Operador, conta confirmada, motivo e referência da autorização são obrigatórios.');
    if (input.ambiente !== 'staging' && input.ambiente !== 'producao')
        throw Error('Informe o ambiente explicitamente: staging ou producao.');
    const { randomUUID } = require('node:crypto');
    await client.query('BEGIN');
    try {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['kidmais:perfil-empresa:provisionamento-inicial']);
        const empresas = (await client.query('SELECT id FROM public.perfil_empresas ORDER BY id')).rows;
        if (empresas.length > 1)
            throw Error('Há mais de uma empresa. Nenhuma concessão foi criada.');
        let empresaId;
        let unidadeId;
        let codigoEmpresa = null;
        let codigoUnidade = null;
        if (empresas.length === 0) {
            codigoEmpresa = `EMP-${randomBytes(4).toString('hex')}`;
            codigoUnidade = `UNI-${randomBytes(4).toString('hex')}`;
            empresaId = (await client.query(
                'INSERT INTO public.perfil_empresas (codigo) VALUES ($1) RETURNING id',
                [codigoEmpresa],
            )).rows[0].id;
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`kidmais:perfil-empresa:${empresaId}`]);
            unidadeId = (await client.query(
                'INSERT INTO public.perfil_unidades (empresa_id, codigo) VALUES ($1,$2) RETURNING id',
                [empresaId, codigoUnidade],
            )).rows[0].id;
        } else {
            empresaId = empresas[0].id;
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`kidmais:perfil-empresa:${empresaId}`]);
            const confirmadas = (await client.query('SELECT id FROM public.perfil_empresas WHERE id=$1 FOR UPDATE', [empresaId])).rows;
            if (confirmadas.length !== 1)
                throw Error('A empresa mudou durante o provisionamento. Nenhuma concessão foi criada.');
            const unidades = (await client.query(
                'SELECT id FROM public.perfil_unidades WHERE empresa_id=$1 ORDER BY id FOR UPDATE',
                [empresaId],
            )).rows;
            if (unidades.length !== 1)
                throw Error('A empresa existente não tem exatamente uma unidade. Nenhuma concessão foi criada.');
            unidadeId = unidades[0].id;
        }
        const operador = await lerGestaoTravada(client, input.operadorId);
        const conta = await lerGestaoTravada(client, input.contaId);
        if (!gestaoAtiva(operador) || !gestaoAtiva(conta))
            throw Error('Operador ou conta confirmada não estão como Gestão ativa. Nenhuma concessão foi criada.');
        const administradores = (await client.query(
            `SELECT c.usuario_id, u.papel, u.ativo
             FROM public.perfil_empresa_concessoes c
             JOIN usuarios_administrativos u ON u.id = c.usuario_id
             WHERE c.empresa_id=$1 AND c.revogado_em IS NULL AND c.capacidade='PERFIL_ADMINISTRAR_CONCESSOES'
             FOR UPDATE OF c`,
            [empresaId],
        )).rows;
        if (administradores.some((linha) => linha.ativo && linha.papel === 'REPRESENTANTE_AUTORIZADO'))
            throw Error('Já existe um administrador elegível nesta empresa. O provisionamento não cria outra concessão.');
        const contaRelida = await lerGestaoTravada(client, input.contaId);
        const operadorRelido = await lerGestaoTravada(client, input.operadorId);
        if (!gestaoAtiva(contaRelida) || !gestaoAtiva(operadorRelido))
            throw Error('A conta deixou de ser Gestão ativa durante a operação. Nenhuma concessão foi criada.');
        const existentes = (await client.query(
            `SELECT capacidade FROM public.perfil_empresa_concessoes
             WHERE empresa_id=$1 AND usuario_id=$2 AND revogado_em IS NULL
               AND capacidade = ANY($3::text[])
             FOR UPDATE`,
            [empresaId, input.contaId, CAPACIDADES],
        )).rows;
        if (existentes.length > 0)
            throw Error('Já existe concessão ativa para esta conta. Ela não será duplicada nem substituída.');
        for (const capacidade of CAPACIDADES) {
            await client.query(
                `INSERT INTO public.perfil_empresa_concessoes
                 (empresa_id, usuario_id, capacidade, concedido_por, motivo, referencia_autorizacao)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [empresaId, input.contaId, capacidade, input.operadorId, input.motivo.trim(), input.referencia.trim()],
            );
        }
        await registrarConcessaoInicial(client, {
            operadorId: input.operadorId,
            empresaId,
            unidadeId,
            contaId: input.contaId,
            motivo: input.motivo.trim(),
            referencia: input.referencia.trim(),
            ambiente: input.ambiente,
            requestId: randomUUID(),
        });
        await client.query('COMMIT');
        return { empresaId, unidadeId, codigoEmpresa, codigoUnidade };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}

async function coletarEntradaProvisionamento(entrada, saida) {
    const connection = await lerOculto(entrada, saida, 'Conexão PostgreSQL de provisionamento (oculta): ');
    const rl = readline.createInterface({ input: entrada, output: saida, terminal: Boolean(saida.isTTY) });
    try {
        const host = (await rl.question('Host declarado: ')).trim();
        const banco = (await rl.question('Nome do banco declarado: ')).trim();
        const ambiente = (await rl.question('Ambiente explícito (staging ou producao): ')).trim();
        const confirmacaoProducao = ambiente === 'producao' ? (await rl.question('Confirmação de produção: ')).trim() : '';
        const operadorEmail = (await rl.question('Email do operador identificado: ')).trim().toLowerCase();
        const contaEmail = (await rl.question('Email da conta confirmada em canal privado: ')).trim().toLowerCase();
        const motivo = (await rl.question('Motivo da concessão inicial: ')).trim();
        const referencia = (await rl.question('Referência da autorização: ')).trim();
        const sinalOperador = mascaraConta(operadorEmail);
        const sinalConta = mascaraConta(contaEmail);
        saida.write(`Sinal do operador: ${sinalOperador}\n`);
        saida.write(`Sinal da conta: ${sinalConta}\n`);
        confirmarSinal(sinalOperador, (await rl.question('Repita o sinal do operador: ')).trim());
        confirmarSinal(sinalConta, (await rl.question('Repita o sinal da conta: ')).trim());
        const confirmacao = (await rl.question('Digite CONFIRMAR para concluir o provisionamento desta conta: ')).trim();
        return {
            connection, host, banco, ambiente, confirmacaoProducao,
            operadorEmail, contaEmail, motivo, referencia, confirmacao,
        };
    } finally {
        rl.close();
    }
}

async function main() {
    if (!autorizado()) {
        console.error('Procedimento não executado. Falta autorização explícita de Felipe para este ambiente. Nenhuma conexão foi aberta.');
        process.exitCode = 1;
        return;
    }
    exigirTerminalInterativo();
    const { Client } = require('pg');
    const entrada = await coletarEntradaProvisionamento(process.stdin, process.stdout);
    validarDestino(entrada.connection, {
        host: entrada.host,
        banco: entrada.banco,
        ambiente: entrada.ambiente,
        confirmacaoProducao: entrada.confirmacaoProducao,
    });
    if (entrada.confirmacao !== 'CONFIRMAR')
        throw Error('Operação cancelada.');
    const { operadorEmail, contaEmail, motivo, referencia, ambiente, connection } = entrada;
    const client = new Client({ connectionString: connection });
    await client.connect();
    try {
        const operador = (await client.query('SELECT id FROM usuarios_administrativos WHERE email=$1', [operadorEmail])).rows[0];
        const conta = (await client.query('SELECT id FROM usuarios_administrativos WHERE email=$1', [contaEmail])).rows[0];
        if (!operador || !conta)
            throw Error('Operador ou conta não encontrados. Nenhuma concessão foi criada.');
        const resultado = await provisionar(client, {
            operadorId: operador.id, contaId: conta.id, motivo, referencia, ambiente,
        });
        console.log(JSON.stringify({ empresaId: resultado.empresaId, unidadeId: resultado.unidadeId }));
    } finally {
        await client.end();
    }
}

module.exports = {
    autorizado, provisionar, recusarBancoReal, validarDestino, mascaraConta, confirmarSinal,
    exigirTerminalInterativo, lerOculto, coletarEntradaProvisionamento, CAPACIDADES,
};
if (require.main === module)
    main().catch(() => { console.error('Provisionamento do perfil não concluído. Nenhuma credencial foi registrada.'); process.exitCode = 1; });
