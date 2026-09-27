import type { DbExecutor } from '../db/contracts';
import { ClienteServiceError } from '../clientes/services/errors.ts';
import type { AppendAuditoriaInput } from '../clientes/repositories/auditoria.repository.ts';
import { consultarCapacidadesPerfil, exigirCapacidadePerfil } from './autorizacao.ts';
import { alteracaoSensivel, cadastroVazio, validarAplicacao, validarRascunho, type CadastroPerfil } from './cadastro.ts';
import { travarEmpresasPerfil } from './protecao-usuarios.ts';
import { exigirReautenticacaoPerfil } from './reautenticacao.ts';

type Auditoria = (input: AppendAuditoriaInput, tx?: DbExecutor) => Promise<unknown>;

export type IdentidadeRascunho = {
    numero: number;
    edicao: number;
    versaoBase: number;
    conteudo: CadastroPerfil;
};

export type HistoricoPerfil = {
    numero: number;
    estado: string;
    motivo: string | null;
    versaoBase: number;
    editorNome: string;
    editadoEm: string;
    aplicadorNome: string | null;
    aplicadoEm: string | null;
};

export type ContextoCadastro = {
    empresaId: string | null;
    unidadeId: string | null;
    codigoEmpresa: string | null;
    codigoUnidade: string | null;
    versao: number;
    cadastro: CadastroPerfil;
    rascunho: IdentidadeRascunho | null;
};

async function estruturaCadastroInstalada(tx: DbExecutor) {
    const result = await tx.query<{ empresas: string | null; unidades: string | null; revisoes: string | null; colunas_revisao: number }>(
        `SELECT to_regclass('public.perfil_empresas') AS empresas,
                to_regclass('public.perfil_unidades') AS unidades,
                to_regclass('public.perfil_empresa_revisoes') AS revisoes,
                (SELECT count(*)::int FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'perfil_empresa_revisoes'
                    AND column_name IN ('aplicado_por', 'atualizado_em')) AS colunas_revisao`,
    );
    const row = result.rows[0];
    if (!row)
        throw new Error('Consulta do cadastro do perfil não retornou linha.');
    return row.empresas != null && row.unidades != null && row.revisoes != null && Number(row.colunas_revisao) === 2;
}

type EmpresaRow = {
    id: string;
    codigo: string;
    versao: number;
    nome_comercial: string | null;
    razao_social: string | null;
    cnpj: string | null;
    sede_cep: string | null;
    sede_logradouro: string | null;
    sede_numero: string | null;
    sede_sem_numero: boolean;
    sede_complemento: string | null;
    sede_bairro: string | null;
    sede_cidade: string | null;
    sede_uf: string | null;
    sede_pais: string | null;
};

type UnidadeRow = {
    id: string;
    codigo: string;
    nome: string | null;
    mesmo_endereco_sede: boolean;
    cep: string | null;
    logradouro: string | null;
    numero: string | null;
    sem_numero: boolean;
    complemento: string | null;
    bairro: string | null;
    cidade: string | null;
    uf: string | null;
    pais: string | null;
    referencia_chegada: string | null;
    telefone: string | null;
    whatsapp: string | null;
    email_comercial: string | null;
    site: string | null;
    instagram: string | null;
};

function enderecoDe(prefixo: 'sede' | 'unidade', row: EmpresaRow | UnidadeRow): CadastroPerfil['sede'] {
    const fonte = prefixo === 'sede'
        ? {
            cep: (row as EmpresaRow).sede_cep,
            logradouro: (row as EmpresaRow).sede_logradouro,
            numero: (row as EmpresaRow).sede_numero,
            semNumero: (row as EmpresaRow).sede_sem_numero,
            complemento: (row as EmpresaRow).sede_complemento,
            bairro: (row as EmpresaRow).sede_bairro,
            cidade: (row as EmpresaRow).sede_cidade,
            uf: (row as EmpresaRow).sede_uf,
            pais: (row as EmpresaRow).sede_pais,
        }
        : {
            cep: (row as UnidadeRow).cep,
            logradouro: (row as UnidadeRow).logradouro,
            numero: (row as UnidadeRow).numero,
            semNumero: (row as UnidadeRow).sem_numero,
            complemento: (row as UnidadeRow).complemento,
            bairro: (row as UnidadeRow).bairro,
            cidade: (row as UnidadeRow).cidade,
            uf: (row as UnidadeRow).uf,
            pais: (row as UnidadeRow).pais,
        };
    return {
        cep: fonte.cep ?? '',
        logradouro: fonte.logradouro ?? '',
        numero: fonte.numero ?? '',
        semNumero: fonte.semNumero,
        complemento: fonte.complemento ?? '',
        bairro: fonte.bairro ?? '',
        cidade: fonte.cidade ?? '',
        uf: fonte.uf ?? '',
        pais: fonte.pais ?? 'BR',
    };
}

function cadastroDe(empresa: EmpresaRow, unidade: UnidadeRow): CadastroPerfil {
    return {
        ...cadastroVazio(),
        nomeComercial: empresa.nome_comercial ?? '',
        razaoSocial: empresa.razao_social ?? '',
        cnpj: empresa.cnpj ?? '',
        sede: enderecoDe('sede', empresa),
        unidadeNome: unidade.nome ?? '',
        mesmoEnderecoSede: unidade.mesmo_endereco_sede,
        unidade: enderecoDe('unidade', unidade),
        referenciaChegada: unidade.referencia_chegada ?? '',
        telefone: unidade.telefone ?? '',
        whatsapp: unidade.whatsapp ?? '',
        emailComercial: unidade.email_comercial ?? '',
        site: unidade.site ?? '',
        instagram: unidade.instagram ?? '',
    };
}

const COLUNAS_EMPRESA = `id, codigo, versao, nome_comercial, razao_social, cnpj,
                sede_cep, sede_logradouro, sede_numero, sede_sem_numero, sede_complemento,
                sede_bairro, sede_cidade, sede_uf, sede_pais`;

async function contextoUnico(tx: DbExecutor, empresaIdCliente: string | null, travar: boolean) {
    if (travar) {
        const ids = (await tx.query<{ id: string }>('SELECT id FROM public.perfil_empresas ORDER BY id')).rows.map((linha) => linha.id);
        await travarEmpresasPerfil(tx, ids);
    }
    const empresas = (await tx.query<EmpresaRow>(
        `SELECT ${COLUNAS_EMPRESA}
         FROM public.perfil_empresas ORDER BY id${travar ? ' FOR UPDATE' : ''}`,
    )).rows;
    if (empresas.length > 1)
        throw new ClienteServiceError('PERFIL_LIMITE_V1', 'A V1 opera com uma empresa. Há mais de uma empresa cadastrada.', 409);
    if (empresas.length === 0)
        return null;
    const empresa = empresas[0]!;
    if (empresaIdCliente && empresaIdCliente !== empresa.id)
        throw new ClienteServiceError('PERFIL_SEM_CONCESSAO', 'O contexto da empresa não pode ser escolhido pelo cliente.', 403);
    const unidades = (await tx.query<UnidadeRow>(
        `SELECT id, codigo, nome, mesmo_endereco_sede, cep, logradouro, numero, sem_numero, complemento,
                bairro, cidade, uf, pais, referencia_chegada, telefone, whatsapp, email_comercial, site, instagram
         FROM public.perfil_unidades WHERE empresa_id=$1 ORDER BY id${travar ? ' FOR UPDATE' : ''}`,
        [empresa.id],
    )).rows;
    if (unidades.length !== 1)
        throw new ClienteServiceError('PERFIL_LIMITE_V1', 'A V1 opera com uma unidade desta empresa.', 409);
    return { empresa, unidade: unidades[0]! };
}

function conflito(versao: number, edicao: number | null, numero: number | null) {
    throw new ClienteServiceError('PERFIL_CONFLITO', 'Outra edição alterou o perfil. Os dados digitados foram mantidos.', 409, { versao, edicao, numero });
}

export async function consultarCadastroPerfil(tx: DbExecutor, usuarioId: string, empresaIdCliente: string | null = null) {
    const instalada = await estruturaCadastroInstalada(tx);
    if (!instalada)
        return { estruturaInstalada: false as const, vazio: true, contexto: null as ContextoCadastro | null };
    const unico = await contextoUnico(tx, empresaIdCliente, false);
    if (!unico)
        return { estruturaInstalada: true as const, vazio: true, contexto: null as ContextoCadastro | null };
    await exigirCapacidadePerfil(tx, unico.empresa.id, usuarioId, 'PERFIL_CONSULTAR');
    const rascunho = (await tx.query<{ numero: number; edicao: number; versao_base: number; conteudo: CadastroPerfil }>(
        `SELECT numero, edicao, versao_base, conteudo
         FROM public.perfil_empresa_revisoes
         WHERE empresa_id=$1 AND estado='RASCUNHO'`,
        [unico.empresa.id],
    )).rows[0] ?? null;
    return {
        estruturaInstalada: true as const,
        vazio: false,
        contexto: {
            empresaId: unico.empresa.id,
            unidadeId: unico.unidade.id,
            codigoEmpresa: unico.empresa.codigo,
            codigoUnidade: unico.unidade.codigo,
            versao: unico.empresa.versao,
            cadastro: cadastroDe(unico.empresa, unico.unidade),
            rascunho: rascunho
                ? { numero: rascunho.numero, edicao: rascunho.edicao, versaoBase: rascunho.versao_base, conteudo: rascunho.conteudo }
                : null,
        },
    };
}

export async function salvarRascunhoPerfil(tx: DbExecutor, input: {
    usuarioId: string;
    empresaIdCliente: string | null;
    numero: number | null;
    edicao: number | null;
    versaoBase: number;
    cadastro: Partial<CadastroPerfil>;
    requestId: string;
}, auditoria: Auditoria) {
    const instalada = await estruturaCadastroInstalada(tx);
    if (!instalada)
        throw new ClienteServiceError('PERFIL_ESTRUTURA_AUSENTE', 'A estrutura do cadastro ainda não está instalada.', 409);
    const validacao = validarRascunho(input.cadastro);
    if (validacao.falhas.length)
        throw new ClienteServiceError('PERFIL_CADASTRO_INVALIDO', validacao.falhas[0]!.mensagem, 400, { falhas: validacao.falhas });
    const unico = await contextoUnico(tx, input.empresaIdCliente, true);
    if (!unico)
        throw new ClienteServiceError('PERFIL_ESTRUTURA_AUSENTE', 'Ainda não há empresa provisionada.', 409);
    await exigirCapacidadePerfil(tx, unico.empresa.id, input.usuarioId, 'PERFIL_EDITAR_RASCUNHO');
    if (Number(unico.empresa.versao) !== input.versaoBase)
        conflito(unico.empresa.versao, null, null);
    const atual = (await tx.query<{ numero: number; edicao: number; versao_base: number }>(
        `SELECT numero, edicao, versao_base FROM public.perfil_empresa_revisoes
         WHERE empresa_id=$1 AND estado='RASCUNHO' FOR UPDATE`,
        [unico.empresa.id],
    )).rows[0] ?? null;
    if (input.numero == null || input.edicao == null) {
        if (atual)
            conflito(unico.empresa.versao, atual.edicao, atual.numero);
        const sequencia = (await tx.query<{ max_edicao: number; max_numero: number }>(
            `SELECT COALESCE(max(edicao),0)::int AS max_edicao, COALESCE(max(numero),0)::int AS max_numero
             FROM public.perfil_empresa_revisoes WHERE empresa_id=$1`,
            [unico.empresa.id],
        )).rows[0];
        const edicao = Number(sequencia?.max_edicao ?? 0) + 1;
        const numero = Number(sequencia?.max_numero ?? 0) + 1;
        await tx.query(
            `INSERT INTO public.perfil_empresa_revisoes
             (empresa_id, unidade_id, numero, estado, versao_base, edicao, conteudo, autor_id, atualizado_em)
             VALUES ($1,$2,$3,'RASCUNHO',$4,$5,$6::jsonb,$7,clock_timestamp())`,
            [unico.empresa.id, unico.unidade.id, numero, unico.empresa.versao, edicao, JSON.stringify(validacao.cadastro), input.usuarioId],
        );
        await auditoria({
            atorTipo: 'USUARIO', usuarioId: input.usuarioId, acao: 'PERFIL_RASCUNHO_SALVO',
            entidadeTipo: 'PERFIL_EMPRESA', entidadeId: unico.empresa.id,
            dadosDepois: { numero, edicao, versaoBase: unico.empresa.versao }, origem: 'PERFIL_EMPRESA', requestId: input.requestId,
        }, tx);
        return { numero, edicao, versaoBase: unico.empresa.versao };
    }
    if (!atual || atual.numero !== input.numero || atual.edicao !== input.edicao || Number(atual.versao_base) !== input.versaoBase)
        conflito(unico.empresa.versao, atual?.edicao ?? null, atual?.numero ?? null);
    const gravado = await tx.query(
        `UPDATE public.perfil_empresa_revisoes
         SET conteudo=$5::jsonb, edicao=edicao+1, autor_id=$6, atualizado_em=clock_timestamp()
         WHERE empresa_id=$1 AND estado='RASCUNHO' AND numero=$2 AND edicao=$3 AND versao_base=$4`,
        [unico.empresa.id, input.numero, input.edicao, input.versaoBase, JSON.stringify(validacao.cadastro), input.usuarioId],
    );
    if (gravado.rowCount !== 1)
        conflito(unico.empresa.versao, atual.edicao, atual.numero);
    await auditoria({
        atorTipo: 'USUARIO', usuarioId: input.usuarioId, acao: 'PERFIL_RASCUNHO_SALVO',
        entidadeTipo: 'PERFIL_EMPRESA', entidadeId: unico.empresa.id,
        dadosDepois: { numero: input.numero, edicao: input.edicao + 1, versaoBase: unico.empresa.versao }, origem: 'PERFIL_EMPRESA', requestId: input.requestId,
    }, tx);
    return { numero: input.numero, edicao: input.edicao + 1, versaoBase: unico.empresa.versao };
}

export async function aplicarCadastroPerfil(tx: DbExecutor, input: {
    usuarioId: string;
    empresaIdCliente: string | null;
    numero: number;
    edicao: number;
    versaoBase: number;
    confirmar: true;
    motivo: string;
    autenticadoEm: string;
    agora?: number;
    requestId: string;
}, auditoria: Auditoria) {
    const motivo = input.motivo.trim();
    if (motivo.length < 3)
        throw new ClienteServiceError('PERFIL_CADASTRO_INVALIDO', 'Informe o motivo da aplicação.', 400);
    const instalada = await estruturaCadastroInstalada(tx);
    if (!instalada)
        throw new ClienteServiceError('PERFIL_ESTRUTURA_AUSENTE', 'A estrutura do cadastro ainda não está instalada.', 409);
    const unico = await contextoUnico(tx, input.empresaIdCliente, true);
    if (!unico)
        throw new ClienteServiceError('PERFIL_ESTRUTURA_AUSENTE', 'Ainda não há empresa provisionada.', 409);
    await exigirCapacidadePerfil(tx, unico.empresa.id, input.usuarioId, 'PERFIL_APLICAR');
    if (Number(unico.empresa.versao) !== input.versaoBase)
        conflito(unico.empresa.versao, null, null);
    const rascunho = (await tx.query<{ numero: number; edicao: number; versao_base: number; conteudo: CadastroPerfil }>(
        `SELECT numero, edicao, versao_base, conteudo FROM public.perfil_empresa_revisoes
         WHERE empresa_id=$1 AND estado='RASCUNHO' FOR UPDATE`,
        [unico.empresa.id],
    )).rows[0];
    if (!rascunho || rascunho.numero !== input.numero || rascunho.edicao !== input.edicao || Number(rascunho.versao_base) !== input.versaoBase)
        conflito(unico.empresa.versao, rascunho?.edicao ?? null, rascunho?.numero ?? null);
    const validacao = validarAplicacao(rascunho.conteudo);
    if (validacao.falhas.length)
        throw new ClienteServiceError('PERFIL_CADASTRO_INVALIDO', validacao.falhas[0]!.mensagem, 400, { falhas: validacao.falhas });
    const vigente = cadastroDe(unico.empresa, unico.unidade);
    if (alteracaoSensivel(vigente, validacao.cadastro))
        exigirReautenticacaoPerfil({ autenticado_em: input.autenticadoEm }, input.agora);
    const cadastro = validacao.cadastro;
    const empresaAtualizada = await tx.query(
        `UPDATE public.perfil_empresas SET
           nome_comercial=$2, razao_social=$3, cnpj=$4,
           sede_cep=$5, sede_logradouro=$6, sede_numero=$7, sede_sem_numero=$8, sede_complemento=$9,
           sede_bairro=$10, sede_cidade=$11, sede_uf=$12, sede_pais=$13,
           versao=versao+1, atualizado_em=clock_timestamp()
         WHERE id=$1 AND versao=$14`,
        [
            unico.empresa.id, cadastro.nomeComercial, cadastro.razaoSocial, cadastro.cnpj,
            cadastro.sede.cep, cadastro.sede.logradouro, cadastro.sede.numero || null, cadastro.sede.semNumero, cadastro.sede.complemento || null,
            cadastro.sede.bairro, cadastro.sede.cidade, cadastro.sede.uf, cadastro.sede.pais,
            input.versaoBase,
        ],
    );
    if (empresaAtualizada.rowCount !== 1)
        conflito(unico.empresa.versao, input.edicao, input.numero);
    await tx.query(
        `UPDATE public.perfil_unidades SET
           nome=$2, mesmo_endereco_sede=$3, cep=$4, logradouro=$5, numero=$6, sem_numero=$7, complemento=$8,
           bairro=$9, cidade=$10, uf=$11, pais=$12, referencia_chegada=$13,
           telefone=$14, whatsapp=$15, email_comercial=$16, site=$17, instagram=$18
         WHERE id=$1`,
        [
            unico.unidade.id, cadastro.unidadeNome, cadastro.mesmoEnderecoSede,
            cadastro.unidade.cep, cadastro.unidade.logradouro, cadastro.unidade.numero || null, cadastro.unidade.semNumero, cadastro.unidade.complemento || null,
            cadastro.unidade.bairro, cadastro.unidade.cidade, cadastro.unidade.uf, cadastro.unidade.pais, cadastro.referenciaChegada || null,
            cadastro.telefone || null, cadastro.whatsapp || null, cadastro.emailComercial || null, cadastro.site || null, cadastro.instagram || null,
        ],
    );
    const aplicada = await tx.query(
        `UPDATE public.perfil_empresa_revisoes
         SET estado='APLICADA', aplicado_em=clock_timestamp(), aplicado_por=$6, motivo=$4, conteudo=$5::jsonb
         WHERE empresa_id=$1 AND estado='RASCUNHO' AND numero=$2 AND edicao=$3 AND versao_base=$7`,
        [unico.empresa.id, input.numero, input.edicao, motivo, JSON.stringify(cadastro), input.usuarioId, input.versaoBase],
    );
    if (aplicada.rowCount !== 1)
        conflito(unico.empresa.versao, input.edicao, input.numero);
    await auditoria({
        atorTipo: 'USUARIO', usuarioId: input.usuarioId, acao: 'PERFIL_CADASTRO_APLICADO',
        entidadeTipo: 'PERFIL_EMPRESA', entidadeId: unico.empresa.id,
        dadosAntes: { versao: input.versaoBase },
        dadosDepois: { versao: input.versaoBase + 1, cnpjAlterado: vigente.cnpj !== cadastro.cnpj },
        justificativa: motivo, origem: 'PERFIL_EMPRESA', requestId: input.requestId,
    }, tx);
    return { versao: input.versaoBase + 1 };
}

export async function listarHistoricoPerfil(tx: DbExecutor, usuarioId: string, empresaIdCliente: string | null = null): Promise<HistoricoPerfil[]> {
    const consulta = await consultarCadastroPerfil(tx, usuarioId, empresaIdCliente);
    if (!consulta.estruturaInstalada || !consulta.contexto)
        return [];
    const linhas = (await tx.query<{
        numero: number;
        estado: string;
        motivo: string | null;
        versao_base: number;
        editor_nome: string;
        editado_em: string;
        aplicador_nome: string | null;
        aplicado_em: string | null;
    }>(
        `SELECT r.numero, r.estado, r.motivo, r.versao_base,
                editor.nome AS editor_nome, COALESCE(r.atualizado_em, r.criado_em) AS editado_em,
                aplicador.nome AS aplicador_nome, r.aplicado_em
         FROM public.perfil_empresa_revisoes r
         JOIN usuarios_administrativos editor ON editor.id = r.autor_id
         LEFT JOIN usuarios_administrativos aplicador ON aplicador.id = r.aplicado_por
         WHERE r.empresa_id=$1
         ORDER BY r.numero DESC`,
        [consulta.contexto.empresaId],
    )).rows;
    return linhas.map((linha) => ({
        numero: linha.numero,
        estado: linha.estado,
        motivo: linha.motivo,
        versaoBase: linha.versao_base,
        editorNome: linha.editor_nome,
        editadoEm: String(linha.editado_em),
        aplicadorNome: linha.aplicador_nome,
        aplicadoEm: linha.aplicado_em == null ? null : String(linha.aplicado_em),
    }));
}

export async function lerCadastroPerfil(tx: DbExecutor, usuarioId: string) {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const consulta = await consultarCadastroPerfil(tx, usuarioId, null);
    const historico = consulta.estruturaInstalada && consulta.contexto
        ? await listarHistoricoPerfil(tx, usuarioId, null)
        : [];
    const capacidades = consulta.contexto
        ? (await consultarCapacidadesPerfil(tx, consulta.contexto.empresaId!, usuarioId)).capacidades
        : null;
    return { ...consulta, historico, capacidades };
}
