import {escolhasBuffet} from './buffet';
import {z} from 'zod';
import {capacidades} from './domain';
const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const motivo=z.string().trim().min(3).max(4000);
const motivoOpcional=z.string().trim().max(4000).default('');
const contexto={chave:uuid,revisao:z.number().int().positive(),versaoId:uuid};
const prioridade=z.enum(['NORMAL','ATENCAO','CRITICA']);
const responsabilidade={areaId:uuid.nullable(),responsavelId:uuid.nullable(),prazo:z.iso.datetime({offset:true}).nullable()};
export const criarSchema=z.object({contratoId:uuid,versaoId:uuid,chave:uuid}).strict();
export const capacidadeSchema=z.object({usuarioId:uuid,capacidade:z.enum(capacidades),conceder:z.boolean(),motivo,confirmarAutoconcessao:z.boolean().default(false)}).strict();
export const areaSchema=z.object({id:uuid.optional(),nome:z.string().trim().min(1).max(100),ativo:z.boolean(),motivo}).strict();
const camposEscolhas=Object.fromEntries(escolhasBuffet.map(k=>[k,z.string().trim().max(2000).nullable().optional()])) as Record<typeof escolhasBuffet[number],z.ZodOptional<z.ZodNullable<z.ZodString>>>;
export const comandoSchema=z.discriminatedUnion('acao',[
 z.object({...contexto,acao:z.literal('invalidar'),motivo}).strict(),
 z.object({...contexto,acao:z.literal('cancelar_contratacao'),motivo}).strict(),
 z.object({...contexto,acao:z.literal('tarefa'),id:uuid.optional(),titulo:z.string().trim().min(1).max(300),descricao:z.string().max(4000),categoria:z.enum(['ANTES','DEPOIS']).default('ANTES'),prioridade,estado:z.enum(['PENDENTE','CONCLUIDA','NAO_SE_APLICA']),...responsabilidade,motivo:motivoOpcional}).strict(),
 z.object({...contexto,acao:z.literal('pendencia'),id:uuid.optional(),natureza:z.enum(['CLIENTE','OPERACIONAL']),descricao:z.string().trim().min(1).max(4000),categoria:z.enum(['ANTES','DEPOIS']).default('ANTES'),prioridade,estado:z.enum(['ABERTA','EM_TRATAMENTO','RESOLVIDA','NAO_SE_APLICA']),...responsabilidade,motivo:motivoOpcional}).strict(),
 z.object({...contexto,acao:z.literal('observacao'),descricao:z.string().trim().min(1).max(4000),motivo:motivoOpcional}).strict(),
 z.object({...contexto,acao:z.literal('buffet'),escolhas:z.object(camposEscolhas).strict(),motivo:motivoOpcional}).strict(),
 z.object({...contexto,acao:z.literal('contagem'),total:z.number().int().nonnegative().max(100000),observadoEm:z.iso.datetime({offset:true}),corrigeId:uuid.optional(),motivo:motivoOpcional}).strict(),
 z.object({...contexto,acao:z.literal('solicitacao'),tipo:z.enum(['HORA_EXTRA','ADICIONAL','ALTERACAO_OPERACIONAL','ALTERACAO_CONTRATUAL']),descricao:z.string().trim().min(1).max(4000),conteudoSolicitado:z.record(z.string(),z.json()).default({}),necessitaContrato:z.boolean(),necessitaFinanceiro:z.boolean(),motivo:motivoOpcional}).strict().superRefine((i,ctx)=>{const c=i.conteudoSolicitado;if(i.tipo==='HORA_EXTRA'&&!(typeof c.minutos==='number'&&Number.isInteger(c.minutos)&&c.minutos>0))ctx.addIssue({code:'custom',path:['conteudoSolicitado','minutos'],message:'Informe minutos inteiros positivos.'});if(i.tipo==='ADICIONAL'&&!(typeof c.item==='string'&&c.item.trim().length>0&&typeof c.quantidade==='number'&&Number.isFinite(c.quantidade)&&c.quantidade>0))ctx.addIssue({code:'custom',path:['conteudoSolicitado'],message:'Informe item e quantidade positiva.'});}),
 z.object({...contexto,acao:z.literal('cancelar_solicitacao'),id:uuid,motivo}).strict(),
 z.object({...contexto,acao:z.literal('encaminhar_solicitacao'),id:uuid,versaoDestinoId:uuid.nullable(),pendenciaFinanceiraId:uuid.nullable(),motivo}).strict(),
]);
export type Comando=z.infer<typeof comandoSchema>;
