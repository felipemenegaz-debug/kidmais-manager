import { buscarRevisaoDaVersao, listarItensRevisao, salvarOperacaoPreparada } from '../../fechamentos/repositories/revisao.repository';
import { recusarComercialPreparacao, iniciarPreparacao, snapshotPreparacao, editarPreparacao, aprovarPreparacao, revalidarAgendaRevisao, congelarPreparacao, cancelarPreparacao } from '../../fechamentos/services/revisao-operacional.service';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DbExecutor } from '../../db/contracts';
import { db, withTransaction } from '../../db/postgres';
import { consultarSessao, authError, type SessaoAdmin } from '../../autenticacao/service';
import { registrarAuditoria, registrarEventoHistorico } from '../../clientes/repositories';
import { buscarVersaoPorId, criarContratoVersao, type ContratoVersaoRecord } from '../repositories';
import { hashSnapshotContrato } from './snapshot-core';
import { ContratoServiceError } from './errors';
import { renderizarContratoOficial, gerarPdfContratoOficial, gerarPdfDocumentoContrato } from '../documento';
import { guardarDocumento, lerDocumento } from '../storage/postgres';
import { edicaoFestaSchema } from '../../fechamentos/services/edicao-administrativa-schema';
import { editarFechamentoAdministrativo } from '../../fechamentos/services/edicao-administrativa.service';
import { buscarFechamentoPorIdParaAtualizacao, buscarFechamentoPorId } from '../../fechamentos/repositories';
import { carregarSnapshot } from './contrato.service';
import { atualizarClienteInterno } from '../../clientes/services';
import { buscarClientePorId, buscarAniversariantePorId } from '../../clientes/repositories';
import { atualizarAniversarianteInterno } from '../../clientes/services/aniversariante.service';
import { diferencasContratuais } from './alteracoes';
import { exigirVersaoEditavel, fonteDaRevisaoInicial, prepararEdicaoInicial, type RevisaoInicial } from './revisao-inicial';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export const acaoContratoSchema = z.discriminatedUnion('acao', [
    edicaoFestaSchema,
    z.object({acao:z.literal('recusar_comercial'),revisao:z.number().int().positive(),motivo:z.string().trim().min(3).max(500),chaveDecisao:uuid}).strict(),
    z.object({ acao: z.literal('cancelar_revisao'), revisao: z.number().int().positive(), motivo: z.string().trim().min(3).max(500) }).strict(),
    z.object({ acao: z.literal('cancelar_contratacao'), motivo: z.string().trim().min(3).max(500) }).strict(),
    z.object({ acao: z.literal('revalidar_destino'), revisao: z.number().int().positive() }).strict(),
    z.object({ acao: z.literal('salvar'), revisao: z.number().int().positive(), observacoesDocumentais: z.string().trim().max(2000) }).strict(),
    z.object({ acao: z.literal('gerar_pdf'), revisao: z.number().int().positive() }).strict(),
    z.object({ acao: z.literal('revisar'), revisao: z.number().int().positive(), documentoId: uuid }).strict(),
    z.object({ acao: z.literal('assinar'), revisao: z.number().int().positive(), documentoId: uuid, chaveIdempotencia: uuid }).strict(),
    z.object({ acao: z.literal('liberar'), revisao: z.number().int().positive() }).strict(),
    z.object({ acao: z.literal('nova_versao'), tipo: z.enum(['NOVA_VERSAO', 'RETIFICACAO', 'ADITIVO']), motivo: z.string().trim().min(3).max(500), chaveCriacao: uuid.optional() }).strict(),
    z.object({ acao: z.literal('substituir_preparacao'), motivo: z.string().trim().min(3).max(500), chaveCriacao: uuid }).strict(),
]);
export type Edicao = {
    contrato_versao_id: string;
    contrato_id: string;
    origem_versao_id: string | null;
    tipo: string;
    estado: string;
    revisao: number;
    documento_revisado_id: string | null;
    revisao_comercial_aprovada: number | null;
    dados_fonte: {
        schemaVersao: 1;
        observacoesDocumentais?: string;
        revisaoInicial?: RevisaoInicial;
    };
};
export function conflito(message: string): never { throw new ContratoServiceError('DADOS_CONTRATUAIS_INCONSISTENTES', message, 409); }
export async function edicaoDaVersao(id: string, tx: DbExecutor = db()) { return (await tx.query<Edicao>('SELECT * FROM contrato_edicoes WHERE contrato_versao_id=$1', [id])).rows[0] ?? null; }
export async function iniciarEdicao(tx: DbExecutor, v: ContratoVersaoRecord, usuarioId: string, origem: string | null = null, tipo = 'INICIAL') {
    const active = (await tx.query('SELECT id FROM usuarios_administrativos WHERE id=$1 AND ativo', [usuarioId])).rows[0];
    if (!active)
        throw authError();
    const source = v.snapshot as ContratoVersaoRecord['snapshot'] & { documental?: { observacoes?: string } };
    const observacoesDocumentais = source.documental?.observacoes ?? '';
    await tx.query(`INSERT INTO contrato_edicoes(contrato_versao_id,contrato_id,origem_versao_id,tipo,estado,dados_fonte,alteracoes,criado_por_usuario_id,atualizado_por_usuario_id)
 VALUES($1,$2,$3,$4,'EM_ELABORACAO',$5,'{}',$6,$6)`, [v.id, v.contratoId, origem, tipo, { schemaVersao: 1, observacoesDocumentais }, usuarioId]);
    await tx.query(`INSERT INTO contrato_fluxos(contrato_id,versao_em_preparacao_id,versao_vigente_id) VALUES($1,$2,$3)
 ON CONFLICT(contrato_id) DO UPDATE SET versao_em_preparacao_id=EXCLUDED.versao_em_preparacao_id`, [v.contratoId, v.id, origem]);
}
async function evento(tx: DbExecutor, v: ContratoVersaoRecord, s: SessaoAdmin, acao: string, detail: Record<string, unknown> = {}) {
    await registrarAuditoria({ atorTipo: 'USUARIO', usuarioId: s.usuario_id, acao, entidadeTipo: 'CONTRATO_VERSAO', entidadeId: v.id, clienteId: v.snapshot.contratante.clienteId, origem: 'CONTRATO_ADMIN', dadosDepois: detail }, tx);
    await registrarEventoHistorico({ clienteId: v.snapshot.contratante.clienteId, tipoEvento: acao, origem: 'CONTRATO_ADMIN', entidadeTipo: 'CONTRATO_VERSAO', entidadeId: v.id, usuarioId: s.usuario_id, metadata: detail }, tx);
}
export async function fontesEdicao(fechamentoId:string,tx:DbExecutor=db()) {
    const fechamento=await buscarFechamentoPorId(fechamentoId,tx);
    if(!fechamento) conflito('Fechamento não encontrado.');
    const cliente=fechamento.clienteId ? await buscarClientePorId(fechamento.clienteId,tx):null;
    const aniversariante=fechamento.aniversarianteId ? await buscarAniversariantePorId(fechamento.aniversarianteId,tx):null;
    const adicionais=(await tx.query<{codigo:string;quantidade:number}>(`SELECT a.codigo,fa.quantidade::float AS quantidade FROM fechamento_adicionais fa JOIN adicionais a ON a.id=fa.adicional_id WHERE fa.fechamento_id=$1 ORDER BY a.codigo`,[fechamentoId])).rows;
    return {fechamento,cliente,aniversariante,adicionais,fonteHash:hashSnapshotContrato({fechamento,cliente,aniversariante,adicionais})};
}
async function salvarElaboracao(tx:DbExecutor,v:ContratoVersaoRecord,e:Edicao,s:SessaoAdmin,snapshot:ContratoVersaoRecord['snapshot'],revisaoInicial?:RevisaoInicial) {
    if(hashSnapshotContrato(snapshot)===v.snapshotHash)return {revisao:e.revisao,reutilizado:true};
    const origem=e.origem_versao_id ? await buscarVersaoPorId(e.origem_versao_id,tx):null;
    const alteracoes=diferencasContratuais(origem?.snapshot ?? v.snapshot,snapshot);
    await tx.query('UPDATE contrato_versoes SET snapshot=$2,snapshot_hash=$3 WHERE id=$1',[v.id,snapshot,hashSnapshotContrato(snapshot)]);
    const documental=snapshot as typeof snapshot & {documental?:{observacoes:string}};
    await tx.query(`UPDATE contrato_edicoes SET revisao=revisao+1,dados_fonte=$2,alteracoes=$3,documento_revisado_id=NULL,revisado_por_usuario_id=NULL,revisado_em=NULL,revisao_comercial_aprovada=NULL,aprovado_comercial_por_usuario_id=NULL,aprovado_comercial_em=NULL,atualizado_por_usuario_id=$4 WHERE contrato_versao_id=$1`,[v.id,{...e.dados_fonte,...(revisaoInicial?{revisaoInicial}:{}),observacoesDocumentais:documental.documental?.observacoes ?? ''},{campos:alteracoes},s.usuario_id]);
    await registrarAuditoria({atorTipo:'USUARIO',usuarioId:s.usuario_id,acao:'CONTRATO_EDICAO_SALVA',entidadeTipo:'CONTRATO_VERSAO',entidadeId:v.id,clienteId:v.snapshot.contratante.clienteId,origem:'CONTRATO_ADMIN',dadosAntes:{snapshot:v.snapshot,revisao:e.revisao},dadosDepois:{snapshot,revisao:e.revisao+1},justificativa:revisaoInicial?.motivo},tx);
    return {revisao:e.revisao+1};
}
export function comprovantePdf(input: {
    versao: ContratoVersaoRecord;
    parte: string;
    identidade: Record<string, unknown>;
    instante: string;
    pdfHash: string;
    metodo: string;
}) {
    return gerarPdfDocumentoContrato({ cabecalhoRotulo: 'COMPROVANTE DE ASSINATURA', templateVersao: 1, homologadoParaProducao: true, titulo: 'Comprovante de assinatura eletrônica', linhas: [
            { texto: 'Comprovante de assinatura eletrônica', estilo: 'titulo' },
            { texto: 'Dados da assinatura', estilo: 'secao' },
            ...[`Parte: ${input.parte}`, `Versão: ${input.versao.numeroVersao} — ${input.versao.id}`, `Nome: ${input.identidade.nome ?? ''}`, `Data/hora: ${input.instante}`, `Método: ${input.metodo}`, `SHA-256 do documento: ${input.pdfHash}`, `SHA-256 do snapshot: ${input.versao.snapshotHash}`].map(texto => ({ texto, estilo: 'corpo' as const })),
            { texto: `Versão documental: ${input.versao.numeroVersao}`, estilo: 'rodape' },
        ] });
}
export async function operarContrato(versaoId: string, input: z.infer<typeof acaoContratoSchema>, token: string, context: {
    requestId: string;
    ip: string | null;
    userAgent: string | null;
}) {
    input=acaoContratoSchema.parse(input);
    return withTransaction(async (tx) => {
        const preliminary = await buscarVersaoPorId(versaoId, tx);
        if (!preliminary)
            conflito('Versão não encontrada.');
        const c = (await tx.query<{
            id: string;
            fechamento_id: string;
            status: string;
        }>('SELECT id,fechamento_id,status FROM contratos WHERE id=$1', [preliminary.contratoId])).rows[0];
        await tx.query('SELECT id FROM fechamentos WHERE id=$1 FOR UPDATE', [c.fechamento_id]);
        await tx.query('SELECT id FROM contratos WHERE id=$1 FOR UPDATE', [c.id]);
        const f = (await tx.query<{
            versao_vigente_id: string | null;
            versao_em_preparacao_id: string | null;
        }>('SELECT * FROM contrato_fluxos WHERE contrato_id=$1 FOR UPDATE', [c.id])).rows[0];
        const v = (await buscarVersaoPorId(versaoId, tx, { forUpdate: true }))!;
        const s = await consultarSessao(token, tx, true);
        const statusAtual=(await tx.query<{status:string}>('SELECT status FROM contratos WHERE id=$1',[c.id])).rows[0].status;
        if(statusAtual==='CANCELADO')conflito('Contratação cancelada: histórico disponível somente para consulta.');
        const rc = {...context,usuarioId:s.usuario_id};
        if (hashSnapshotContrato(v.snapshot) !== v.snapshotHash)
            conflito('O snapshot da versão não corresponde ao hash preservado.');
        if(input.acao==='cancelar_contratacao') {
            if(statusAtual!=='AGUARDANDO_ASSINATURA'||f?.versao_vigente_id)
                conflito('Esta contratação já foi assinada pelas duas partes. Use o fluxo de cancelamento da Festa.');
            if(!(await tx.query("SELECT 1 FROM festa_usuario_capacidades WHERE usuario_id=$1 AND capacidade='FESTA_CORRIGIR' AND revogado_em IS NULL",[s.usuario_id])).rows.length)
                throw authError('Somente a Gestão pode cancelar a contratação.',403);
            if((await tx.query("SELECT 1 FROM contrato_assinaturas WHERE contrato_versao_id IN (SELECT id FROM contrato_versoes WHERE contrato_id=$1) AND parte='CLIENTE' LIMIT 1",[c.id])).rows.length)
                conflito('Já existe assinatura do cliente. Confira a contratação antes de cancelar.');
            if((await tx.query('SELECT 1 FROM festas WHERE contrato_id=$1 LIMIT 1',[c.id])).rows.length ||
                (await tx.query('SELECT 1 FROM pagamentos p JOIN contrato_versoes cv ON cv.id=p.contrato_versao_id WHERE cv.contrato_id=$1 LIMIT 1',[c.id])).rows.length)
                conflito('Há Festa ou plano financeiro associado. Use o fluxo de cancelamento da Festa.');
            const aberta=f?.versao_em_preparacao_id ? await buscarRevisaoDaVersao(f.versao_em_preparacao_id,tx,true):null;
            if(aberta && ['EM_ELABORACAO','CONGELADA'].includes(aberta.estado))await cancelarPreparacao(tx,aberta,rc,input.motivo);
            await tx.query("UPDATE contratos SET status='CANCELADO',cancelado_em=clock_timestamp() WHERE id=$1",[c.id]);
            await tx.query("UPDATE fechamentos SET status='CANCELADO' WHERE id=$1",[c.fechamento_id]);
            await evento(tx,v,s,'CONTRATO_CANCELADO_ANTES_DA_FORMALIZACAO',{contratoId:c.id,motivo:input.motivo,...context});
            return {cancelada:true};
        }
        if(input.acao==='substituir_preparacao') {
            const anterior=(await tx.query<{usuario_id:string;dados_depois:{origem:string;motivo:string;versaoId:string}}>(
                "SELECT usuario_id,dados_depois FROM auditoria WHERE acao='CONTRATO_PREPARACAO_SUBSTITUIDA' AND entidade_id=$1 AND dados_depois->>'chaveCriacao'=$2",[v.id,input.chaveCriacao])).rows[0];
            if(anterior){if(anterior.usuario_id!==s.usuario_id||anterior.dados_depois.motivo!==input.motivo)conflito('Chave usada por outro pedido.');return {versaoId:anterior.dados_depois.versaoId,reutilizado:true};}
            const congelada=await edicaoDaVersao(v.id,tx);
            if(v.status!=='ATIVA'||f?.versao_em_preparacao_id!==v.id||!congelada||!['ASSINADA_KIDMAIS','AGUARDANDO_CLIENTE'].includes(congelada.estado))
                conflito('A preparação mudou. Atualize a tela; a versão anterior não pode ser substituída por este pedido.');
            const antiga=await buscarRevisaoDaVersao(v.id,tx,true);
            if(f.versao_vigente_id&&!antiga)conflito('Preparação legada: revisão operacional necessária antes de substituir.');
            const itens=antiga?await listarItensRevisao(antiga.id,tx):[];
            if(antiga)await cancelarPreparacao(tx,antiga,rc,input.motivo);
            else {
                await tx.query("UPDATE contrato_edicoes SET estado='CANCELADA',atualizado_por_usuario_id=$2 WHERE contrato_versao_id=$1",[v.id,s.usuario_id]);
                await tx.query("UPDATE contrato_versoes SET status='CANCELADA' WHERE id=$1",[v.id]);
                await tx.query('UPDATE contrato_fluxos SET versao_em_preparacao_id=NULL WHERE contrato_id=$1',[c.id]);
            }
            const numero=(await tx.query<{n:number}>('SELECT max(numero_versao)+1 AS n FROM contrato_versoes WHERE contrato_id=$1',[c.id])).rows[0].n;
            const base=f.versao_vigente_id?(await buscarVersaoPorId(f.versao_vigente_id,tx))!:v;
            const snapshot=structuredClone(v.snapshot);
            const next=await criarContratoVersao({contratoId:c.id,numeroVersao:numero,snapshot,snapshotHash:hashSnapshotContrato(snapshot),motivoNovaVersao:input.motivo,geradoPorUsuarioId:s.usuario_id},tx);
            await iniciarEdicao(tx,next,s.usuario_id,base.id,'NOVA_VERSAO');
            // Antes da primeira formalização, a proposta fica na edição, sem mudar o fechamento.
            if(congelada.dados_fonte?.revisaoInicial) await tx.query('UPDATE contrato_edicoes SET dados_fonte=$2 WHERE contrato_versao_id=$1',
                [next.id,{schemaVersao:1,observacoesDocumentais:congelada.dados_fonte.observacoesDocumentais ?? '',revisaoInicial:congelada.dados_fonte.revisaoInicial}]);
            if(antiga) {
                const nova=await iniciarPreparacao(tx,base,next,input.motivo,input.chaveCriacao,rc);
                const copiada=(await salvarOperacaoPreparada(tx,nova,antiga.operacao,itens,s.usuario_id,input.motivo))!;
                await revalidarAgendaRevisao(tx,copiada,rc,{mudouDestino:true});
                const preparado=await snapshotPreparacao(tx,copiada,next);
                await tx.query('UPDATE contrato_versoes SET snapshot=$2,snapshot_hash=$3 WHERE id=$1',[next.id,preparado,hashSnapshotContrato(preparado)]);
            }
            await evento(tx,v,s,'CONTRATO_PREPARACAO_SUBSTITUIDA',{origem:v.id,versaoId:next.id,motivo:input.motivo,chaveCriacao:input.chaveCriacao});
            return {versaoId:next.id};
        }
        if (input.acao === 'nova_versao') {
            if (input.tipo === 'ADITIVO')
                conflito('O template específico de aditivo exige revisão de domínio antes de habilitar esta ação. Nova versão documental e retificação estão disponíveis.');
            const chave=input.chaveCriacao??context.requestId;
            const anterior=(await tx.query<{contrato_versao_id:string;versao_base_id:string;criado_por_usuario_id:string;pedido_motivo:string;tipo:string}>(
                `SELECT r.contrato_versao_id,r.versao_base_id,r.criado_por_usuario_id,a.dados_depois->>'motivo' AS pedido_motivo,a.dados_depois->>'tipo' AS tipo FROM fechamento_revisoes r LEFT JOIN auditoria a ON a.entidade_id=r.contrato_versao_id AND a.acao='CONTRATO_NOVA_VERSAO' WHERE r.chave_criacao=$1`,[chave])).rows[0];
            if(anterior){if(anterior.versao_base_id!==v.id||anterior.criado_por_usuario_id!==s.usuario_id||anterior.pedido_motivo!==input.motivo||anterior.tipo!==input.tipo)conflito('Chave de criação já usada para outro pedido.');return {versaoId:anterior.contrato_versao_id,reutilizado:true};}
            if (c.status !== 'ASSINADO' || v.status !== 'ASSINADA' || (f && f.versao_vigente_id !== v.id))
                conflito('Selecione a versão vigente assinada, sem outra preparação aberta.');
            if(f?.versao_em_preparacao_id) {
                const aberta=await edicaoDaVersao(f.versao_em_preparacao_id,tx);
                if(aberta?.estado!=='EM_ELABORACAO') conflito('A preparação já está congelada para assinatura.');
                return {versaoId:f.versao_em_preparacao_id,reutilizado:true};
            }
            const n = (await tx.query<{
                n: number;
            }>('SELECT max(numero_versao)+1 AS n FROM contrato_versoes WHERE contrato_id=$1', [c.id])).rows[0].n;
            const snapshot = structuredClone(v.snapshot);
            const next = await criarContratoVersao({ contratoId: c.id, numeroVersao: n, snapshot, snapshotHash: hashSnapshotContrato(snapshot), motivoNovaVersao: input.motivo, geradoPorUsuarioId: s.usuario_id }, tx);
            await iniciarEdicao(tx, next, s.usuario_id, v.id, input.tipo);
            const preparacao=await iniciarPreparacao(tx,v,next,input.motivo,input.chaveCriacao??context.requestId,rc);
            const preparado=await snapshotPreparacao(tx,preparacao,next);
            await tx.query('UPDATE contrato_versoes SET snapshot=$2,snapshot_hash=$3 WHERE id=$1',[next.id,preparado,hashSnapshotContrato(preparado)]);
            await evento(tx, next, s, 'CONTRATO_NOVA_VERSAO', { origem: v.id, tipo: input.tipo, motivo: input.motivo });
            return { versaoId: next.id };
        }
        const e = await edicaoDaVersao(v.id, tx);
        const preparacao=await buscarRevisaoDaVersao(v.id,tx,true);
        if (['editar_festa','salvar'].includes(input.acao)) {
            const assinatura = (await tx.query('SELECT 1 FROM contrato_assinaturas WHERE contrato_versao_id=$1 LIMIT 1',[v.id])).rows.length>0;
            exigirVersaoEditavel(v,e,c.id,f?.versao_em_preparacao_id,assinatura);
        }
        if(input.acao==='cancelar_revisao' && preparacao?.estado==='CANCELADA')return cancelarPreparacao(tx,preparacao,rc,input.motivo);
        if (!e || e.revisao !== input.revisao)
            conflito('Revisão mudou ou versão legada sem edição. Atualize a tela.');
        if(input.acao==='cancelar_revisao'){if(!preparacao){if(!e.origem_versao_id||!['EM_ELABORACAO','ASSINADA_KIDMAIS','AGUARDANDO_CLIENTE'].includes(e.estado)||f?.versao_em_preparacao_id!==v.id)conflito('Sem proposta legada aberta para cancelar.');await tx.query("UPDATE contrato_edicoes SET estado='CANCELADA',atualizado_por_usuario_id=$2 WHERE contrato_versao_id=$1",[v.id,s.usuario_id]);await tx.query("UPDATE contrato_versoes SET status='CANCELADA' WHERE id=$1",[v.id]);await tx.query('UPDATE contrato_fluxos SET versao_em_preparacao_id=NULL WHERE contrato_id=$1',[c.id]);await evento(tx,v,s,'CONTRATO_PROPOSTA_LEGADA_CANCELADA',{motivo:input.motivo,...context});return {cancelada:true};}return cancelarPreparacao(tx,preparacao,rc,input.motivo);}
        if(input.acao==='recusar_comercial'){if(!preparacao)conflito('Sem preparação operacional.');return recusarComercialPreparacao(tx,preparacao,rc,input.chaveDecisao,input.motivo);}
        if(input.acao==='revalidar_destino'){if(!preparacao||!['EM_ELABORACAO','CONGELADA'].includes(preparacao.estado))conflito('Sem preparação aberta.');await revalidarAgendaRevisao(tx,preparacao,rc);return {revalidado:true};}
        if(preparacao && ['gerar_pdf','revisar','assinar','liberar'].includes(input.acao) && !(input.acao==='assinar'&&e.estado!=='EM_ELABORACAO')){
            if(preparacao.estado==='EM_ELABORACAO'){
                await tx.query('SELECT id FROM clientes WHERE id=$1 FOR UPDATE',[preparacao.operacao.clienteId]);
                await tx.query('SELECT id FROM aniversariantes WHERE id=$1 FOR UPDATE',[preparacao.operacao.aniversarianteId]);
                if(preparacao.operacao.responsavelAdicionalId)await tx.query('SELECT id FROM responsaveis_adicionais WHERE id=$1 FOR UPDATE',[preparacao.operacao.responsavelAdicionalId]);
                const atual=await snapshotPreparacao(tx,preparacao,v);if(hashSnapshotContrato(atual)!==v.snapshotHash)conflito('Cadastro mudou. Salve a revisão e revise o novo documento.');
            }
            await revalidarAgendaRevisao(tx,preparacao,rc);
        }
        if(!f?.versao_vigente_id && !preparacao && !e.dados_fonte?.revisaoInicial && e.estado==='EM_ELABORACAO' && ['gerar_pdf','revisar','assinar'].includes(input.acao)) {
            await tx.query('SELECT id FROM clientes WHERE id=$1 FOR UPDATE',[v.snapshot.contratante.clienteId]);
            await tx.query('SELECT id FROM aniversariantes WHERE id=$1 FOR UPDATE',[v.snapshot.aniversariante.id]);
            const atual=(await carregarSnapshot((await buscarFechamentoPorIdParaAtualizacao(c.fechamento_id,tx))!,tx)).snapshot;
            const gravado={...v.snapshot} as typeof v.snapshot & {documental?:unknown};
            delete gravado.documental;
            if(hashSnapshotContrato(atual)!==hashSnapshotContrato(gravado)) conflito('Dados de origem mudaram. Salve a revisão para atualizar o documento antes de gerar, revisar ou assinar.');
        }
        if(input.acao==='editar_festa') {
            if(preparacao){const nova=await editarPreparacao(tx,preparacao,input,rc);return salvarElaboracao(tx,v,e,s,await snapshotPreparacao(tx,nova,v));}
            if(f?.versao_vigente_id || e.estado!=='EM_ELABORACAO' || f?.versao_em_preparacao_id!==v.id) conflito('Preparação documental anterior à revisão operacional. Cancele esta proposta e crie uma nova versão para editar a festa.');
            if(e.origem_versao_id) {
                const fonte=await fonteDaRevisaoInicial(v,await fontesEdicao(c.fechamento_id,tx),tx);
                const {proposta,snapshot}=await prepararEdicaoInicial(tx,v,e,fonte,input);
                return salvarElaboracao(tx,v,e,s,snapshot,proposta);
            }
            // Mesma ordem de lock usada pela edição CRM e pela leitura da fonte.
            await tx.query('SELECT id FROM clientes WHERE id=$1 FOR UPDATE',[v.snapshot.contratante.clienteId]);
            await tx.query('SELECT id FROM aniversariantes WHERE id=$1 FOR UPDATE',[v.snapshot.aniversariante.id]);
            const fonte=await fontesEdicao(c.fechamento_id,tx);
            if(fonte.fonteHash!==input.fonteHash) conflito('Dados de origem mudaram. Reabra a edição para não sobrescrever outra alteração.');
            const fechamento=await editarFechamentoAdministrativo(c.fechamento_id,input,s.usuario_id,context.requestId,tx);
            if(input.cliente) await atualizarClienteInterno(v.snapshot.contratante.clienteId,input.cliente,{usuarioId:s.usuario_id,origem:'CRM_INTERNO',...context},tx);
            if(input.aniversariante) {
                await atualizarAniversarianteInterno(v.snapshot.aniversariante.id,v.snapshot.contratante.clienteId,input.aniversariante,{usuarioId:s.usuario_id,origem:'CRM_INTERNO',...context},tx);
            }
            const {snapshot}=await carregarSnapshot(fechamento,tx);
            return salvarElaboracao(tx,v,e,s,{...snapshot,documental:{observacoes:e.dados_fonte.observacoesDocumentais ?? ''}} as unknown as typeof snapshot);
        }
        if (input.acao === 'assinar') {
            if (s.papel !== 'REPRESENTANTE_AUTORIZADO')
                throw authError('Somente representante autorizado pode assinar.', 403);
            const previous = (await tx.query<{
                id: string;
                documento_id: string;
                usuario_id: string;
                chave_idempotencia: string;
            }>('SELECT * FROM contrato_assinaturas WHERE contrato_versao_id=$1 AND parte=$2', [v.id, 'KIDMAIS'])).rows[0];
            if (previous) {
                if (previous.usuario_id !== s.usuario_id || previous.documento_id !== input.documentoId || previous.chave_idempotencia !== input.chaveIdempotencia)
                    conflito('Versão já assinada por outra operação.');
                return { assinaturaId: previous.id, reutilizado: true };
            }
            if (Date.now() - new Date(s.autenticado_em).getTime() > 300000)
                throw authError('Confirme sua senha novamente antes de assinar.', 403);
            if (e.estado !== 'EM_ELABORACAO' || e.documento_revisado_id !== input.documentoId || e.revisao_comercial_aprovada !== e.revisao)
                conflito('Revise e aprove o documento exato antes de assinar.');
            const d = await lerDocumento(input.documentoId, tx);
            if (d.contrato_versao_id !== v.id || d.revisao !== e.revisao || d.snapshot_hash !== v.snapshotHash)
                conflito('Documento não corresponde à revisão.');
            const identity = { schemaVersao: 1, usuarioId: s.usuario_id, nome: s.nome, cargo: s.cargo, papel: s.papel };
            const instante = (await tx.query<{
                t: string;
            }>('SELECT clock_timestamp()::text AS t')).rows[0].t;
            const proof = await guardarDocumento(tx, { versaoId: v.id, categoria: 'COMPROVANTE_ASSINATURA', revisao: e.revisao, snapshotHash: v.snapshotHash, templateCodigo: 'COMPROVANTE_INTERNO_V1', usuarioId: s.usuario_id, pdf: comprovantePdf({ versao: v, parte: 'KIDMAIS', identidade: identity, instante, pdfHash: d.pdf_hash, metodo: 'Sessão reautenticada — Kidmais Manager' }) });
            const id = randomUUID();
            await tx.query(`INSERT INTO contrato_assinaturas(id,contrato_versao_id,parte,documento_id,usuario_id,sessao_id,autenticacao_metodo,autenticado_em,identidade_snapshot,snapshot_hash,pdf_hash,metodo,provider,assinado_em,ip,user_agent,request_id,chave_idempotencia,comprovante_documento_id)
    VALUES($1,$2,'KIDMAIS',$3,$4,$5,'SENHA',$6,$7,$8,$9,'SESSAO_REAUTENTICADA','INTERNAL',$10,$11,$12,$13,$14,$15)`, [id, v.id, d.id, s.usuario_id, s.id, s.autenticado_em, identity, v.snapshotHash, d.pdf_hash, instante, context.ip, context.userAgent, context.requestId, input.chaveIdempotencia, proof.id]);
            await tx.query("UPDATE contrato_edicoes SET estado='ASSINADA_KIDMAIS',atualizado_por_usuario_id=$2 WHERE contrato_versao_id=$1", [v.id, s.usuario_id]);
            if(preparacao)await congelarPreparacao(tx,preparacao,v,d.id,rc);
            await evento(tx, v, s, 'CONTRATO_ASSINADO_KIDMAIS', { assinaturaId: id, documentoId: d.id });
            return { assinaturaId: id };
        }
        if (input.acao === 'liberar') {
            if (e.estado === 'AGUARDANDO_CLIENTE')
                return { reutilizado: true };
            if (e.estado !== 'ASSINADA_KIDMAIS')
                conflito('A assinatura Kidmais deve existir antes da liberação.');
            await tx.query("UPDATE contrato_edicoes SET estado='AGUARDANDO_CLIENTE',liberado_por_usuario_id=$2,liberado_em=clock_timestamp(),atualizado_por_usuario_id=$2 WHERE contrato_versao_id=$1", [v.id, s.usuario_id]);
            await evento(tx, v, s, 'CONTRATO_LIBERADO_CLIENTE');
            return { liberado: true };
        }
        if (e.estado !== 'EM_ELABORACAO' || f?.versao_em_preparacao_id !== v.id)
            conflito('Versão congelada. Crie outra versão para alterar conteúdo.');
        if (input.acao === 'salvar') {
            const fonte=preparacao ? await snapshotPreparacao(tx,preparacao,v) : f?.versao_vigente_id || e.origem_versao_id ? v.snapshot : (await carregarSnapshot((await buscarFechamentoPorIdParaAtualizacao(c.fechamento_id,tx))!,tx)).snapshot;
            const snapshot = { ...fonte, documental: { observacoes: input.observacoesDocumentais } };
            return salvarElaboracao(tx,v,e,s,snapshot);
        }
        if (input.acao === 'gerar_pdf') {
            const rendered = renderizarContratoOficial({ snapshot: v.snapshot, numeroVersao: v.numeroVersao, snapshotHash: v.snapshotHash });
            if (!rendered)
                conflito('Pacote sem template oficial disponível.');
            rendered.observacoes.push(e.dados_fonte.observacoesDocumentais ?? '');
            rendered.integridade.push('Assinaturas eletrônicas: consulte os comprovantes desta versão.');
            const d = await guardarDocumento(tx, { versaoId: v.id, categoria: 'CONTRATO', revisao: e.revisao, snapshotHash: v.snapshotHash, templateCodigo: rendered.modeloCodigo, templateVersao: rendered.templateVersao, usuarioId: s.usuario_id, pdf: gerarPdfContratoOficial(rendered) });
            await evento(tx, v, s, 'CONTRATO_DOCUMENTO_GERADO', { documentoId: d.id });
            return { documentoId: d.id };
        }
        const d = await lerDocumento(input.documentoId, tx);
        if (d.contrato_versao_id !== v.id || d.categoria !== 'CONTRATO' || d.revisao !== e.revisao || d.snapshot_hash !== v.snapshotHash)
            conflito('Documento não corresponde à revisão.');
        if(preparacao)await aprovarPreparacao(tx,preparacao,rc,context.requestId);
        await tx.query(`UPDATE contrato_edicoes SET documento_revisado_id=$2,revisado_por_usuario_id=$3,revisado_em=clock_timestamp(),revisao_comercial_aprovada=revisao,
   aprovado_comercial_por_usuario_id=$3,aprovado_comercial_em=clock_timestamp(),atualizado_por_usuario_id=$3 WHERE contrato_versao_id=$1`, [v.id, d.id, s.usuario_id]);
        await evento(tx, v, s, 'CONTRATO_DOCUMENTO_REVISADO', { documentoId: d.id });
        return { revisado: true };
    });
}
export async function detalheAdministrativo(contratoId: string) {
    const contrato = (await db().query('SELECT * FROM contratos WHERE id=$1', [contratoId])).rows[0];
    if (!contrato)
        conflito('Contrato não encontrado.');
    const versoes = (await db().query(`SELECT v.*,e.estado AS estado_edicao,e.revisao,e.dados_fonte,e.origem_versao_id,e.alteracoes,e.documento_revisado_id FROM contrato_versoes v LEFT JOIN contrato_edicoes e ON e.contrato_versao_id=v.id WHERE v.contrato_id=$1 ORDER BY numero_versao DESC`, [contratoId])).rows;
    const fluxo = (await db().query('SELECT * FROM contrato_fluxos WHERE contrato_id=$1', [contratoId])).rows[0] ?? null;
    const documentos = (await db().query('SELECT id,contrato_versao_id,categoria,revisao,pdf_hash,tamanho_bytes,criado_em FROM contrato_documentos WHERE contrato_versao_id IN (SELECT id FROM contrato_versoes WHERE contrato_id=$1) ORDER BY criado_em DESC', [contratoId])).rows;
    const assinaturas = (await db().query('SELECT * FROM contrato_assinaturas WHERE contrato_versao_id IN (SELECT id FROM contrato_versoes WHERE contrato_id=$1) ORDER BY assinado_em', [contratoId])).rows;
    const revisoesOperacionais=(await db().query(`SELECT r.id,r.contrato_versao_id,r.estado,r.revisao,r.data_evento::text,r.horario_inicio,r.horario_fim,r.hold_destino_adquirido_em,f.status AS status_fechamento,public.kidmais019_ocupa(f.id) AS ocupa_vigente,f.data_evento::text AS data_vigente,ROW(r.data_evento,r.horario_inicio,r.horario_fim,r.configuracao_agenda_id) IS DISTINCT FROM ROW(f.data_evento,f.horario_inicio,f.horario_fim,f.configuracao_agenda_id) AS slot_alterado FROM fechamento_revisoes r JOIN fechamentos f ON f.id=r.fechamento_id WHERE r.contrato_id=$1 ORDER BY r.criado_em`,[contratoId])).rows;
    const financeiro=(await db().query('SELECT p.id,p.contrato_versao_id,p.valor_total_contratado,p.status FROM pagamentos p JOIN contrato_versoes v ON v.id=p.contrato_versao_id WHERE v.contrato_id=$1',[contratoId])).rows;
    const pendencias=(await db().query('SELECT id,motivo,versao_nova_id FROM contrato_pendencias_financeiras WHERE contrato_id=$1',[contratoId])).rows;
    return { contrato, fluxo, versoes, documentos, assinaturas, financeiro, pendencias, revisoesOperacionais };
}
