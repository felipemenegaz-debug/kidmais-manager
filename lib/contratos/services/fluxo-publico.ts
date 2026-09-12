import { buscarRevisaoDaVersao } from '../../fechamentos/repositories/revisao.repository';
import { concluirPreparacao } from '../../fechamentos/services/revisao-operacional.service';
import { db } from '../../db/postgres';
import type { DbExecutor } from '../../db/contracts';
import type { ContratoVersaoRecord } from '../repositories';
import { edicaoDaVersao, conflito, comprovantePdf } from './administrativo.service';
import { guardarDocumento, lerDocumento } from '../storage/postgres';
import { gerarContratoOficialPdfDaVersao } from './documento.service';
import { hashSnapshotContrato } from './snapshot-core';
import { randomUUID } from 'node:crypto';
import { detectarPendenciasFinanceiras } from '../../pagamentos/services/pendencias-financeiras.service';
export async function documentoParaLeitura(v: ContratoVersaoRecord, tx: DbExecutor = db()) {

    const e = await edicaoDaVersao(v.id, tx);
    if (!e) {
        if (v.status === 'ASSINADA')
            conflito('Documento legado preservado no checkpoint. Importação para BYTEA ainda não autorizada.');
        return gerarContratoOficialPdfDaVersao(v);
    }
    if (!e.documento_revisado_id)
        conflito('Documento ainda não revisado.');
    const d = await lerDocumento(e.documento_revisado_id, tx);
    if (d.contrato_versao_id !== v.id || d.snapshot_hash !== v.snapshotHash || hashSnapshotContrato(v.snapshot) !== v.snapshotHash)
        conflito('Documento ou snapshot divergente.');
    return { pdf: d.conteudo_pdf, pdfHash: d.pdf_hash, templateVersao: d.template_versao, modeloCodigo: d.template_codigo, documento: { homologadoParaProducao: true } };
}
export async function versaoPublicaId(contratoId: string, tx: DbExecutor = db()) {
    const f = (await tx.query<{
        versao_em_preparacao_id: string | null;
        versao_vigente_id: string | null;
    }>('SELECT * FROM contrato_fluxos WHERE contrato_id=$1', [contratoId])).rows[0];
    if (!f)
        return null;
    if (f.versao_em_preparacao_id) {
        const e = await edicaoDaVersao(f.versao_em_preparacao_id, tx);
        if (e?.estado === 'AGUARDANDO_CLIENTE')
            return f.versao_em_preparacao_id;
    }
    if (f.versao_vigente_id)
        return f.versao_vigente_id;
    conflito('Contrato ainda não liberado pela Kidmais.');
}
export async function registrarPendenciasDaVigencia(tx: DbExecutor, v: ContratoVersaoRecord, anterior: string | null) {
    return detectarPendenciasFinanceiras(tx,v,anterior);
}
export async function concluirFluxoCliente(tx: DbExecutor, v: ContratoVersaoRecord, validacaoId: string, context: {
    requestId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
}) {
    if((await tx.query<{status:string}>('SELECT status FROM contratos WHERE id=$1 FOR UPDATE',[v.contratoId])).rows[0]?.status==='CANCELADO')conflito('Contratação cancelada: aceite não permitido.');
    const e = await edicaoDaVersao(v.id, tx);
    if (!e || e.estado !== 'AGUARDANDO_CLIENTE' || !e.documento_revisado_id)
        conflito('Versão não liberada para aceite.');
    const d = await lerDocumento(e.documento_revisado_id, tx);
    const identity = { schemaVersao: 1, clienteId: v.snapshot.contratante.clienteId, nome: v.snapshot.contratante.nomeCompleto };
    const proof = await guardarDocumento(tx, { versaoId: v.id, categoria: 'COMPROVANTE_ASSINATURA', revisao: e.revisao, snapshotHash: v.snapshotHash, templateCodigo: 'COMPROVANTE_INTERNO_V1', usuarioId: null, pdf: comprovantePdf({ versao: v, parte: 'CLIENTE', identidade: identity, instante: v.assinadoEm!, pdfHash: d.pdf_hash, metodo: 'OTP' }) });
    await tx.query(`INSERT INTO contrato_assinaturas(contrato_versao_id,parte,documento_id,validacao_identidade_id,identidade_snapshot,snapshot_hash,pdf_hash,metodo,provider,assinado_em,ip,user_agent,request_id,chave_idempotencia,comprovante_documento_id)
  VALUES($1,'CLIENTE',$2,$3,$4,$5,$6,'OTP','INTERNAL',$7,$8,$9,$10,$11,$12)`, [v.id, d.id, validacaoId, identity, v.snapshotHash, d.pdf_hash, v.assinadoEm, context.ip ?? null, context.userAgent ?? null, context.requestId ?? randomUUID(), validacaoId, proof.id]);
    const f = (await tx.query<{
        versao_vigente_id: string | null;
    }>('SELECT versao_vigente_id FROM contrato_fluxos WHERE contrato_id=$1 FOR UPDATE', [v.contratoId])).rows[0];
    const preparacao=await buscarRevisaoDaVersao(v.id,tx,true);
    if(preparacao)await concluirPreparacao(tx,preparacao,{...context,usuarioId:null,validacaoIdentidadeId:validacaoId});
    await registrarPendenciasDaVigencia(tx, v, f.versao_vigente_id);
    await tx.query("UPDATE contrato_edicoes SET estado='CONCLUIDA' WHERE contrato_versao_id=$1", [v.id]);
    await tx.query('UPDATE contrato_fluxos SET versao_vigente_id=$2,versao_em_preparacao_id=NULL WHERE contrato_id=$1', [v.contratoId, v.id]);
    await tx.query("UPDATE contratos SET status='ASSINADO',versao_atual=$2,assinado_em=COALESCE(assinado_em,$3::timestamptz) WHERE id=$1", [v.contratoId, v.numeroVersao, v.assinadoEm]);
}
