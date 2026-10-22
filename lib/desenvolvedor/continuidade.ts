import type { DbExecutor } from '../db/contracts';
import { erroAcesso, violacaoUnica } from '../acessos/erros.ts';
import { documentoFiscalValido, mascararDocumento } from '../acessos/validacao.ts';
import { continuidadeInstalada, continuidadeLigada, cpfDisponivel, documentoVigente, exigirNomeCivil, MENSAGEM_CPF_INDISPONIVEL,
    travarDocumento } from '../assinatura/documento-contratante.ts';

/**
 * Continuidade assistida do documento da contratante (D5 de 22/10/2026; parecer jurídico de apoio, §8). Só o atendimento,
 * pelo painel do desenvolvedor (concessão, senha recente, motivo), registra:
 *  - RETIFICACAO: documento do mesmo tipo digitado errado;
 *  - MESMA_TITULARIDADE: a mesma operação formalizada de CPF para CNPJ (empresário individual/MEI, aditivo);
 *  - CESSAO: CPF para CNPJ de sociedade (cessão de posição contratual, com concordância das partes).
 * Exige o instrumento assinado (identificação/versão) e as evidências do vínculo, conferidos fora do sistema. Não reescreve
 * os snapshots (documento do teste e do Fundador): preço, ciclo, benefício e datas originais seguem os registros; a linha
 * guarda um retrato deles. O documento VIGENTE passa a ser o novo (ficha, checkout, Perfil, concessão nova).
 * Com cliente já criado no provedor, fica PENDENTE_PROVEDOR (contratação bloqueada) até o atendimento registrar a
 * conferência do cliente no provedor (atualização feita pelo procedimento do provedor e do contador, fora do sistema).
 * Sem cliente no provedor, conclui na hora: o cliente será criado já com o documento vigente.
 */
export type TipoContinuidade = 'RETIFICACAO' | 'MESMA_TITULARIDADE' | 'CESSAO';
type Ambiente = Record<string, string | undefined>;
const ISO = (coluna: string) => `to_char((${coluna}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const NOTA_SEM_PROVEDOR = 'Sem cliente no provedor: o cliente será criado já com o documento vigente.';

async function exigirDisponivel(tx: DbExecutor, env: Ambiente) {
    if (!continuidadeLigada(env) || !await continuidadeInstalada(tx))
        throw erroAcesso('CONTINUIDADE_INDISPONIVEL', 'A continuidade de documento ainda não está disponível neste ambiente.', 503);
}

export async function registrarContinuidade(tx: DbExecutor, input: {
    empresaId: string; usuarioId: string; tipo: TipoContinuidade; documentoNovo: string; nomeNovo: string; instrumento: string; evidencias: string; dataEfetiva: string;
}, env: Ambiente = process.env) {
    await exigirDisponivel(tx, env);
    const linha = (await tx.query<{ documento_teste: string | null; provedor_cliente_id: string | null }>(
        'SELECT documento_teste, provedor_cliente_id FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR UPDATE', [input.empresaId])).rows[0];
    if (!linha?.documento_teste)
        throw erroAcesso('CONFLITO', 'Esta empresa ainda não tem teste nem assinatura: corrija o documento direto na ficha.', 409);
    const vigente = await documentoVigente(tx, input.empresaId, linha.documento_teste);
    if (vigente.pendente)
        throw erroAcesso('CONTINUIDADE_PENDENTE', 'Já há uma continuidade aguardando a conferência do provedor. Conclua-a antes de registrar outra.', 409);
    const anterior = vigente.documento!;
    const novo = documentoFiscalValido(input.documentoNovo);
    if (!novo)
        throw erroAcesso('DADOS_INVALIDOS', 'CPF ou CNPJ novo inválido.', 400, { campo: 'documentoNovo' });
    if (novo.numero === anterior)
        throw erroAcesso('DADOS_INVALIDOS', 'O documento novo é igual ao vigente.', 400, { campo: 'documentoNovo' });
    const mesmoTipo = novo.numero.length === anterior.length;
    if (input.tipo === 'RETIFICACAO' ? !mesmoTipo : !(anterior.length === 11 && novo.tipo === 'CNPJ'))
        throw erroAcesso('DADOS_INVALIDOS', input.tipo === 'RETIFICACAO'
            ? 'Retificação corrige um documento do mesmo tipo. Para CPF → CNPJ, use formalização da mesma titularidade ou cessão.'
            : 'Formalização e cessão valem só de CPF para CNPJ.', 400, { campo: 'tipo' });
    if (novo.tipo === 'CPF' && !await cpfDisponivel(tx, env))
        throw erroAcesso('CPF_INDISPONIVEL', MENSAGEM_CPF_INDISPONIVEL, 409, { campo: 'documentoNovo' });
    exigirNomeCivil(novo.numero, input.nomeNovo);
    await travarDocumento(tx, novo.numero);
    const usado = (await tx.query<{ n: number }>(`SELECT (
            (SELECT count(*) FROM plataforma_empresas_cadastro WHERE documento_fiscal = $1 AND empresa_id <> $2::uuid)
          + (SELECT count(*) FROM empresa_assinaturas WHERE documento_teste = $1)
          + (SELECT count(*) FROM assinatura_fundadores WHERE documento_beneficiario = $1)
          + (SELECT count(*) FROM empresa_documento_continuidades WHERE documento_novo = $1))::int AS n`, [novo.numero, input.empresaId])).rows[0];
    if ((usado?.n ?? 0) > 0)
        throw erroAcesso('DUPLICIDADE', 'Este documento já está registrado para uma contratante. Confira o vínculo antes de continuar.', 409, { campo: 'documentoNovo' });
    if (!(await tx.query('SELECT 1 FROM plataforma_empresas_cadastro WHERE empresa_id = $1::uuid FOR UPDATE', [input.empresaId])).rows.length)
        throw erroAcesso('CONFLITO', 'A empresa não tem cadastro administrativo: crie a ficha antes da continuidade.', 409);
    // Retrato das condições preservadas (sem documentos): assinatura, concessões Fundador e contratações.
    const condicoes = (await tx.query<{ c: Record<string, unknown> }>(`SELECT jsonb_build_object(
            'assinatura', (SELECT to_jsonb(a) - 'documento_teste' FROM empresa_assinaturas a WHERE a.empresa_id = $1::uuid),
            'fundador', coalesce((SELECT jsonb_agg(to_jsonb(f) - 'documento_beneficiario') FROM assinatura_fundadores f WHERE f.empresa_id = $1::uuid), '[]'::jsonb),
            'contratacoes', coalesce((SELECT jsonb_agg(to_jsonb(o)) FROM assinatura_contratacoes o WHERE o.empresa_id = $1::uuid), '[]'::jsonb),
            'retratoEm', ${ISO('clock_timestamp()')}) AS c`, [input.empresaId])).rows[0].c;
    const semProvedor = !linha.provedor_cliente_id;
    let id: string;
    try {
        id = (await tx.query<{ id: string }>(`INSERT INTO empresa_documento_continuidades
            (empresa_id, tipo, documento_anterior, documento_novo, nome_novo, instrumento, evidencias, data_efetiva, condicoes, situacao,
             provedor_conferido_em, provedor_conferido_por, provedor_nota, registrada_por)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::date, $9::jsonb, $10, CASE WHEN $11 THEN clock_timestamp() END, CASE WHEN $11 THEN $12::uuid END,
                    CASE WHEN $11 THEN $13 END, $12::uuid) RETURNING id`,
            [input.empresaId, input.tipo, anterior, novo.numero, input.nomeNovo.trim(), input.instrumento.trim(), input.evidencias.trim(), input.dataEfetiva,
                JSON.stringify(condicoes), semProvedor ? 'CONCLUIDA' : 'PENDENTE_PROVEDOR', semProvedor, input.usuarioId, NOTA_SEM_PROVEDOR])).rows[0].id;
        await tx.query('UPDATE plataforma_empresas_cadastro SET documento_fiscal = $2, nome_empresarial = $3, atualizado_por = $4 WHERE empresa_id = $1::uuid',
            [input.empresaId, novo.numero, input.nomeNovo.trim(), input.usuarioId]);
    }
    catch (error) {
        if (violacaoUnica(error, 'empresa_doc_continuidades_documento_uk') || violacaoUnica(error, 'kidmais_063_cad_documento_uk'))
            throw erroAcesso('DUPLICIDADE', 'Este documento já está registrado para uma contratante. Confira o vínculo antes de continuar.', 409, { campo: 'documentoNovo' });
        throw error;
    }
    return { continuidadeId: id, tipo: input.tipo, situacao: semProvedor ? 'CONCLUIDA' as const : 'PENDENTE_PROVEDOR' as const, documentoAnterior: anterior, documentoNovo: novo.numero };
}

/** Registra a conferência do cliente no provedor (feita pelo procedimento do provedor/contador) e libera a contratação. */
export async function concluirContinuidade(tx: DbExecutor, input: { empresaId: string; continuidadeId: string; nota: string; usuarioId: string }, env: Ambiente = process.env) {
    await exigirDisponivel(tx, env);
    const r = (await tx.query<{ id: string; documento_novo: string }>(`UPDATE empresa_documento_continuidades
        SET situacao = 'CONCLUIDA', provedor_conferido_em = clock_timestamp(), provedor_conferido_por = $3::uuid, provedor_nota = $4
        WHERE id = $1::uuid AND empresa_id = $2::uuid AND situacao = 'PENDENTE_PROVEDOR' RETURNING id, documento_novo`,
        [input.continuidadeId, input.empresaId, input.usuarioId, input.nota.trim()])).rows[0];
    if (!r)
        throw erroAcesso('CONFLITO', 'Não há continuidade pendente com este identificador nesta empresa.', 409);
    return { continuidadeId: r.id, documentoNovo: r.documento_novo };
}

/** Lista para a ficha (documentos mascarados). Vazia sem a 091. */
export async function continuidadesDaEmpresa(tx: DbExecutor, empresaId: string) {
    if (!await continuidadeInstalada(tx)) return [];
    const linhas = (await tx.query<{ id: string; tipo: TipoContinuidade; situacao: string; documento_anterior: string; documento_novo: string; nome_novo: string; instrumento: string;
        data_efetiva: string; registrada_em: string; registrada_por: string | null; provedor_conferido_em: string | null; provedor_nota: string | null }>(
        `SELECT c.id, c.tipo, c.situacao, c.documento_anterior, c.documento_novo, c.nome_novo, c.instrumento, c.data_efetiva::text AS data_efetiva,
                ${ISO('c.registrada_em')} AS registrada_em, u.nome AS registrada_por, ${ISO('c.provedor_conferido_em')} AS provedor_conferido_em, c.provedor_nota
           FROM empresa_documento_continuidades c LEFT JOIN usuarios_administrativos u ON u.id = c.registrada_por
          WHERE c.empresa_id = $1::uuid ORDER BY c.registrada_em DESC LIMIT 20`, [empresaId])).rows;
    return linhas.map((c) => ({
        id: c.id, tipo: c.tipo, situacao: c.situacao, documentoAnterior: mascararDocumento(c.documento_anterior), documentoNovo: mascararDocumento(c.documento_novo),
        nomeNovo: c.nome_novo, instrumento: c.instrumento, dataEfetiva: c.data_efetiva, registradaEm: c.registrada_em, registradaPor: c.registrada_por,
        provedorConferidoEm: c.provedor_conferido_em, provedorNota: c.provedor_nota,
    }));
}
