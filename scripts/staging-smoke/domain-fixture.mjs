// In-memory repositories for tests only. No pg, sockets, SQL writes or database connection.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { domainLoader, composeIdentity, memoryTransport } from './loader.mjs';
import { marker, auditAction } from './signature.mjs';

export function fixture(root, env, smokeId) {
  const prefix = marker(smokeId), id = '00000000-0000-4000-8000-000000000001';
  const customer = { id: 'client', nomeCompleto: prefix, cpf: '11144477735', email: prefix.toLowerCase() + '@example.invalid',
    telefone: '11900000000', whatsapp: '11900000000', logradouro: 'Rua Ficticia Smoke', numero: '1', bairro: 'Bairro Ficticio', cidade: 'Cidade Ficticia', uf: 'SP', cep: '00000000' };
  const snapshot = { contratante: { ...customer, clienteId: customer.id,
    endereco: Object.fromEntries(['logradouro', 'numero', 'bairro', 'cidade', 'uf', 'cep'].map(k => [k, customer[k]])) }, fechamento: { id: 'closing' },
    aniversariante: { nome: prefix + '-ANIVERSARIANTE' }, contratacao: { observacoesEquipe: prefix }, evento: { data: '2028-07-18' } };
  const state = { validations: [], signatures: [], parties: [], audits: [], history: [], events: [], calls: [],
    contract: { id, fechamentoId: 'closing', versaoAtual: 1, status: 'AGUARDANDO_ASSINATURA' },
    version: { id: 'version', contratoId: id, numeroVersao: 1, status: 'ATIVA', snapshot, snapshotHash: '', documentoPdfHash: null },
    edition: { estado: 'AGUARDANDO_CLIENTE', documento_revisado_id: 'doc', revisao: 1, dados_fonte: {} },
    flow: { versao_em_preparacao_id: 'version', versao_vigente_id: null }, closing: { id: 'closing', status: 'AGUARDANDO_CONTRATO' } };
  let failAudit = false;
  const tx = { query: async (sql, values = []) => {
    const q = sql.replace(/\s+/g, ' ').trim(); let rows = [];
    if (q.startsWith('SELECT * FROM contrato_fluxos') || q.startsWith('SELECT versao_vigente_id FROM contrato_fluxos')) rows = [{ ...state.flow }];
    else if (q.startsWith('SELECT status FROM contratos')) rows = [{ status: state.contract.status }];
    else if (q.startsWith('INSERT INTO contrato_assinaturas')) { state.calls.push('signature-repository'); state.signatures.push({ parte: 'CLIENTE', snapshot: values[4], pdf: values[5] }); }
    else if (q.startsWith('UPDATE contrato_edicoes')) state.edition.estado = 'CONCLUIDA';
    else if (q.startsWith('UPDATE contrato_fluxos')) state.flow = { versao_vigente_id: values[1], versao_em_preparacao_id: null };
    else if (q.startsWith('UPDATE contratos')) state.contract.status = 'ASSINADO';
    else if (q.startsWith('SELECT public.kidmais019_formalizacao')) { state.calls.push('formalization-validation'); rows = [{ valida: state.signatures.length === 2 && state.version.status === 'ASSINADA' }]; }
    else if (q.startsWith('SELECT id,invalidada_em FROM public.festas')) rows = state.parties;
    else if (q.startsWith('SELECT public.kidmais019_bloquear_contrato') || q.startsWith('SELECT public.kidmais019_validar_destino')) rows = [];
    else if (q.startsWith('SELECT id,parte FROM public.contrato_assinaturas')) rows = state.signatures;
    else if (q.startsWith('INSERT INTO public.festas')) { state.calls.push('automatic-party'); state.parties.push({ id: 'party', invalidada_em: null, origem: 'AUTOMATICA_FORMALIZACAO' }); rows = [{ id: 'party' }]; }
    else if (q.startsWith('INSERT INTO public.festa_eventos')) state.events.push('FESTA_CRIADA');
    else if (q.startsWith('INSERT INTO public.auditoria')) state.audits.push({ acao: 'FESTA_CRIADA' });
    else if (q.startsWith('INSERT INTO public.eventos_historico_cliente')) state.history.push({ tipoEvento: 'FESTA_CRIADA' });
    else throw new Error('Unmocked SQL: ' + q);
    return { rows, rowCount: rows.length };
  } };
  const replacements = new Map();
  const set = (file, value) => replacements.set(resolve(root, file), value);
  const saveAudit = async input => { if (failAudit && input.acao === auditAction) throw new Error('synthetic audit failure'); state.audits.push(structuredClone(input)); };
  set('lib/db/postgres.ts', { db: () => tx, withTransaction: async work => work(tx) });
  set('lib/clientes/repositories/index.ts', {
    buscarClienteCanonicoPorCpf: async cpf => cpf === customer.cpf ? customer : null,
    buscarClienteCanonicoPorId: async cid => cid === customer.id ? customer : null,
    registrarAuditoria: saveAudit, registrarEventoHistorico: async x => state.history.push(structuredClone(x)),
  });
  set('lib/fechamentos/repositories/index.ts', {
    buscarFechamentoPorIdParaAtualizacao: async () => ({ ...state.closing }),
    marcarFechamentoContratoAssinado: async () => { state.closing.status = 'CONTRATO_ASSINADO'; return { ...state.closing }; },
  });
  set('lib/contratos/repositories/index.ts', {
    buscarContratoPorId: async () => ({ ...state.contract }),
    buscarVersaoPorId: async () => ({ ...state.version }), buscarVersaoCorrente: async () => ({ ...state.version }),
    marcarVersaoContratoAssinada: async input => { state.calls.push('mark-signed'); Object.assign(state.version, { status: 'ASSINADA', documentoPdfHash: input.documentoPdfHash, assinadoEm: new Date().toISOString() }); return { ...state.version }; },
  });
  const byHash = hash => state.validations.find(v => v.tokenProvaHash === hash);
  set('lib/identidade/repositories/index.ts', {
    buscarValidacaoPorId: async vid => state.validations.find(v => v.id === vid),
    buscarValidacaoPorTokenHash: async hash => byHash(hash),
    buscarProvaConfirmadaPorTokenHash: async hash => { const v = byHash(hash); return v?.status === 'CONFIRMADA' ? v : null; },
    criarDesafioIdentidade: async input => { state.calls.push('challenge'); const v = { ...input, id: 'validation', status: 'PENDENTE', tentativas: 0 }; state.validations.push(v); return v; },
    registrarEnvioOtp: async vid => state.validations.find(v => v.id === vid),
    confirmarValidacao: async input => { state.calls.push('confirm-code'); const v = state.validations.find(v => v.id === input.validacaoId); Object.assign(v, input, { status: 'CONFIRMADA' }); return v; },
    consumirProvaIdentidadeParaContrato: async input => { const v = byHash(input.tokenProvaHash); assert.equal(v.status, 'CONFIRMADA'); state.calls.push('consume-proof'); Object.assign(v, { status: 'CONSUMIDA', consumidoPorContratoVersaoId: input.contratoVersaoId }); return v; },
    registrarTentativaInvalida: async vid => { const v = state.validations.find(v => v.id === vid); v.tentativas++; return v; },
  });
  set('lib/contratos/services/administrativo.service.ts', { edicaoDaVersao: async () => state.edition,
    conflito: message => { throw new Error(message); }, comprovantePdf: () => Buffer.from('synthetic-proof') });
  set('lib/contratos/services/documento.service.ts', { aceiteDoTemplatePermitido: () => true });
  set('lib/contratos/storage/postgres.ts', {
    lerDocumento: async () => ({ id: 'doc', contrato_versao_id: 'version', snapshot_hash: state.version.snapshotHash, pdf_hash: 'a'.repeat(64), template_versao: 1, template_codigo: 'TEST', conteudo_pdf: Buffer.from('synthetic-doc') }),
    guardarDocumento: async () => ({ id: 'proof' }),
  });
  set('lib/fechamentos/repositories/revisao.repository.ts', { buscarRevisaoDaVersao: async () => null });
  set('lib/fechamentos/services/revisao-operacional.service.ts', {});
  set('lib/contratos/services/revisao-inicial.ts', {});
  set('lib/pagamentos/services/pendencias-financeiras.service.ts', { detectarPendenciasFinanceiras: async () => {} });
  set('lib/festas/ambiente.ts', { validarAmbienteFesta: async () => {} });
  const load = domainLoader(root, env, replacements);
  state.version.snapshotHash = load('lib/contratos/services/snapshot-core.ts').hashSnapshotContrato(snapshot);
  state.signatures.push({ parte: 'KIDMAIS', snapshot: state.version.snapshotHash, pdf: 'a'.repeat(64) });
  const transport = memoryTransport(), identity = composeIdentity(load('lib/identidade/services/index.ts'), env, transport.send);
  set('lib/identidade/services/index.ts', identity);
  const domain = { transport, identity: identity.criarIdentityServiceComAmbiente(transport.send),
    contracts: load('lib/contratos/services/contrato-publico.service.ts'), audit: saveAudit };
  const read = async () => structuredClone({ contrato_id: id, contrato_status: state.contract.status, fechamento_id: 'closing',
    cliente_id: customer.id, ...Object.fromEntries(['cpf', 'email', 'whatsapp', 'telefone', 'logradouro', 'numero', 'bairro', 'cidade', 'uf', 'cep'].map(k => [k, customer[k]])),
    nome_completo: prefix, observacoes_equipe: prefix, aniversariante: prefix + '-ANIVERSARIANTE',
    versao_id: 'version', versao_status: state.version.status, snapshot, snapshot_hash: state.version.snapshotHash,
    edicao_estado: state.edition.estado, pdf_hash: 'a'.repeat(64), versoes: 1, assinaturas: state.signatures,
    festas: state.parties.map(p => ({ id: p.id, origem: p.origem, invalidada: p.invalidada_em })),
    ocupacoes: state.parties.length, eventos: state.events.length, smoke_audits: state.audits.filter(a => a.acao === auditAction).map(a => a.dadosDepois) });
  return { state, domain, read, failAudit: () => { failAudit = true; } };
}
