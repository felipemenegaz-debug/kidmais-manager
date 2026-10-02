import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carregarComponente } from '../../../components/admin/teste-componente.ts';
import * as core from './core.ts';
import type { Conversa } from './service.ts';

// Banco simulado: nenhum PostgreSQL real, modelo ou provedor é acessado.
const agora = new Date();
const base: Conversa = { id: 'c', empresa_id: 'e', ambiente: 'staging', contato: '5561999999999', estado: 'IA', responsavel_id: null, nao_contatar: false, versao: 1, ultima_entrada_em: agora.toISOString(), interesse: { data: null, convidados: null } };
const entrada = (texto: string | null, id = 'evento-1') => ({ id, app: 'KidmaisManager', source: '5561999999999', texto, timestamp: agora.getTime() });
type Opcoes = { permitido?: boolean; ativo?: boolean; config?: unknown; conversa?: Partial<Conversa>; duplicada?: boolean; enviando?: boolean; papel?: string; empresaAtiva?: boolean };
function carregar(op: Opcoes = {}) {
  const comandos: { sql: string; args: unknown[] }[] = [];
  const conversa = { ...base, ...op.conversa };
  const query = async (sql: string, args: unknown[] = []) => {
    comandos.push({ sql, args });
    if (sql.includes('FROM empresas')) return { rows: op.empresaAtiva === false ? [] : [{ id: 'e' }] };
    if (sql.includes('SELECT configuracao')) return { rows: [{ configuracao: op.config ?? { ativo: true, nome: 'Kidmais', perguntas: [] } }] };
    if (sql.includes('AND externa_id=$3')) return { rows: op.duplicada ? [{ id: 'm' }] : [] };
    if (sql.includes('INSERT INTO whatsapp_atendimento_conversas')) return { rows: [conversa] };
    if (sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return { rows: [conversa] };
    if (sql.includes("estado='ENVIANDO'")) return { rows: op.enviando ? [{ id: 'x' }] : [] };
    return { rows: [] };
  };
  const tenants: string[] = [];
  const modulo = carregarComponente('lib/whatsapp/atendimento/service.ts', {
    '../../db/postgres.ts': { db: () => ({ query }), withTransaction: async (fn: (tx: unknown) => unknown) => fn({ query }) },
    '../../saas/provar-tenant.ts': { withTenantTransaction: async (_s: unknown, empresa: string, fn: (tx: unknown, t: unknown) => unknown) => { tenants.push(empresa); return fn({ query }, { empresaComprovada: empresa, papelAtual: op.papel ?? 'ADMINISTRATIVO' }); } },
    './configuracao.ts': { ambienteAtendimento: () => 'staging', empresaPiloto: () => 'e', atendimentoAtivo: () => op.ativo ?? true, contatoPermitido: () => op.permitido ?? true, recepcaoAtiva: () => true, receptorDoNumero: () => true },
    './core.ts': core,
  }).modulo as typeof import('./service.ts');
  const sqls = (trecho: string) => comandos.filter(c => c.sql.includes(trecho));
  return { modulo, comandos, sqls, tenants };
}
const sessao = { usuario_id: 'u' } as never;

test('evento repetido não grava nova mensagem nem altera conversa', async () => {
  const { modulo, sqls } = carregar({ duplicada: true });
  await modulo.receberEntrada(entrada('Olá'));
  assert.equal(sqls('INSERT INTO whatsapp_atendimento_mensagens').length, 0);
  assert.equal(sqls('INSERT INTO whatsapp_atendimento_conversas').length, 0);
});
test('automação desligada guarda a mensagem como recebida e encaminha para a equipe', async () => {
  const { modulo, sqls } = carregar({ ativo: false });
  await modulo.receberEntrada(entrada('Quero uma festa'));
  assert.equal(sqls('INSERT INTO whatsapp_atendimento_mensagens')[0].args[5], 'PROCESSADA');
  assert.equal(sqls("SET estado='AGUARDANDO_HUMANO'").length, 1);
});
test('PARAR encerra e bloqueia novos envios sem consultar modelo', async () => {
  const { modulo, sqls } = carregar();
  await modulo.receberEntrada(entrada('PARAR'));
  assert.equal(sqls('nao_contatar=true').length, 1);
});
test('conversa encerrada pela equipe reabre com nova mensagem; opt-out continua bloqueado', async () => {
  const reaberta = carregar({ conversa: { estado: 'ENCERRADA', responsavel_id: 'u' } });
  await reaberta.modulo.receberEntrada(entrada('Oi de novo'));
  assert.equal(reaberta.sqls('INSERT INTO whatsapp_atendimento_mensagens')[0].args[5], 'PENDENTE');
  assert.deepEqual(reaberta.sqls('responsavel_id=NULL')[0].args, ['c', 'IA']);
  const desligada = carregar({ ativo: false, conversa: { estado: 'ENCERRADA' } });
  await desligada.modulo.receberEntrada(entrada('Oi de novo'));
  assert.deepEqual(desligada.sqls('responsavel_id=NULL')[0].args, ['c', 'AGUARDANDO_HUMANO']);
  const optOut = carregar({ conversa: { estado: 'ENCERRADA', nao_contatar: true } });
  await optOut.modulo.receberEntrada(entrada('Oi de novo'));
  assert.equal(optOut.sqls('INSERT INTO whatsapp_atendimento_mensagens')[0].args[5], 'PROCESSADA');
  assert.equal(optOut.sqls('UPDATE whatsapp_atendimento_conversas').length, 0);
});
test('empresa inativa ou configuração ausente recusa a entrada para retry durável', async () => {
  await assert.rejects(carregar({ empresaAtiva: false }).modulo.receberEntrada(entrada('Olá')), /ATENDIMENTO_EMPRESA_INATIVA/);
  await assert.rejects(carregar({ config: { invalida: true } }).modulo.receberEntrada(entrada('Olá')), /ATENDIMENTO_CONFIGURACAO_AUSENTE/);
});
test('controle usa só a empresa piloto comprovada e recusa papel sem atendimento', async () => {
  const { modulo, tenants } = carregar({ papel: 'OPERACIONAL' });
  await assert.rejects(modulo.listarAtendimento(sessao), /ATENDIMENTO_ACESSO_NEGADO/);
  assert.deepEqual(tenants, ['e']);
});
test('envio humano exige versão atual, conversa assumida, janela aberta e contato não bloqueado', async () => {
  const pedido = { acao: 'enviar' as const, conversaId: 'c', texto: 'Olá', versao: 1 };
  await assert.rejects(carregar({ conversa: { estado: 'HUMANO', responsavel_id: 'u' } }).modulo.controlarAtendimento(sessao, { ...pedido, versao: 0 }), /ATENDIMENTO_DESATUALIZADO/);
  await assert.rejects(carregar().modulo.controlarAtendimento(sessao, pedido), /ATENDIMENTO_ASSUMA_ANTES_DE_ENVIAR/);
  await assert.rejects(carregar({ conversa: { estado: 'HUMANO', responsavel_id: 'outro' } }).modulo.controlarAtendimento(sessao, pedido), /ATENDIMENTO_ASSUMA_ANTES_DE_ENVIAR/);
  const expirada = new Date(agora.getTime() - 24 * 3600000).toISOString();
  await assert.rejects(carregar({ conversa: { estado: 'HUMANO', responsavel_id: 'u', ultima_entrada_em: expirada } }).modulo.controlarAtendimento(sessao, pedido), /ATENDIMENTO_JANELA_EXPIRADA/);
  await assert.rejects(carregar({ conversa: { nao_contatar: true } }).modulo.controlarAtendimento(sessao, { ...pedido, acao: 'assumir' }), /ATENDIMENTO_CONTATO_BLOQUEADO/);
  await assert.rejects(carregar({ enviando: true }).modulo.controlarAtendimento(sessao, { ...pedido, acao: 'assumir' }), /ATENDIMENTO_ENVIO_EM_ANDAMENTO/);
  await assert.rejects(carregar({ ativo: false, conversa: { estado: 'HUMANO', responsavel_id: 'u' } }).modulo.controlarAtendimento(sessao, pedido), /ATENDIMENTO_AUTOMACAO_DESLIGADA/);
  const ok = carregar({ conversa: { estado: 'HUMANO', responsavel_id: 'u' } });
  await ok.modulo.controlarAtendimento(sessao, pedido);
  assert.equal(ok.sqls("'SAIDA',$4,'PENDENTE'").length, 1);
  assert.equal(ok.sqls('INSERT INTO whatsapp_atendimento_auditoria').length, 1);
});
test('status considera só entregue, lido e falha; ignora identificador inválido', async () => {
  const { modulo, sqls } = carregar();
  await modulo.receberStatus({ payload: { id: 'x', type: 'sent' } });
  await modulo.receberStatus({ payload: { id: '', type: 'delivered' } });
  assert.equal(sqls('INSERT INTO whatsapp_atendimento_status').length, 0);
  await modulo.receberStatus({ payload: { gsId: 'g', id: 'w', type: 'failed' } });
  assert.deepEqual(sqls('INSERT INTO whatsapp_atendimento_status')[0].args, ['e', 'staging', 'g', 'FALHOU']);
  // Correlacionado: aplica à mensagem e apaga a linha; sem correspondência, a linha fica até expirar.
  assert.deepEqual(sqls('DELETE FROM whatsapp_atendimento_status s USING')[0].args, ['e', 'staging', 'g']);
});
test('retenção: status sem correspondência (ex.: OTP) expira em 24 h, em lote e só da empresa/ambiente do piloto', async () => {
  const { modulo, sqls } = carregar();
  await modulo.limparStatusExpirados();
  const limpeza = sqls('DELETE FROM whatsapp_atendimento_status WHERE ctid IN')[0];
  assert.deepEqual(limpeza.args, ['e', 'staging', modulo.RETENCAO_STATUS_HORAS]);
  assert.equal(modulo.RETENCAO_STATUS_HORAS, 24);
  assert.match(limpeza.sql, /LIMIT 1000/);
});
test('auditoria registra empresa e ambiente da conversa', async () => {
  const { modulo, sqls } = carregar({ conversa: { estado: 'IA' } });
  await modulo.controlarAtendimento(sessao, { acao: 'assumir', conversaId: 'c', versao: 1 });
  assert.deepEqual(sqls('INSERT INTO whatsapp_atendimento_auditoria')[0].args, ['e', 'staging', 'u', 'assumir', 'c']);
});
test('contato fora da lista permitida é confirmado sem gravar nada', async () => {
  const { modulo, comandos } = carregar({ permitido: false });
  await modulo.receberEntrada(entrada('Olá'));
  assert.equal(comandos.length, 0);
});
test('horário do evento à frente do relógio vale como agora (sem 503 que o provedor repetiria sem fim)', async () => {
  const { modulo, sqls } = carregar();
  const antes = Date.now();
  await modulo.receberEntrada({ ...entrada('Olá'), timestamp: antes + 10 * 60000 });
  const criada = Date.parse(String(sqls('INSERT INTO whatsapp_atendimento_mensagens')[0].args[7]));
  assert.ok(criada >= antes && criada <= Date.now(), 'entrada gravada com o horário atual');
  // Replay antigo não reabre a janela: mantém o horário original do evento.
  const antigo = carregar();
  const ontem = antes - 30 * 3600000;
  await antigo.modulo.receberEntrada({ ...entrada('Olá', 'evento-antigo'), timestamp: ontem });
  assert.equal(Date.parse(String(antigo.sqls('INSERT INTO whatsapp_atendimento_mensagens')[0].args[7])), ontem);
});
test('lista mostra o responsável só com vínculo ativo na mesma empresa e a situação do canal em partes', async () => {
  const { modulo, sqls } = carregar();
  const dados = await modulo.listarAtendimento(sessao, 'c');
  const lista = sqls('FROM whatsapp_atendimento_conversas c')[0];
  assert.match(lista.sql, /LEFT JOIN usuarios_administrativos u ON u\.id=c\.responsavel_id AND EXISTS\(SELECT 1 FROM memberships m WHERE m\.usuario_id=u\.id AND m\.empresa_id=c\.empresa_id AND m\.status='ATIVA'\)/);
  assert.deepEqual(lista.args, ['e', 'staging']);
  assert.match(sqls('autor_usuario_id IS NOT NULL AS humana')[0].sql, /empresa_id=\$1 AND ambiente=\$2 AND conversa_id=\$3/);
  assert.deepEqual(dados.canal, { ambiente: 'staging', receptor: true, recepcao: true, envio: true });
});
