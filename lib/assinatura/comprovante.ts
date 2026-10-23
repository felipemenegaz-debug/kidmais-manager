/**
 * Comprovante da contratação (grupo B do parecer de apoio, 22/10/2026; migration 096). Na mesma transação em que a oferta
 * é persistida, arquiva o texto integral das versões vigentes dos Termos, do Aviso e do Acordo (SHA-256 conferido pelo
 * banco) e grava o comprovante: instante, contratante (documento mascarado), condições e versões aceitas. Sem a 096 a
 * contratação segue como antes, sem comprovante persistido (código publicado antes da migration).
 * A cópia por e-mail é reforço: só com ASSINATURA_COMPROVANTE_EMAIL=true, depois do COMMIT, e a falha não apaga nada.
 */
import type { DbExecutor } from '../db/contracts';
import { mascararDocumento, tipoDocumentoFiscal } from '../acessos/validacao.ts';
import { DOCUMENTOS, IDENTIFICACAO_KIDMAIS, hashDocumento, textoCanonico, type DocumentoPublicado } from '../cadastro/documentos-legais.ts';
import type { EnviarEmail } from '../acessos/email.ts';
import { erroAcesso } from '../acessos/erros.ts';
import { documentoVigente } from './documento-contratante.ts';
import { VERSOES_PUBLICADAS } from '../cadastro/documentos-legais-historico.ts';
import { linhasComprovante, TITULO_DOCUMENTO, type Comprovante, type Contratante } from './comprovante-texto.ts';
export type { Comprovante } from './comprovante-texto.ts';

type Ambiente = Record<string, string | undefined>;
export const comprovanteEmailLigado = (env: Ambiente = process.env) => env.ASSINATURA_COMPROVANTE_EMAIL === 'true';

export async function comprovanteInstalado(tx: DbExecutor) {
    return (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.assinatura_comprovantes') IS NOT NULL AS ok")).rows[0]?.ok === true;
}

async function arquivar(tx: DbExecutor, documento: DocumentoPublicado, versao: string, hash: string, conteudo: string) {
    await tx.query(`INSERT INTO documentos_legais_versoes (documento, versao, hash, conteudo) VALUES ($1, $2, $3, $4)
        ON CONFLICT (documento, versao) DO NOTHING`, [documento, versao, hash, conteudo]);
    const guardado = (await tx.query<{ hash: string }>('SELECT hash FROM documentos_legais_versoes WHERE documento = $1 AND versao = $2', [documento, versao])).rows[0]?.hash;
    if (guardado !== hash)
        throw new Error(`096: a versão ${documento} ${versao} já foi arquivada com outro texto; publique uma nova versão.`);
}

/**
 * Arquiva as versões vigentes e as publicadas do catálogo histórico (idempotente; o banco confere cada SHA-256). Uma
 * versão já arquivada com outro conteúdo é erro de publicação: o texto mudou sem nova versão — recusa.
 * Chamar quando a versão é APRESENTADA (pedido de cadastro, síntese) e quando é aceita (revisão 00cecac, P2-B2).
 */
export async function arquivarVersoesVigentes(tx: DbExecutor) {
    const versoes = {} as Record<DocumentoPublicado, { versao: string; hash: string }>;
    for (const v of VERSOES_PUBLICADAS) await arquivar(tx, v.documento, v.versao, v.hash, v.conteudo);
    for (const d of Object.values(DOCUMENTOS)) {
        const hash = hashDocumento(d);
        await arquivar(tx, d.documento, d.versao, hash, textoCanonico(d));
        versoes[d.documento] = { versao: d.versao, hash };
    }
    return versoes;
}

export type DocumentosConfirmados = Record<DocumentoPublicado, { versao: string; hash: string }>;
/** Versões e impressões digitais que a tela apresentou na síntese; diferente das vigentes → recusa (releia e confirme). */
export function exigirDocumentosConfirmados(raw: unknown): DocumentosConfirmados {
    const docs = raw as Partial<DocumentosConfirmados> | null | undefined;
    const ok = Boolean(docs) && Object.values(DOCUMENTOS).every((d) => {
        const v = docs?.[d.documento];
        return v && v.versao === d.versao && v.hash === hashDocumento(d);
    });
    if (!ok)
        throw erroAcesso('DOCUMENTOS_ATUALIZADOS', 'Os Termos de uso, o Acordo de Tratamento de Dados ou o Aviso de privacidade foram atualizados. Releia a síntese e confirme de novo.', 409);
    return docs as DocumentosConfirmados;
}

export type OfertaComprovante = { id: string; plano: string; ciclo: string; catalogo_versao: string; valor_regular_centavos: number;
    desconto_percentual?: number; valor_final_centavos: number; fundador_id: string | null };

/** Contratante para síntese e comprovante: nome civil ou razão social, nome comercial e documento VIGENTE mascarado. */
export async function contratanteDaEmpresa(tx: DbExecutor, empresaId: string): Promise<Contratante> {
    const c = (await tx.query<{ documento_teste: string | null; nome: string; nome_empresarial: string | null }>(`SELECT a.documento_teste, e.nome,
            (SELECT nome_empresarial FROM plataforma_empresas_cadastro WHERE empresa_id = e.id) AS nome_empresarial
          FROM empresa_assinaturas a JOIN empresas e ON e.id = a.empresa_id WHERE a.empresa_id = $1::uuid`, [empresaId])).rows[0];
    const documento = (await documentoVigente(tx, empresaId, c?.documento_teste ?? null)).documento;
    return { tipo: documento && tipoDocumentoFiscal(documento) === 'CPF' ? 'PF' : 'PJ', nome: c?.nome_empresarial?.trim() || c?.nome || null,
        nomeComercial: c?.nome ?? null, documento: mascararDocumento(documento) };
}

/** Chamar na transação que persistiu a oferta nova. Idempotente por oferta. */
export async function registrarComprovante(tx: DbExecutor, input: { empresaId: string; usuarioId: string; oferta: OfertaComprovante; pagueAte: string | null;
    documentos: DocumentosConfirmados }) {
    if (!await comprovanteInstalado(tx)) return null;
    const vigentes = await arquivarVersoesVigentes(tx);
    // As versões gravadas são as CONFIRMADAS na síntese, que precisam ser as vigentes (conferidas antes pelo pedido).
    for (const k of Object.keys(vigentes) as DocumentoPublicado[])
        if (input.documentos[k]?.versao !== vigentes[k].versao || input.documentos[k]?.hash !== vigentes[k].hash)
            throw erroAcesso('DOCUMENTOS_ATUALIZADOS', 'Os documentos foram atualizados durante a contratação. Releia a síntese e confirme de novo.', 409);
    const versoes = { TERMOS_USO: input.documentos.TERMOS_USO.versao, PRIVACIDADE: input.documentos.PRIVACIDADE.versao, DPA: input.documentos.DPA.versao };
    const contratante = await contratanteDaEmpresa(tx, input.empresaId);
    const o = input.oferta;
    const condicoes = {
        ofertaId: o.id, plano: o.plano, ciclo: o.ciclo, catalogoVersao: o.catalogo_versao,
        valorRegularCentavos: o.valor_regular_centavos, descontoPercentual: o.desconto_percentual ?? 0, valorFinalCentavos: o.valor_final_centavos,
        fundador: o.fundador_id ? { reservada: true, pagueAte: input.pagueAte } : null,
    };
    await tx.query(`INSERT INTO assinatura_comprovantes (contratacao_id, empresa_id, usuario_id, contratante, condicoes, prestadora, termos_versao, privacidade_versao, dpa_versao)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::jsonb, $6, $7, $8, $9) ON CONFLICT (contratacao_id) DO NOTHING`,
        [o.id, input.empresaId, input.usuarioId, JSON.stringify(contratante), JSON.stringify(condicoes), IDENTIFICACAO_KIDMAIS, versoes.TERMOS_USO, versoes.PRIVACIDADE, versoes.DPA]);
    return o.id;
}

const ISO = (c: string) => `to_char((${c}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** Último comprovante da empresa (ou o da oferta indicada). null sem a 096 ou sem comprovante. */
export async function lerComprovante(tx: DbExecutor, empresaId: string, contratacaoId: string | null = null): Promise<Comprovante | null> {
    if (!await comprovanteInstalado(tx)) return null;
    const r = (await tx.query<{ contratacao_id: string; registrado_em: string; contratante: Comprovante['contratante']; condicoes: Comprovante['condicoes'];
        prestadora: string; termos_versao: string; privacidade_versao: string; dpa_versao: string; email_enviado_em: string | null; email_falhou_em: string | null }>(
        `SELECT contratacao_id, ${ISO('registrado_em')} AS registrado_em, contratante, condicoes, prestadora, termos_versao, privacidade_versao, dpa_versao,
                ${ISO('email_enviado_em')} AS email_enviado_em, ${ISO('email_falhou_em')} AS email_falhou_em
           FROM assinatura_comprovantes WHERE empresa_id = $1::uuid AND ($2::uuid IS NULL OR contratacao_id = $2::uuid)
          ORDER BY registrado_em DESC LIMIT 1`, [empresaId, contratacaoId])).rows[0];
    if (!r) return null;
    const docs = (await tx.query<{ documento: DocumentoPublicado; versao: string; hash: string }>(
        `SELECT documento, versao, hash FROM documentos_legais_versoes WHERE (documento, versao) IN (('TERMOS_USO', $1), ('PRIVACIDADE', $2), ('DPA', $3)) ORDER BY documento`,
        [r.termos_versao, r.privacidade_versao, r.dpa_versao])).rows;
    return { contratacaoId: r.contratacao_id, registradoEm: r.registrado_em, contratante: r.contratante, condicoes: r.condicoes, documentos: docs,
        fornecedora: r.prestadora, emailEnviadoEm: r.email_enviado_em, emailFalhouEm: r.email_falhou_em };
}

/** Texto integral arquivado de uma versão (para a página pública de versões). */
export async function versaoArquivada(tx: DbExecutor, documento: DocumentoPublicado, versao: string) {
    if (!await comprovanteInstalado(tx)) return null;
    return (await tx.query<{ conteudo: string; hash: string; registrado_em: string }>(
        `SELECT conteudo, hash, ${ISO('registrado_em')} AS registrado_em FROM documentos_legais_versoes WHERE documento = $1 AND versao = $2`, [documento, versao])).rows[0] ?? null;
}

/** Texto de uma versão publicada anterior pelo catálogo histórico (sem banco); null se não houver prova do texto. */
export function versaoDoCatalogo(documento: DocumentoPublicado, versao: string) {
    const v = VERSOES_PUBLICADAS.find((x) => x.documento === documento && x.versao === versao);
    return v ? { conteudo: v.conteudo, hash: v.hash } : null;
}

/** Síntese antes de confirmar (só a Gestão): prestadora, contratante, versões vigentes e o último comprovante. */
export async function sinteseContratacao(tx: DbExecutor, empresaId: string) {
    return {
        fornecedora: IDENTIFICACAO_KIDMAIS, contratante: await contratanteDaEmpresa(tx, empresaId),
        documentos: Object.values(DOCUMENTOS).map((d) => ({ documento: d.documento, titulo: TITULO_DOCUMENTO[d.documento], versao: d.versao, hash: hashDocumento(d), rota: d.rota })),
        comprovante: await lerComprovante(tx, empresaId),
    };
}

/**
 * Envia a cópia por e-mail (reforço) e registra UMA vez o envio ou a falha, em transação própria, depois do COMMIT da
 * oferta. Sem a chave, sem a 096 ou já registrado: não faz nada. Nunca lança.
 */
export async function enviarCopiaComprovante(deps: { withTransaction: <T>(t: (tx: DbExecutor) => Promise<T>) => Promise<T>; enviarEmail?: EnviarEmail | null },
    input: { empresaId: string; contratacaoId: string; usuarioId: string }, env: Ambiente = process.env) {
    if (!comprovanteEmailLigado(env) || !deps.enviarEmail) return 'DESLIGADO' as const;
    try {
        const dados = await deps.withTransaction(async (tx) => {
            const c = await lerComprovante(tx, input.empresaId, input.contratacaoId);
            const para = (await tx.query<{ email: string }>('SELECT email FROM usuarios_administrativos WHERE id = $1::uuid', [input.usuarioId])).rows[0]?.email;
            return c && para && !c.emailEnviadoEm && !c.emailFalhouEm ? { c, para } : null;
        });
        if (!dados) return 'NADA_A_FAZER' as const;
        let ok = true;
        try {
            const linhas = linhasComprovante(dados.c);
            const esc = (t: string) => t.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]!);
            await deps.enviarEmail({ para: dados.para, assunto: 'Comprovante da sua contratação — Kidmais Manager', texto: linhas.join('\n\n'),
                html: linhas.map((l) => `<p>${esc(l)}</p>`).join(''), idempotencia: `comprovante:${input.contratacaoId}` });
        }
        catch { ok = false; }
        await deps.withTransaction((tx) => tx.query(`UPDATE assinatura_comprovantes SET ${ok ? 'email_enviado_em' : 'email_falhou_em'} = clock_timestamp()
            WHERE contratacao_id = $1::uuid AND email_enviado_em IS NULL AND email_falhou_em IS NULL`, [input.contratacaoId]));
        return ok ? 'ENVIADO' as const : 'FALHOU' as const;
    }
    catch {
        return 'FALHOU' as const;
    }
}
