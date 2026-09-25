// Caminho do `node scripts/admin-provision.cjs` no Node 22.23.2.
// Não importa TypeScript: strip-types não aceita parameter properties
// nem imports transitivos sem extensão.
const MENSAGEM = 'Esta conta é a última que administra as concessões do perfil. Transfira essa capacidade antes de desativar, revogar ou retirar a Gestão.';

function chave(empresaId) {
    return `kidmais:perfil-empresa:${empresaId}`;
}

async function estruturaInstalada(tx) {
    const row = (await tx.query(
        `SELECT to_regclass('public.perfil_empresas') AS empresas,
                to_regclass('public.perfil_empresa_concessoes') AS concessoes`,
    )).rows[0];
    if (!row)
        throw Error('Consulta do perfil não retornou linha.');
    return row.empresas != null && row.concessoes != null;
}

async function travarEmpresas(tx, empresaIds) {
    for (const empresaId of [...empresaIds].sort())
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [chave(empresaId)]);
}

function empresasOndeEhUltima(linhas, usuarioId) {
    const porEmpresa = new Map();
    for (const linha of linhas) {
        const lista = porEmpresa.get(linha.empresa_id) ?? [];
        lista.push(linha);
        porEmpresa.set(linha.empresa_id, lista);
    }
    const bloqueadas = [];
    for (const [empresaId, lista] of porEmpresa) {
        const elegiveis = lista.filter((linha) => linha.ativo && linha.papel === 'REPRESENTANTE_AUTORIZADO');
        if (elegiveis.length === 1 && elegiveis[0].usuario_id === usuarioId)
            bloqueadas.push(empresaId);
    }
    return bloqueadas.sort();
}

async function registrarAuditoriaCli(tx, input) {
    await tx.query(
        `INSERT INTO auditoria (
           cliente_id, ator_tipo, usuario_id, acao, entidade_tipo, entidade_id,
           dados_antes, dados_depois, justificativa, origem, request_id, ip, user_agent
         ) VALUES (NULL,$1,$2,$3,$4,$5,NULL,$6::jsonb,$7,$8,$9,NULL,NULL)`,
        [
            'USUARIO',
            input.usuarioId,
            input.acao,
            input.entidadeTipo,
            input.entidadeId,
            input.dadosDepois == null ? null : JSON.stringify(input.dadosDepois),
            input.justificativa ?? null,
            input.origem,
            input.requestId,
        ],
    );
}

async function revogarConcessoesAtivasDoUsuario(tx, input) {
    const motivo = String(input.motivo ?? '').trim();
    if (motivo.length < 3)
        throw Error('Informe o motivo da revogação.');
    if (!input.operadorId)
        throw Error('A revogação do perfil precisa de um operador identificado.');
    return (await tx.query(
        `UPDATE public.perfil_empresa_concessoes
         SET revogado_por=$2, revogado_em=clock_timestamp(), motivo_revogacao=$3
         WHERE usuario_id=$1 AND revogado_em IS NULL
           AND ($4::uuid IS NULL OR empresa_id=$4)
           AND ($5::text IS NULL OR capacidade=$5)
         RETURNING id, empresa_id, capacidade`,
        [input.usuarioId, input.operadorId, motivo, input.empresaId ?? null, input.capacidade ?? null],
    )).rows;
}

async function aplicarProtecaoPerfilNaAtualizacao(tx, input) {
    const instalada = await estruturaInstalada(tx);
    const empresas = instalada
        ? (await tx.query('SELECT id FROM public.perfil_empresas ORDER BY id')).rows.map((linha) => linha.id)
        : [];
    if (instalada)
        await travarEmpresas(tx, empresas);
    const usuario = (await tx.query(
        'SELECT id,email,nome,papel,ativo FROM usuarios_administrativos WHERE email=$1 FOR UPDATE',
        [String(input.email).trim().toLowerCase()],
    )).rows[0];
    if (!usuario)
        throw Error('Usuário não encontrado.');
    let operadorId = null;
    if (input.operadorEmail) {
        const operador = (await tx.query(
            'SELECT id,papel,ativo FROM usuarios_administrativos WHERE email=$1 FOR UPDATE',
            [String(input.operadorEmail).trim().toLowerCase()],
        )).rows[0];
        if (!operador)
            throw Error('Operador não encontrado.');
        operadorId = operador.id;
    }
    const desativa = usuario.ativo && input.ativoDepois === false;
    const retiraGestao = usuario.papel === 'REPRESENTANTE_AUTORIZADO' && input.papelDepois !== 'REPRESENTANTE_AUTORIZADO';
    const retiradaGestaoSemEncerrarSessao = Boolean(usuario.ativo && input.ativoDepois && retiraGestao);
    if (!instalada || (!desativa && !retiraGestao)) {
        return {
            recusado: false, mensagem: null, empresasBloqueadas: [], revogar: false,
            retiradaGestaoSemEncerrarSessao, usuario, operadorId,
        };
    }
    const linhas = empresas.length === 0 ? [] : (await tx.query(
        `SELECT c.empresa_id, c.usuario_id, u.papel, u.ativo
         FROM public.perfil_empresa_concessoes c
         JOIN usuarios_administrativos u ON u.id = c.usuario_id
         WHERE c.revogado_em IS NULL
           AND c.capacidade = 'PERFIL_ADMINISTRAR_CONCESSOES'
           AND c.empresa_id = ANY($1::uuid[])
         ORDER BY c.empresa_id, c.id
         FOR UPDATE OF c`,
        [empresas],
    )).rows;
    const bloqueadas = empresasOndeEhUltima(linhas, usuario.id);
    const aplica = desativa ? usuario.ativo : usuario.ativo && usuario.papel === 'REPRESENTANTE_AUTORIZADO';
    if (aplica && bloqueadas.length > 0) {
        if (!operadorId)
            throw Error('A recusa precisa de um operador identificado.');
        return {
            recusado: true, mensagem: MENSAGEM, empresasBloqueadas: bloqueadas, revogar: false,
            retiradaGestaoSemEncerrarSessao: false, usuario, operadorId,
        };
    }
    const ativas = (await tx.query(
        'SELECT id FROM public.perfil_empresa_concessoes WHERE usuario_id=$1 AND revogado_em IS NULL LIMIT 1',
        [usuario.id],
    )).rows;
    if (ativas.length > 0 && !operadorId)
        throw Error('A atualização revoga concessões do perfil e precisa de um operador identificado.');
    return {
        recusado: false, mensagem: null, empresasBloqueadas: [], revogar: ativas.length > 0,
        retiradaGestaoSemEncerrarSessao, usuario, operadorId,
    };
}

module.exports = {
    aplicarProtecaoPerfilNaAtualizacao,
    revogarConcessoesAtivasDoUsuario,
    registrarAuditoriaCli,
};
