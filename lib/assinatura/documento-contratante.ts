/**
 * Documento de quem contrata (teste grátis, assinatura, Fundador): CPF de buffet pessoa física ou CNPJ.
 * A validação é a mesma em todos os pontos de entrada (lib/acessos/validacao.ts) e vale no servidor, não só no formulário.
 * CPF só é aceito com a 091 instalada E a chave operacional ASSINATURA_CPF_ATIVO=true; sem isso, CPF_INDISPONIVEL
 * (código novo tolera schema antigo). DV correto não prova titularidade, representação nem vínculo com algum CNPJ.
 * Troca CPF → CNPJ não é autoatendimento: documento_teste e documento_beneficiario são snapshots imutáveis (068/074a).
 * A continuidade assistida (D5, 091) registra o documento novo à parte; o VIGENTE é o da última continuidade.
 */
import type { DbExecutor } from '../db/contracts';
import { erroAcesso } from '../acessos/erros.ts';
import { documentoFiscalValido, tipoDocumentoFiscal, type TipoDocumentoFiscal } from '../acessos/validacao.ts';

type Ambiente = Record<string, string | undefined>;
export const cpfContratacaoLigado = (env: Ambiente = process.env) => env.ASSINATURA_CPF_ATIVO === 'true';
/** Namespace único de trava por documento em TODOS os pontos de entrada (nome histórico mantido: código antigo usa o mesmo). */
export const TRAVA_DOCUMENTO = 'kidmais:cnpj:';

export async function schemaCpfInstalado(tx: DbExecutor) {
    return (await tx.query<{ instalado091: boolean }>(
        "SELECT to_regprocedure('public.kidmais_091_documento_valido(text)') IS NOT NULL AS instalado091")).rows[0]?.instalado091 === true;
}

export async function cpfDisponivel(tx: DbExecutor, env: Ambiente = process.env) {
    return cpfContratacaoLigado(env) && await schemaCpfInstalado(tx);
}

export const MENSAGEM_CPF_INDISPONIVEL = 'O cadastro com CPF ainda não está disponível. Use o CNPJ do buffet ou fale com a Kidmais.';

/** Documento válido e aceito para teste/contratação neste ambiente; lança erro de domínio com o campo. */
export async function exigirDocumentoContratante(tx: DbExecutor, valor: string | null | undefined, env: Ambiente = process.env,
    esperado?: TipoDocumentoFiscal): Promise<{ numero: string; tipo: TipoDocumentoFiscal }> {
    const doc = documentoFiscalValido(valor);
    if (!doc || (esperado && doc.tipo !== esperado))
        throw erroAcesso('DADOS_INVALIDOS', esperado === 'CPF' ? 'CPF inválido. Confira os números.' : esperado === 'CNPJ' ? 'CNPJ inválido. Confira os números.' : 'CPF ou CNPJ inválido.',
            400, { campo: 'documento' });
    if (doc.tipo === 'CPF' && !await cpfDisponivel(tx, env))
        throw erroAcesso('CPF_INDISPONIVEL', MENSAGEM_CPF_INDISPONIVEL, 409, { campo: 'documento' });
    return doc;
}

export const MENSAGEM_NOME_CIVIL = 'Com CPF, informe o nome civil do titular no campo "Nome empresarial / nome civil". O nome do buffet não substitui o titular.';

/**
 * Titular PF: CPF exige nome civil próprio (nome_empresarial). Nunca é substituído pelo nome do buffet nem do responsável
 * (revisão completa de 22/10/2026, P2-1). Vale no painel (provisionar, editar, iniciar teste) e é conferido de novo no checkout.
 */
export function exigirNomeCivil(documento: string | null | undefined, nomeEmpresarial: string | null | undefined) {
    if (documento && tipoDocumentoFiscal(documento) === 'CPF' && !nomeEmpresarial?.trim())
        throw erroAcesso('DADOS_INVALIDOS', MENSAGEM_NOME_CIVIL, 400, { campo: 'nomeEmpresarial' });
}

/** Continuidade assistida (D5): registro pelo painel só com a 091 E ASSINATURA_CONTINUIDADE_ATIVA=true. A leitura vale sempre. */
export const continuidadeLigada = (env: Ambiente = process.env) => env.ASSINATURA_CONTINUIDADE_ATIVA === 'true';
export async function continuidadeInstalada(tx: DbExecutor) {
    return (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.empresa_documento_continuidades') IS NOT NULL AS ok")).rows[0]?.ok === true;
}
export const MENSAGEM_CONTINUIDADE_PENDENTE = 'Há uma atualização do CPF ou CNPJ da contratante em andamento pelo atendimento. A contratação fica disponível assim que ela for concluída.';

/**
 * Documento vigente da contratante: o da última continuidade registrada (091) ou, sem continuidade, o do teste.
 * `pendente`: a última continuidade ainda aguarda a conferência do cliente no provedor (nada é contratado até lá).
 */
export async function documentoVigente(tx: DbExecutor, empresaId: string, documentoTeste: string | null): Promise<{ documento: string | null; pendente: boolean }> {
    if (!documentoTeste || !await continuidadeInstalada(tx))
        return { documento: documentoTeste, pendente: false };
    const c = (await tx.query<{ documento_novo: string; situacao: string }>(
        `SELECT documento_novo, situacao FROM empresa_documento_continuidades WHERE empresa_id = $1::uuid ORDER BY registrada_em DESC, id DESC LIMIT 1`, [empresaId])).rows[0];
    return { documento: c?.documento_novo ?? documentoTeste, pendente: c?.situacao === 'PENDENTE_PROVEDOR' };
}

/** Trava do documento (antes de conferir duplicidade), igual no cadastro público, no painel e no teste. */
export async function travarDocumento(tx: DbExecutor, numero: string) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:cnpj:' || $1))", [numero]);
}
