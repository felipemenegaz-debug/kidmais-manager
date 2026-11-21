import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DbExecutor } from '../../db/contracts';
import { withTransaction } from '../../db/postgres';
import { consultarSessao } from '../../autenticacao/service';
import { registrarAuditoria, registrarEventoHistorico } from '../../clientes/repositories';
import { marcarFechamentoContratoAssinado } from '../../fechamentos/repositories';
import { travarConfiguracaoAgenda } from '../../agenda/trava-configuracao';
import { garantirFestaFormalizada } from '../../festas/formalizacao';
import { validarAmbienteFesta } from '../../festas/ambiente';
import { FestaError } from '../../festas/domain';
import { buscarVersaoPorId, type ContratoVersaoRecord } from '../repositories';
import { lerDocumento } from '../storage/postgres';
import { ACEITE_PAPEL_CLIENTE } from '../assinatura-papel';
import { contratoDoTenant, edicaoDaVersao, versaoDoTenant } from './administrativo.service';
import { ContratoServiceError } from './errors';
import { promoverVigencia } from './fluxo-publico';
import { hashSnapshotContrato } from './snapshot-core';
import { papelClienteInstalado } from '../papel-cliente-instalado';

/**
 * 124 — Contrato nativo em que o CLIENTE assinou o papel (plano r3 + r3.1). A Gestão da empresa registra a data civil
 * declarada e, opcionalmente, a cópia digitalizada. Uma transação, na ordem de travas do painel:
 * sessão/tenant → configuração da agenda → fechamento → contrato → fluxo → versão (FOR UPDATE).
 * O banco confere de novo no COMMIT (gatilho diferido da 124): este serviço não é a única guarda.
 */
export const GESTAO = 'REPRESENTANTE_AUTORIZADO';
export const TAMANHO_MAXIMO_ARQUIVO = 26214400;
export const TIPOS_ARQUIVO = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type TipoArquivoPapel = (typeof TIPOS_ARQUIVO)[number];

export const registroPapelSchema = z.object({
  dataDeclarada: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, 'Data inválida.'),
  observacao: z.string().max(500).optional().nullable().transform((o) => (o == null || o.trim() === '' ? null : o)),
  chaveIdempotencia: z.string().uuid(),
}).strict();

export type ArquivoPapel = { bytes: Buffer; tipo: string };

const erro = (code: ConstructorParameters<typeof ContratoServiceError>[0], message: string, status = 409, details?: Record<string, unknown>) =>
  new ContratoServiceError(code, message, status, details);

/** Assinatura mágica do conteúdo: o tipo declarado precisa bater com os bytes. */
export function tipoPeloConteudo(b: Buffer): TipoArquivoPapel | null {
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

/** Tamanho e sha256 calculados no servidor; nada vem do cliente além dos bytes e do tipo declarado. */
export function validarArquivoPapel(a: ArquivoPapel | null) {
  if (!a) return null;
  if (!(TIPOS_ARQUIVO as readonly string[]).includes(a.tipo)) throw erro('ARQUIVO_PAPEL_INVALIDO', 'Envie PDF, JPEG ou PNG.', 422);
  if (a.bytes.length < 1 || a.bytes.length > TAMANHO_MAXIMO_ARQUIVO) throw erro('ARQUIVO_PAPEL_INVALIDO', 'O arquivo precisa ter até 25 MB.', 422);
  if (tipoPeloConteudo(a.bytes) !== a.tipo) throw erro('ARQUIVO_PAPEL_INVALIDO', 'O conteúdo do arquivo não corresponde ao tipo informado.', 422);
  return { bytes: a.bytes, tipo: a.tipo as TipoArquivoPapel, tamanho: a.bytes.length, sha256: createHash('sha256').update(a.bytes).digest('hex') };
}

/** Payload canônico da idempotência: versão, data, observação e sha do arquivo (ou null). */
export function payloadHashPapel(versaoId: string, dataDeclarada: string, observacao: string | null, arquivoSha: string | null) {
  return createHash('sha256').update(JSON.stringify([versaoId, dataDeclarada, observacao, arquivoSha])).digest('hex');
}

type LinhaPapel = { id: string; contrato_versao_id: string; payload_hash: string; data_declarada: string; registrado_em: string };

export async function registrarAssinaturaPapelCliente(
  versaoId: string,
  entrada: z.input<typeof registroPapelSchema>,
  arquivoBruto: ArquivoPapel | null,
  token: string,
  context: { requestId: string; ip: string | null; userAgent: string | null },
  empresaSolicitada?: string | null,
) {
  const input = registroPapelSchema.parse(entrada);
  const arquivo = validarArquivoPapel(arquivoBruto);
  const payloadHash = payloadHashPapel(versaoId, input.dataDeclarada, input.observacao, arquivo?.sha256 ?? null);
  try {
    return await withTransaction(async (tx) => {
      const s = await consultarSessao(token, tx, true);
      // Versão de outra empresa (ou inexistente): 404, como o GET da cópia (PAP-5), sem revelar se existe.
      const { contrato: c, empresaAutorizada, tenant } = await contratoDoTenant(tx, s, versaoId, empresaSolicitada).catch((falha: unknown) => {
        throw falha instanceof ContratoServiceError && falha.message === 'Versão não encontrada.' ? erro('CONTRATO_NAO_ENCONTRADO', 'Versão não encontrada.', 404) : falha;
      });
      if (tenant.papelAtual !== GESTAO) throw erro('PAPEL_NAO_AUTORIZADO', 'Somente a Gestão desta empresa registra a assinatura em papel.', 403);
      // Base sem a 124: recusa clara (nada é escrito), em vez de 42P01 na idempotência.
      if (!await papelClienteInstalado(tx)) throw erro('ASSINATURA_PAPEL_INDISPONIVEL', 'O registro da assinatura em papel ainda não está disponível.', 409);
      await travarConfiguracaoAgenda(tx, empresaAutorizada, { modo: 'COMPARTILHADA', linha: 'JA_TRAVADA' });
      const fechamento = (await tx.query<{ id: string; status: string }>(
        'SELECT id::text,status FROM fechamentos WHERE id=$1 AND empresa_id=$2 FOR UPDATE', [c.fechamento_id, empresaAutorizada])).rows[0];
      if (!fechamento) throw erro('CONTRATO_NAO_ENCONTRADO', 'Versão não encontrada.', 404);
      const travado = (await tx.query<{ fechamento_id: string; status: string }>('SELECT fechamento_id,status FROM contratos WHERE id=$1 FOR UPDATE', [c.id])).rows[0];
      if (!travado || travado.fechamento_id !== c.fechamento_id) throw erro('CONTRATO_NAO_ENCONTRADO', 'Versão não encontrada.', 404);
      const fluxo = (await tx.query<{ versao_vigente_id: string | null; versao_em_preparacao_id: string | null }>(
        'SELECT versao_vigente_id,versao_em_preparacao_id FROM contrato_fluxos WHERE contrato_id=$1 FOR UPDATE', [c.id])).rows[0];
      const v = await buscarVersaoPorId(versaoId, tx, { forUpdate: true });
      if (!v || v.contratoId !== c.id) throw erro('CONTRATO_NAO_ENCONTRADO', 'Versão não encontrada.', 404);

      // Idempotência relida SOB as travas (a mesma chave na mesma empresa).
      const anterior = (await tx.query<LinhaPapel>(
        `SELECT id::text,contrato_versao_id::text,payload_hash,data_declarada::text,registrado_em::text
           FROM contrato_assinaturas_papel WHERE empresa_id=$1 AND chave_idempotencia=$2`, [empresaAutorizada, input.chaveIdempotencia])).rows[0];
      if (anterior) {
        if (anterior.payload_hash !== payloadHash || anterior.contrato_versao_id !== v.id)
          throw erro('CHAVE_IDEMPOTENCIA_REUTILIZADA', 'Esta chave já foi usada com outros dados.');
        return { reutilizado: true, assinaturaPapelId: anterior.id, dataDeclarada: anterior.data_declarada, registradoEm: anterior.registrado_em, contratoId: c.id, versaoId: v.id };
      }
      if (v.status === 'ASSINADA' || travado.status === 'ASSINADO') throw erro('CONTRATO_JA_ASSINADO', 'Este Contrato já foi assinado.');

      // Estado exigido: V1 inicial nativa, assinada pelo buffet, liberada ao cliente e sem assinatura do cliente.
      if (travado.status === 'CANCELADO') throw erro('STATUS_CONTRATO_NAO_PERMITE_ASSINATURA', 'Contratação cancelada.');
      if (v.numeroVersao !== 1 || v.status !== 'ATIVA' || fluxo?.versao_em_preparacao_id !== v.id || fluxo?.versao_vigente_id)
        throw erro('STATUS_CONTRATO_NAO_PERMITE_ASSINATURA', 'Só a primeira versão do contrato, aguardando o cliente, aceita a assinatura em papel.');
      if (hashSnapshotContrato(v.snapshot) !== v.snapshotHash) throw erro('DADOS_CONTRATUAIS_INCONSISTENTES', 'O snapshot da versão não corresponde ao hash preservado.');
      const e = await edicaoDaVersao(v.id, tx);
      if (!e || e.estado !== 'AGUARDANDO_CLIENTE' || e.tipo !== 'INICIAL' || e.origem_versao_id || !e.documento_revisado_id
          || (e.dados_fonte as { revisaoInicial?: unknown }).revisaoInicial)
        throw erro('STATUS_CONTRATO_NAO_PERMITE_ASSINATURA', 'A versão precisa estar assinada pelo buffet e liberada ao cliente, sem revisão pendente.');
      const impedimentos = (await tx.query<{ importada: boolean; revisao: boolean; kidmais: boolean; cliente: boolean; liberado: string | null }>(
        `SELECT EXISTS(SELECT 1 FROM contrato_importacoes i WHERE i.contrato_id=$1) AS importada,
                EXISTS(SELECT 1 FROM fechamento_revisoes r WHERE r.contrato_versao_id=$2 OR r.versao_base_id=$2) AS revisao,
                EXISTS(SELECT 1 FROM contrato_assinaturas a WHERE a.contrato_versao_id=$2 AND a.parte='KIDMAIS') AS kidmais,
                EXISTS(SELECT 1 FROM contrato_assinaturas a WHERE a.contrato_versao_id=$2 AND a.parte='CLIENTE') AS cliente,
                (SELECT (liberado_em AT TIME ZONE 'America/Sao_Paulo')::date::text FROM contrato_edicoes WHERE contrato_versao_id=$2) AS liberado`,
        [c.id, v.id])).rows[0];
      if (impedimentos.importada || impedimentos.revisao || !impedimentos.kidmais || impedimentos.cliente || !impedimentos.liberado)
        throw erro('STATUS_CONTRATO_NAO_PERMITE_ASSINATURA', 'A versão precisa estar assinada só pelo buffet, sem importação nem revisão.');
      if (fechamento.status !== 'AGUARDANDO_CONTRATO')
        throw erro('STATUS_FECHAMENTO_NAO_PERMITE_CONTRATO', 'O estado atual do Fechamento não permite concluir a assinatura do Contrato.', 409, { statusAtual: fechamento.status });
      // Piso civil (data da liberação, SP). O teto ("hoje" SP) é o do INSERT, pelo relógio do banco.
      if (input.dataDeclarada < impedimentos.liberado)
        throw erro('DATA_DECLARADA_INVALIDA', 'A data da assinatura não pode ser anterior à liberação do contrato ao cliente.', 422);
      const d = await lerDocumento(e.documento_revisado_id, tx);
      if (d.contrato_versao_id !== v.id || d.snapshot_hash !== v.snapshotHash) throw erro('DOCUMENTO_CONTRATO_DIVERGENTE', 'Documento ou snapshot divergente.');

      await validarAmbienteFesta(tx);
      const papel = (await tx.query<LinhaPapel>(
        `INSERT INTO contrato_assinaturas_papel(empresa_id,contrato_id,contrato_versao_id,data_declarada,registrado_por_usuario_id,membership_id,
           observacao,arquivo,arquivo_tipo,arquivo_tamanho,arquivo_sha256,chave_idempotencia,payload_hash)
         VALUES($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id::text,contrato_versao_id::text,payload_hash,data_declarada::text,registrado_em::text`,
        [empresaAutorizada, c.id, v.id, input.dataDeclarada, s.usuario_id, tenant.membershipId, input.observacao,
          arquivo?.bytes ?? null, arquivo?.tipo ?? null, arquivo?.tamanho ?? null, arquivo?.sha256 ?? null, input.chaveIdempotencia, payloadHash])).rows[0];
      // UPDATE próprio (r3.1, PAP-R3-1): template e hash do documento revisado, instante civil (meio-dia SP da data).
      const atualizada = (await tx.query<{ id: string }>(
        `UPDATE contrato_versoes SET status='ASSINADA',aceite_metodo='PAPEL_CLIENTE',assinado_em=public.kidmais124_instante_civil($2::date),
                documento_template_versao=$3,documento_pdf_hash=$4
          WHERE id=$1 AND status='ATIVA' RETURNING id`, [v.id, input.dataDeclarada, d.template_versao, d.pdf_hash])).rows[0];
      if (!atualizada) throw erro('STATUS_CONTRATO_NAO_PERMITE_ASSINATURA', 'A versão contratual não pôde ser marcada como assinada.');
      const versaoAssinada = (await buscarVersaoPorId(v.id, tx)) as ContratoVersaoRecord;
      await promoverVigencia(tx, versaoAssinada, fluxo?.versao_vigente_id ?? null, s.usuario_id);
      const fechamentoAssinado = await marcarFechamentoContratoAssinado(fechamento.id, tx);
      if (!fechamentoAssinado) throw erro('STATUS_FECHAMENTO_NAO_PERMITE_CONTRATO', 'O Fechamento não pôde avançar para CONTRATO_ASSINADO.');
      try {
        await garantirFestaFormalizada(tx, c.id, v.id, { requestId: context.requestId, userAgent: context.userAgent }, 'CRIAR');
      } catch (falha) {
        throw agendaRecusada(falha);
      }
      const clienteId = v.snapshot.contratante.clienteId;
      const metadata = {
        contratoId: c.id, contratoVersaoId: v.id, numeroVersao: v.numeroVersao, assinaturaPapelId: papel.id, dataDeclarada: papel.data_declarada,
        registradoEm: papel.registrado_em, registradoPorUsuarioId: s.usuario_id, metodo: ACEITE_PAPEL_CLIENTE, comArquivo: Boolean(arquivo),
        documentoPdfHash: d.pdf_hash, documentoTemplateVersao: d.template_versao,
      };
      await registrarEventoHistorico({
        clienteId, tipoEvento: 'CONTRATO_ASSINADO_PAPEL_CLIENTE', origem: 'CONTRATO_ADMIN', entidadeTipo: 'CONTRATO', entidadeId: c.id,
        detalhe: `Contrato V${v.numeroVersao} assinado pelo cliente em papel em ${dataBr(papel.data_declarada)}; registro de ${s.nome ?? 'Gestão'}.`,
        metadata, critico: true,
      }, tx);
      await registrarAuditoria({
        clienteId, atorTipo: 'USUARIO', usuarioId: s.usuario_id, acao: 'CONTRATO_ASSINADO_PAPEL_CLIENTE', entidadeTipo: 'CONTRATO_VERSAO', entidadeId: v.id,
        dadosAntes: { contratoStatus: travado.status, versaoStatus: v.status, fechamentoStatus: fechamento.status },
        dadosDepois: { ...metadata, contratoStatus: 'ASSINADO', versaoStatus: 'ASSINADA', fechamentoStatus: fechamentoAssinado.status, empresaId: empresaAutorizada },
        origem: 'CONTRATO_ADMIN', requestId: context.requestId, ip: context.ip, userAgent: context.userAgent,
      }, tx);
      return { reutilizado: false, assinaturaPapelId: papel.id, dataDeclarada: papel.data_declarada, registradoEm: papel.registrado_em, contratoId: c.id, versaoId: v.id };
    });
  } catch (falha) {
    throw traduzirFalhaBanco(falha);
  }
}

function dataBr(d: string) { const [a, m, dia] = d.split('-'); return `${dia}/${m}/${a}`; }

/** Agenda recusada na formalização (conflito, bloqueio, salão inativo): 409 com o motivo; o rollback é integral. */
function agendaRecusada(falha: unknown) {
  if (falha instanceof ContratoServiceError) return falha;
  const msg = falha instanceof Error ? falha.message : String(falha);
  const pg = (falha as { code?: string })?.code;
  if (falha instanceof FestaError || pg === '23514' || pg === 'P0001')
    return erro('FORMALIZACAO_AGENDA_RECUSADA', `A agenda recusou a formalização: ${msg}`, 409);
  return falha;
}

/** Recusas do banco (BEFORE INSERT/COMMIT da 124) viram respostas legíveis; o resto segue intacto. */
function traduzirFalhaBanco(falha: unknown) {
  const msg = falha instanceof Error ? falha.message : '';
  if (/^124: data declarada no futuro/.test(msg)) return erro('DATA_DECLARADA_INVALIDA', 'A data da assinatura não pode ser futura.', 422);
  if (/^124: registro exige a Gestão ativa/.test(msg)) return erro('PAPEL_NAO_AUTORIZADO', 'Somente a Gestão desta empresa registra a assinatura em papel.', 403);
  if ((falha as { code?: string })?.code === '23505' && /contrato_assinaturas_papel_(versao|chave)_uk/.test(String((falha as { constraint?: string }).constraint ?? msg)))
    return erro('CONTRATO_JA_ASSINADO', 'Este Contrato já foi assinado.');
  return falha;
}

/** Leitura administrativa (Gestão): metadados do registro e, se pedido, os bytes da cópia. Outra empresa = 404. */
export async function lerAssinaturaPapelAdmin(versaoId: string, token: string, empresaSolicitada: string | null, comArquivo: boolean) {
  return withTransaction(async (tx) => {
    const s = await consultarSessao(token, tx, false);
    const { tenant } = await contratoDoTenant(tx, s, versaoId, empresaSolicitada).catch(() => { throw naoEncontrada(); });
    if (tenant.papelAtual !== GESTAO) throw erro('PAPEL_NAO_AUTORIZADO', 'Somente a Gestão desta empresa vê a assinatura em papel.', 403);
    await versaoDoTenant(tx, versaoId, tenant.empresaComprovada).catch(() => { throw naoEncontrada(); });
    return lerRegistroPapel(tx, versaoId, tenant.empresaComprovada, comArquivo);
  });
}

const naoEncontrada = () => erro('ASSINATURA_PAPEL_NAO_ENCONTRADA', 'Assinatura em papel não encontrada.', 404);

export async function lerRegistroPapel(tx: DbExecutor, versaoId: string, empresaId: string, comArquivo: boolean) {
  if (!await papelClienteInstalado(tx)) throw naoEncontrada();
  const r = (await tx.query<{
    id: string; data_declarada: string; registrado_em: string; registrado_por: string | null; observacao: string | null;
    arquivo_tipo: string | null; arquivo_tamanho: number | null; arquivo_sha256: string | null; arquivo: Buffer | null;
  }>(
    `SELECT p.id::text,p.data_declarada::text,p.registrado_em::text,u.nome AS registrado_por,p.observacao,p.arquivo_tipo,p.arquivo_tamanho,p.arquivo_sha256,
            ${comArquivo ? 'p.arquivo' : 'NULL::bytea AS arquivo'}
       FROM contrato_assinaturas_papel p LEFT JOIN usuarios_administrativos u ON u.id=p.registrado_por_usuario_id
      WHERE p.contrato_versao_id=$1 AND p.empresa_id=$2`, [versaoId, empresaId])).rows[0];
  if (!r) throw naoEncontrada();
  return {
    id: r.id, dataDeclarada: r.data_declarada, registradoEm: r.registrado_em, registradoPor: r.registrado_por, observacao: r.observacao,
    temArquivo: r.arquivo_tipo !== null, tipo: r.arquivo_tipo, tamanho: r.arquivo_tamanho, sha256: r.arquivo_sha256,
    ...(comArquivo ? { arquivo: r.arquivo } : {}),
  };
}

/**
 * Painel administrativo: registros em papel do contrato na empresa comprovada. Qualquer papel do painel vê a data
 * declarada (é o estado do contrato); observação, autor, instante do registro e metadados da cópia só para a Gestão
 * (D-PAPEL-6). Nunca os bytes: a cópia sai só pela rota `.../assinatura-papel/arquivo`.
 */
export async function assinaturasPapelDoPainel(tx: DbExecutor, contratoId: string, empresaId: string, papelAtual: string | null) {
  const gestao = papelAtual === GESTAO;
  // Base sem a 124: nada a mostrar e nada a registrar (a tabela não existe; ver papel-cliente-instalado.ts).
  if (!await papelClienteInstalado(tx)) return { podeRegistrar: false, registros: [] };
  const linhas = (await tx.query<{
    versao_id: string; data_declarada: string; registrado_em: string; registrado_por: string | null; observacao: string | null;
    arquivo_tipo: string | null; arquivo_tamanho: number | null; arquivo_sha256: string | null;
  }>(
    `SELECT p.contrato_versao_id::text AS versao_id,p.data_declarada::text,p.registrado_em::text,u.nome AS registrado_por,p.observacao,
            p.arquivo_tipo,p.arquivo_tamanho,p.arquivo_sha256
       FROM contrato_assinaturas_papel p LEFT JOIN usuarios_administrativos u ON u.id=p.registrado_por_usuario_id
      WHERE p.contrato_id=$1 AND p.empresa_id=$2`, [contratoId, empresaId])).rows;
  return {
    podeRegistrar: gestao,
    registros: linhas.map((r) => gestao
      ? { versaoId: r.versao_id, dataDeclarada: r.data_declarada, registradoEm: r.registrado_em, registradoPor: r.registrado_por, observacao: r.observacao,
          temArquivo: r.arquivo_tipo !== null, tipo: r.arquivo_tipo, tamanho: r.arquivo_tamanho, sha256: r.arquivo_sha256 }
      : { versaoId: r.versao_id, dataDeclarada: r.data_declarada }),
  };
}

/** Resumo da Contratação (tela e PDF): só versão e data civil declarada, para o contrato já provado no tenant. */
export async function datasPapelClienteDoContrato(tx: DbExecutor, contratoId: string) {
  if (!await papelClienteInstalado(tx)) return [];
  return (await tx.query<{ versaoId: string; dataDeclarada: string }>(
    'SELECT contrato_versao_id::text AS "versaoId",data_declarada::text AS "dataDeclarada" FROM contrato_assinaturas_papel WHERE contrato_id=$1', [contratoId])).rows;
}

// DTO público (link do cliente): `assinaturaPapelClientePublica` em contrato-publico.service.ts — SÓ a data.
