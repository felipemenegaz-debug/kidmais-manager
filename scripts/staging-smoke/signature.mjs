import { resolve } from 'node:path';
import { domainLoader, composeIdentity, memoryTransport } from './loader.mjs';
import { demand } from './guards.mjs';

export const auditAction = 'STAGING_SMOKE_ASSINATURA_CLIENTE';
export const marker = id => `SMOKE-STAGING-${id}`;

export async function inspect(client, contractId) {
  const rows = (await client.query(`SELECT c.id AS contrato_id,c.status AS contrato_status,
   c.fechamento_id,fe.cliente_id,fe.observacoes_equipe,fe.data_evento::text AS data_evento,
   cl.nome_completo,cl.cpf,cl.email,cl.whatsapp,cl.telefone,cl.logradouro,cl.numero,cl.bairro,cl.cidade,cl.uf,cl.cep,
   a.nome AS aniversariante, v.id AS versao_id,v.status AS versao_status,v.snapshot,v.snapshot_hash,
   e.estado AS edicao_estado,d.pdf_hash,
   (SELECT count(*)::int FROM contrato_versoes WHERE contrato_id=c.id) AS versoes,
   (SELECT jsonb_agg(jsonb_build_object('parte',s.parte,'snapshot',s.snapshot_hash,'pdf',s.pdf_hash) ORDER BY s.parte)
    FROM contrato_assinaturas s WHERE s.contrato_versao_id=v.id) AS assinaturas,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',f.id,'origem',f.origem_criacao,'invalidada',f.invalidada_em)), '[]'::jsonb)
    FROM festas f WHERE f.contrato_id=c.id) AS festas,
   (SELECT count(*)::int FROM kidmais_ocupacoes_operacionais(fe.data_evento,fe.data_evento) o WHERE o.fechamento_id=fe.id) AS ocupacoes,
   (SELECT count(*)::int FROM festa_eventos ev JOIN festas f ON f.id=ev.festa_id WHERE f.contrato_id=c.id AND ev.tipo='FESTA_CRIADA') AS eventos,
   (SELECT COALESCE(jsonb_agg(au.dados_depois),'[]'::jsonb) FROM auditoria au
    WHERE au.entidade_id=c.id AND au.acao='STAGING_SMOKE_ASSINATURA_CLIENTE') AS smoke_audits
   FROM contratos c JOIN fechamentos fe ON fe.id=c.fechamento_id JOIN clientes cl ON cl.id=fe.cliente_id
   JOIN aniversariantes a ON a.id=fe.aniversariante_id JOIN contrato_versoes v ON v.contrato_id=c.id
   JOIN contrato_edicoes e ON e.contrato_versao_id=v.id JOIN contrato_documentos d ON d.id=e.documento_revisado_id
   WHERE c.id=$1`, [contractId])).rows;
  demand(rows.length === 1, 'UNIQUE_INITIAL_CONTRACT_REQUIRED');
  return rows[0];
}

export function validateFixture(row, smokeId) {
  const prefix = marker(smokeId), expectedEmail = `${prefix.toLowerCase()}@example.invalid`;
  demand(row.versoes === 1 && row.nome_completo === prefix && row.email === expectedEmail
    && row.whatsapp === '11900000000' && row.telefone === '11900000000'
    && row.aniversariante === `${prefix}-ANIVERSARIANTE` && row.observacoes_equipe === prefix
    && row.logradouro === 'Rua Ficticia Smoke' && row.numero === '1' && row.bairro === 'Bairro Ficticio'
    && row.cidade === 'Cidade Ficticia' && row.uf === 'SP' && row.cep === '00000000', 'SYNTHETIC_FIXTURE_REQUIRED');
  const s = row.snapshot;
  demand(s?.contratante?.clienteId === row.cliente_id && s.fechamento?.id === row.fechamento_id
    && s.contratante.nomeCompleto === prefix && s.contratante.cpf === row.cpf
    && s.contratante.email === expectedEmail && s.contratante.whatsapp === row.whatsapp
    && s.contratante.telefone === row.telefone && s.aniversariante?.nome === row.aniversariante
    && s.contratacao?.observacoesEquipe === prefix && !s.responsavelAdicional, 'SYNTHETIC_SNAPSHOT_REQUIRED');
  demand(['logradouro', 'numero', 'bairro', 'cidade', 'uf', 'cep'].every(k => s.contratante.endereco?.[k] === row[k])
    && !s.contratante.endereco?.complemento && !s.contratante.rg, 'SYNTHETIC_ADDRESS_REQUIRED');
  demand(row.assinaturas?.filter(a => a.parte === 'KIDMAIS').length === 1
    && row.assinaturas.every(a => a.snapshot === row.snapshot_hash && a.pdf === row.pdf_hash), 'KIDMAIS_SIGNATURE_REQUIRED');
  if (row.contrato_status === 'ASSINADO') {
    completed(row);
    demand(row.smoke_audits.length === 1 && row.smoke_audits[0].smokeId === smokeId
      && row.smoke_audits[0].versaoId === row.versao_id && row.smoke_audits[0].transport === 'MEMORY_ONLY'
      && row.smoke_audits[0].synthetic === true && row.smoke_audits[0].externalOtpEnabled === false, 'UNOWNED_SIGNED_CONTRACT');
    return true;
  }
  demand(row.contrato_status === 'AGUARDANDO_ASSINATURA' && row.versao_status === 'ATIVA'
    && row.edicao_estado === 'AGUARDANDO_CLIENTE' && row.assinaturas.length === 1
    && row.festas.length === 0 && row.ocupacoes === 0 && row.eventos === 0 && row.smoke_audits.length === 0, 'INITIAL_FLOW_REQUIRED');
  return false;
}

export function completed(row) {
  demand(row.contrato_status === 'ASSINADO' && row.versao_status === 'ASSINADA'
    && row.edicao_estado === 'CONCLUIDA' && row.assinaturas.length === 2
    && row.assinaturas.filter(a => a.parte === 'CLIENTE').length === 1
    && row.festas.length === 1 && row.festas[0].origem === 'AUTOMATICA_FORMALIZACAO'
    && row.festas[0].invalidada === null && row.ocupacoes === 1 && row.eventos === 1, 'FORMALIZATION_POSTCHECK_FAILED');
}

export function createDomain(root, env, client) {
  let savepoint = 0;
  const db = { db: () => client, withTransaction: async work => {
    const name = `smoke_${++savepoint}`;
    await client.query(`SAVEPOINT ${name}`);
    try { const value = await work(client); await client.query(`RELEASE SAVEPOINT ${name}`); return value; }
    catch (error) { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); throw error; }
  } };
  const replacements = new Map([[resolve(root, 'lib/db/postgres.ts'), db]]);
  const load = domainLoader(root, env, replacements), transport = memoryTransport();
  const real = load('lib/identidade/services/index.ts');
  const identity = composeIdentity(real, env, transport.send);
  replacements.set(resolve(root, 'lib/identidade/services/index.ts'), identity);
  return { transport, identity: identity.criarIdentityServiceComAmbiente(transport.send),
    contracts: load('lib/contratos/services/contrato-publico.service.ts'),
    validateSchema: () => load('lib/festas/ambiente.ts').validarAmbienteFesta(client),
    audit: input => load('lib/clientes/repositories/auditoria.repository.ts').registrarAuditoria(input, client) };
}

/** Called only inside the CLI's outer transaction. Never returns OTP/access/proof tokens. */
export async function sign(domain, row, smokeId, commit, readState) {
  if (validateFixture(row, smokeId)) return summary(row, true);
  const { contracts, identity, transport } = domain;
  try {
    const challenge = await contracts.iniciarDesafioContrato({ contratoId: row.contrato_id, cpf: row.cpf, canal: 'WHATSAPP' }, transport.send);
    const proof = await identity.confirmarCodigo({ validacaoId: challenge.validacaoId, codigo: transport.take(challenge.validacaoId) });
    const input = { contratoId: row.contrato_id, versaoId: row.versao_id, snapshotHash: row.snapshot_hash,
      documentoPdfHash: row.pdf_hash, acessoToken: challenge.acessoToken, provaToken: proof.provaToken };
    const context = { requestId: smokeId, userAgent: 'STAGING_SMOKE_CLI_MEMORY_OTP', ip: null };
    await contracts.assinarContratoPublico(input, transport.send, context);
    const first = await readState(); completed(first);
    const replay = await contracts.assinarContratoPublico(input, transport.send, context);
    const second = await readState(); completed(second);
    demand(replay.reutilizado === true && JSON.stringify(first) === JSON.stringify(second)
      && second.snapshot_hash === row.snapshot_hash && second.pdf_hash === row.pdf_hash, 'FORMALIZATION_NOT_IDEMPOTENT');
    await domain.audit({ clienteId: row.cliente_id, atorTipo: 'SISTEMA', acao: auditAction,
      entidadeTipo: 'CONTRATO', entidadeId: row.contrato_id, origem: 'STAGING_SMOKE_CLI', requestId: smokeId,
      userAgent: context.userAgent, justificativa: 'Assinatura sintetica de homologacao; sem envio externo ou aceite de pessoa real.',
      dadosDepois: { smokeId, versaoId: row.versao_id, commit, transport: 'MEMORY_ONLY',
        synthetic: true, externalOtpEnabled: false, signatures: 2, festas: 1, ocupacoes: 1 } });
    const final = await readState(); demand(validateFixture(final, smokeId), 'AUDIT_POSTCHECK_FAILED');
    return summary(final, false);
  } finally { transport.clear(); }
}

function summary(row, reused) {
  return { ok: true, reutilizado: reused, contratoId: row.contrato_id, versaoId: row.versao_id,
    festaId: row.festas[0].id, assinaturas: 2, festas: 1, ocupacoes: 1, transport: 'MEMORY_ONLY' };
}
