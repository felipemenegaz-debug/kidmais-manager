import type { DbExecutor } from '../db/contracts';
import { erroAcesso, violacaoUnica } from '../acessos/erros.ts';
import { duracaoTesteDias, EXTENSAO_TESTE_MAXIMA_DIAS } from './configuracao.ts';

/**
 * Operações do modelo comercial (067 + 068), sempre DENTRO da transação de quem já autorizou o ator:
 *   - iniciarTeste: só o cadastro público (E6) cria a assinatura, em TESTE, com datas do relógio do banco;
 *   - estenderTeste / concederExcecao / revogarExcecao: só o painel do desenvolvedor (E5), com motivo e prazo.
 * A auditoria de negócio é feita pelo chamador (ele conhece o ator e a origem). Nada aqui concede papel, vínculo ou
 * concessão de desenvolvedor, e nada muda empresas.status (eixo administrativo).
 */
const ISO = (coluna: string) => `to_char((${coluna}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const CNPJ = /^[0-9A-Z]{12}[0-9]{2}$/;

export async function iniciarTeste(tx: DbExecutor, input: { empresaId: string; documento: string; dias?: number }) {
    if (!CNPJ.test(input.documento))
        throw erroAcesso('DADOS_INVALIDOS', 'CNPJ inválido para o teste.', 400);
    const dias = input.dias ?? duracaoTesteDias();
    if (!Number.isInteger(dias) || dias < 1 || dias > 90)
        throw erroAcesso('DADOS_INVALIDOS', 'Duração do teste inválida.', 400);
    await tx.query('SAVEPOINT kidmais_iniciar_teste');
    try {
        const r = (await tx.query<{ teste_inicio: string; teste_fim: string }>(
            `INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim, documento_teste)
             SELECT $1::uuid, 'TESTE', agora.t, agora.t + make_interval(days => $3::int), $2
               FROM (SELECT clock_timestamp() AS t) agora
             RETURNING ${ISO('teste_inicio')} AS teste_inicio, ${ISO('teste_fim')} AS teste_fim`,
            [input.empresaId, input.documento, dias])).rows[0];
        await tx.query('RELEASE SAVEPOINT kidmais_iniciar_teste');
        return { testeInicio: r.teste_inicio, testeFim: r.teste_fim, dias };
    }
    catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT kidmais_iniciar_teste');
        if (violacaoUnica(error, 'empresa_assinaturas_documento_teste_uk'))
            throw erroAcesso('TESTE_JA_UTILIZADO', 'Este CNPJ já utilizou o teste grátis.', 409);
        if (violacaoUnica(error, 'empresa_assinaturas_pkey'))
            throw erroAcesso('CONFLITO', 'Esta empresa já tem situação comercial registrada.', 409);
        throw error;
    }
}

type Assinatura = { situacao: string; teste_fim: string; versao: number };
async function assinaturaTravada(tx: DbExecutor, empresaId: string) {
    return (await tx.query<Assinatura>(
        `SELECT situacao, ${ISO('teste_fim')} AS teste_fim, versao FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR UPDATE`, [empresaId])).rows[0] ?? null;
}

function motivoValido(motivo: unknown) {
    const m = typeof motivo === 'string' ? motivo.trim() : '';
    if (m.length < 5 || m.length > 500)
        throw erroAcesso('DADOS_INVALIDOS', 'Informe o motivo (5 a 500 caracteres).', 400);
    return m;
}

/**
 * Estende o teste em `dias` a partir do maior entre o fim atual e agora (teste vencido volta a contar de hoje).
 * Registra a exceção EXTENSAO_TESTE com o novo prazo e avança teste_fim na mesma transação.
 */
export async function estenderTeste(tx: DbExecutor, input: { empresaId: string; dias: number; motivo: string; usuarioId: string }) {
    const motivo = motivoValido(input.motivo);
    if (!Number.isInteger(input.dias) || input.dias < 1 || input.dias > EXTENSAO_TESTE_MAXIMA_DIAS)
        throw erroAcesso('DADOS_INVALIDOS', `A extensão vai de 1 a ${EXTENSAO_TESTE_MAXIMA_DIAS} dias.`, 400);
    const atual = await assinaturaTravada(tx, input.empresaId);
    if (!atual)
        throw erroAcesso('CONFLITO', 'Empresa sem cobrança: não há teste a estender.', 409);
    if (atual.situacao !== 'TESTE')
        throw erroAcesso('CONFLITO', 'Só é possível estender enquanto a empresa está em teste.', 409);
    const novo = (await tx.query<{ fim: string }>(
        `SELECT ${ISO("greatest(teste_fim, clock_timestamp()) + make_interval(days => $2::int)")} AS fim FROM empresa_assinaturas WHERE empresa_id = $1::uuid`,
        [input.empresaId, input.dias])).rows[0].fim;
    const excecao = (await tx.query<{ id: string }>(
        `INSERT INTO empresa_excecoes_comerciais (empresa_id, tipo, valida_ate, motivo, criado_por)
         VALUES ($1::uuid, 'EXTENSAO_TESTE', $2::timestamptz, $3, $4::uuid) RETURNING id`, [input.empresaId, novo, motivo, input.usuarioId])).rows[0];
    await tx.query('UPDATE empresa_assinaturas SET teste_fim = $2::timestamptz WHERE empresa_id = $1::uuid', [input.empresaId, novo]);
    return { excecaoId: excecao.id, testeFimAntes: atual.teste_fim, testeFimDepois: novo, motivo };
}

/** Cortesia ou acesso temporário: COMPLETO até o prazo, sem mexer na assinatura. Só para empresas com cobrança. */
export async function concederExcecao(tx: DbExecutor, input: { empresaId: string; tipo: 'CORTESIA' | 'ACESSO_TEMPORARIO'; dias: number; motivo: string; usuarioId: string }) {
    const motivo = motivoValido(input.motivo);
    if (input.tipo !== 'CORTESIA' && input.tipo !== 'ACESSO_TEMPORARIO')
        throw erroAcesso('DADOS_INVALIDOS', 'Tipo de exceção inválido.', 400);
    if (!Number.isInteger(input.dias) || input.dias < 1 || input.dias > 365)
        throw erroAcesso('DADOS_INVALIDOS', 'O prazo vai de 1 a 365 dias.', 400);
    if (!await assinaturaTravada(tx, input.empresaId))
        throw erroAcesso('CONFLITO', 'Empresa sem cobrança: o acesso já é completo.', 409);
    const r = (await tx.query<{ id: string; valida_ate: string }>(
        `INSERT INTO empresa_excecoes_comerciais (empresa_id, tipo, valida_ate, motivo, criado_por)
         VALUES ($1::uuid, $2, clock_timestamp() + make_interval(days => $3::int), $4, $5::uuid)
         RETURNING id, ${ISO('valida_ate')} AS valida_ate`, [input.empresaId, input.tipo, input.dias, motivo, input.usuarioId])).rows[0];
    return { excecaoId: r.id, tipo: input.tipo, validaAte: r.valida_ate, motivo };
}

export async function revogarExcecao(tx: DbExecutor, input: { empresaId: string; excecaoId: string; motivo: string; usuarioId: string }) {
    const motivo = motivoValido(input.motivo);
    const atual = (await tx.query<{ tipo: string; revogada_em: string | null; valida_ate: string; vencida: boolean }>(
        `SELECT tipo, revogada_em::text, ${ISO('valida_ate')} AS valida_ate, valida_ate <= clock_timestamp() AS vencida FROM empresa_excecoes_comerciais
          WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`, [input.excecaoId, input.empresaId])).rows[0];
    if (!atual)
        throw erroAcesso('NAO_ENCONTRADO', 'Exceção não encontrada nesta empresa.', 404);
    if (atual.revogada_em)
        throw erroAcesso('CONFLITO', 'A exceção já foi revogada.', 409);
    if (atual.tipo === 'EXTENSAO_TESTE')
        throw erroAcesso('CONFLITO', 'Extensão de teste não é revogada: o novo prazo já foi gravado no teste.', 409);
    // Só exceção vigente: revogar uma já vencida gravaria na auditoria um efeito que não existiu.
    if (atual.vencida)
        throw erroAcesso('CONFLITO', 'A exceção já venceu; não há acesso a revogar.', 409);
    await tx.query(
        `UPDATE empresa_excecoes_comerciais SET revogada_em = clock_timestamp(), revogada_por = $3::uuid, motivo_revogacao = $4
          WHERE id = $1::uuid AND empresa_id = $2::uuid`, [input.excecaoId, input.empresaId, input.usuarioId, motivo]);
    return { excecaoId: input.excecaoId, tipo: atual.tipo, validaAte: atual.valida_ate, motivo };
}
