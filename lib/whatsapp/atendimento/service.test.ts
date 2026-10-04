import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carregarComponente } from '../../../components/admin/teste-componente.ts';
import * as core from './core.ts';
import type { Conversa } from './service.ts';

// Banco simulado: nenhum PostgreSQL real, modelo ou provedor é acessado.
const agora = new Date();
const base: Conversa = { id: 'c', empresa_id: 'e', ambiente: 'staging', contato: '5561999999999', estado: 'IA', responsavel_id: null, nao_contatar: false, versao: 1, ultima_entrada_em: agora.toISOString(), interesse: { data: null, convidados: null } };
const entrada = (texto: string | null, id = 'evento-1') => ({ id, app: 'KidmaisManager', source: '5561999999999', texto, timestamp: agora.getTime() });
type Opcoes = { tenantRecusado?: boolean; permitido?: boolean; ativo?: boolean; config?: unknown; conversa?: Partial<Conversa>; duplicada?: boolean; enviando?: boolean; papel?: string; empresaAtiva?: boolean; canceladas?: { entradas: number; saidas: number }; nomePerfil?: boolean; linhas?: Record<string, unknown>[] };
function carregar(op: Opcoes = {}) {
  const comandos: { sql: string; args: unknown[] }[] = [];
  const conversa = { ...base, ...op.conversa };
  const query = async (sql: string, args: unknown[] = []) => {
    comandos.push({ sql, args });
    if (sql.includes('FROM pg_attribute')) return { rows: [{ existe: op.nomePerfil ?? false }] };
    if (sql.includes('FROM whatsapp_atendimento_conversas c')) return { rows: op.linhas ?? [] };
    if (sql.includes('FROM empresas')) return { rows: op.empresaAtiva === false ? [] : [{ id: 'e' }] };
    if (sql.includes('SELECT configuracao')) return { rows: [{ configuracao: op.config ?? { ativo: true, nome: 'Kidmais', perguntas: [] } }] };
    if (sql.includes('AND externa_id=$3')) return { rows: op.duplicada ? [{ id: 'm' }] : [] };
    if (sql.includes('INSERT INTO whatsapp_atendimento_conversas')) return { rows: [conversa] };
    if (sql.includes('SELECT * FROM whatsapp_atendimento_conversas')) return { rows: [conversa] };
    if (sql.includes("estado='ENVIANDO'")) return { rows: op.enviando ? [{ id: 'x' }] : [] };
    if (sql.includes("SET estado='CANCELADA' WHERE id IN")) return { rows: [...Array.from({ length: op.canceladas?.entradas ?? 0 }, () => ({ direcao: 'ENTRADA' })), ...Array.from({ length: op.canceladas?.saidas ?? 0 }, () => ({ direcao: 'SAIDA' }))] };
    return { rows: [] };
  };
  const tenants: string[] = [];
  const modulo = carregarComponente('lib/whatsapp/atendimento/service.ts', {
    '../../db/postgres.ts': { db: () => ({ query }), withTransaction: async (fn: (tx: unknown) => unknown) => fn({ query }) },
    '../../saas/provar-tenant.ts': { withTenantTransaction: async (_s: unknown, empresa: string, fn: (tx: unknown, t: unknown) => unknown) => { if (op.tenantRecusado) throw Object.assign(new Error('A sessão administrativa não comprova a empresa autorizada.'), { code: 'TENANT_NAO_COMPROVADO' }); tenants.push(empresa); return fn({ query }, { empresaComprovada: empresa, papelAtual: op.papel ?? 'ADMINISTRATIVO' }); } },
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
test('condição que retry não corrige não devolve erro: empresa suspensa confirma sem gravar; sem configuração grava para a equipe', async () => {
  const suspensa = carregar({ empresaAtiva: false });
  await suspensa.modulo.receberEntrada(entrada('Olá'));
  assert.equal(suspensa.sqls('INSERT INTO').length, 0);
  assert.doesNotMatch(suspensa.sqls('FROM empresas')[0].sql, /FOR (SHARE|UPDATE)/, 'webhook não trava a linha da empresa');
  const semConfig = carregar({ config: { invalida: true } });
  await semConfig.modulo.receberEntrada(entrada('Olá'));
  assert.equal(semConfig.sqls('INSERT INTO whatsapp_atendimento_mensagens')[0].args[5], 'PROCESSADA');
  assert.equal(semConfig.sqls("SET estado='AGUARDANDO_HUMANO'").length, 1);
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
  // Retenção roda também na recepção (processador pode estar desligado).
  assert.equal(sqls('DELETE FROM whatsapp_atendimento_status WHERE ctid IN').length, 1);
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
  assert.doesNotMatch(lista.sql, /c\.\*/, 'só as colunas da tela, nunca a linha inteira');
  assert.match(sqls('autor_usuario_id IS NOT NULL AS humana')[0].sql, /empresa_id=\$1 AND ambiente=\$2 AND conversa_id=\$3/);
  assert.deepEqual(dados.canal, { ambiente: 'staging', receptor: true, recepcao: true, envio: true });
});

test('tela autorizada: número completo, cadastro só da empresa (sem mesclados, com e sem 55) e vários cadastros sem escolha', async () => {
  const linhas = [
    { id: 'c1', contato: '5561900000101', contato_final: '0101', versao: '3', estado: 'IA', nome_perfil: null, clientes: 1, cliente_nome: 'Ana Souza' },
    { id: 'c2', contato: '5561900000105', contato_final: '0105', versao: '1', estado: 'IA', nome_perfil: null, clientes: 2, cliente_nome: null },
    { id: 'c3', contato: '5561900000102', contato_final: '0102', versao: '1', estado: 'IA', nome_perfil: null, clientes: 0, cliente_nome: null },
  ];
  const { modulo, sqls } = carregar({ linhas });
  const dados = await modulo.listarAtendimento(sessao);
  const sql = sqls('FROM whatsapp_atendimento_conversas c')[0].sql;
  assert.match(sql, /c\.contato,right\(c\.contato,4\) AS contato_final/, 'número completo só nesta listagem, que passa por acessoAtendimento');
  assert.match(sql, /WHERE cl\.empresa_id=c\.empresa_id AND cl\.status<>'MESCLADO' AND \(cl\.telefone IN \(c\.contato,v\.sem55\) OR cl\.whatsapp IN \(c\.contato,v\.sem55\)\)/, 'cadastro só da mesma empresa, sem mesclados');
  assert.match(sql, /CASE WHEN c\.contato LIKE '55%' AND length\(c\.contato\) IN \(12,13\) THEN substr\(c\.contato,3\) END AS sem55/, 'mesma variante sem 55 de variantesTelefone');
  assert.match(sql, /CASE WHEN count\(\*\)=1 THEN max\(cl\.nome_completo\) END AS cliente_nome/, 'com vários clientes nenhum nome sai do banco');
  assert.match(sql, /WHERE c\.empresa_id=\$1 AND c\.ambiente=\$2/, 'conversas da empresa e do ambiente');
  assert.match(sql, /NULL::text AS nome_perfil/, 'sem a 065, sem nome de perfil (e sem erro)');
  assert.deepEqual(dados.conversas.map(c => [c.contato, c.versao, c.cadastro]), [
    ['5561900000101', 3, { situacao: 'UNICO', nome: 'Ana Souza' }],
    ['5561900000105', 1, { situacao: 'AMBIGUO', quantidade: 2 }],
    ['5561900000102', 1, { situacao: 'SEM_CADASTRO' }],
  ]);
  assert.ok(dados.conversas.every(c => !('clientes' in c) && !('cliente_nome' in c)), 'colunas auxiliares não vão para a tela');
  const com065 = carregar({ nomePerfil: true });
  await com065.modulo.listarAtendimento(sessao);
  assert.match(com065.sqls('FROM whatsapp_atendimento_conversas c')[0].sql, /c\.nome_perfil AS nome_perfil/);
  // Papel sem atendimento não vê nada disso.
  await assert.rejects(carregar({ papel: 'OPERACIONAL' }).modulo.listarAtendimento(sessao), /ATENDIMENTO_ACESSO_NEGADO/);
});

test('nome de perfil: gravado só com a 065 aplicada, saneado, sem mudar versão/estado, e replay antigo não sobrescreve', async () => {
  const sem = carregar();
  await sem.modulo.receberEntrada({ ...entrada('Olá'), nomePerfil: 'Ana' });
  assert.equal(sem.sqls('SET nome_perfil').length, 0, 'sem a coluna, nada é gravado e a mensagem segue');
  assert.equal(sem.sqls('INSERT INTO whatsapp_atendimento_mensagens').length, 1);

  const com = carregar({ nomePerfil: true });
  await com.modulo.receberEntrada({ ...entrada('Olá'), nomePerfil: '  Ana​  Souza ' });
  const upd = com.sqls('SET nome_perfil')[0];
  assert.match(upd.sql, /SET nome_perfil=\$2,nome_perfil_em=\$3 WHERE id=\$1 AND \(nome_perfil_em IS NULL OR nome_perfil_em<\$3\)/);
  assert.doesNotMatch(upd.sql, /versao|estado/, 'não muda versão nem estado da conversa');
  assert.deepEqual(upd.args.slice(0, 2), ['c', 'Ana Souza']);

  const vazio = carregar({ nomePerfil: true });
  await vazio.modulo.receberEntrada({ ...entrada('Olá'), nomePerfil: '​ ' });
  await vazio.modulo.receberEntrada({ ...entrada('Olá', 'evento-2') });
  assert.equal(vazio.sqls('SET nome_perfil').length, 0, 'nome vazio ou ausente não apaga o anterior');

  const fora = carregar({ nomePerfil: true, permitido: false });
  await fora.modulo.receberEntrada({ ...entrada('Olá'), nomePerfil: 'Ana' });
  assert.equal(fora.comandos.length, 0, 'contato fora da lista: nem o nome é gravado');
});

test('nome de perfil e cadastro nunca vão ao modelo: o worker só envia mensagens e interesse', async () => {
  const { readFileSync } = await import('node:fs');
  const worker = readFileSync('lib/whatsapp/atendimento/worker.ts', 'utf8');
  const chamada = worker.match(/deps\.interpretar\(empresa, JSON\.stringify\(\{([^}]*)\}\)/);
  assert.ok(chamada, 'chamada ao modelo encontrada');
  assert.equal(chamada![1].replace(/\s+/g, ''), 'mensagens:historico.map(m=>m.texto),mensagemAtual:atual,interesseAnterior:conversa.interesse');
  assert.doesNotMatch(worker, /nome_perfil|cliente_nome|cadastro/);
});
test('depois do PARAR, "atendente" fica registrado mas não reabre a conversa nem libera ações', async () => {
  const bloqueada = carregar({ conversa: { estado: 'ENCERRADA', nao_contatar: true } });
  await bloqueada.modulo.receberEntrada(entrada('Quero falar com um atendente', 'evento-apos-parar'));
  assert.equal(bloqueada.sqls('INSERT INTO whatsapp_atendimento_mensagens')[0].args[5], 'PROCESSADA', 'gravada sem automação');
  assert.equal(bloqueada.sqls('UPDATE whatsapp_atendimento_conversas').length, 0, 'continua encerrada e bloqueada');
  for (const acao of ['assumir', 'retomar', 'enviar'] as const)
    await assert.rejects(carregar({ conversa: { estado: 'ENCERRADA', nao_contatar: true } }).modulo.controlarAtendimento(sessao, { acao, conversaId: 'c', versao: 1, texto: 'Olá' }), /ATENDIMENTO_CONTATO_BLOQUEADO/, acao);
});

test('encerrar cancela as pendentes na mesma transação, antes de encerrar, sem esperar o worker; histórico fica', async () => {
  const { modulo, comandos } = carregar({ conversa: { estado: 'AGUARDANDO_HUMANO' }, canceladas: { entradas: 1, saidas: 2 } });
  const r = await modulo.controlarAtendimento(sessao, { acao: 'encerrar', conversaId: 'c', versao: 1 });
  assert.deepEqual(r, { canceladas: { entradas: 1, saidas: 2 } }, "contador separa entradas de saídas");
  const i = (trecho: string) => comandos.findIndex(c => c.sql.includes(trecho));
  const cancelar = () => comandos[i("SET estado='CANCELADA' WHERE id IN")];
  assert.ok(cancelar(), 'cancelamento executado');
  assert.match(cancelar().sql, /RETURNING direcao/);
  assert.ok(cancelar().sql.includes("estado IN ('PENDENTE','PROCESSANDO')"));
  assert.match(cancelar().sql, /FOR UPDATE SKIP LOCKED/, 'não espera a mensagem que o worker segura (ele mesmo cancela ao revalidar)');
  assert.ok(cancelar().sql.includes('conversa_id=$1 AND empresa_id=$2 AND ambiente=$3'));
  assert.deepEqual(cancelar().args, ['c', 'e', 'staging'], 'só a conversa da empresa/ambiente comprovados');
  assert.ok(i('FOR UPDATE') < i("SET estado='CANCELADA' WHERE id IN"), 'conversa travada antes');
  assert.ok(i("SET estado='CANCELADA' WHERE id IN") < i('UPDATE whatsapp_atendimento_conversas SET estado'), 'cancela antes de marcar ENCERRADA');
  assert.deepEqual(comandos.find(c => c.sql.includes('UPDATE whatsapp_atendimento_conversas SET estado'))!.args.slice(1), ['ENCERRADA', null]);
  assert.ok(comandos.some(c => c.sql.includes('INSERT INTO whatsapp_atendimento_auditoria') && c.args[3] === 'encerrar'));
  assert.ok(!comandos.some(c => /DELETE FROM whatsapp_atendimento_mensagens/.test(c.sql)), 'nada do histórico é apagado');
});

test('encerrar com envio em andamento é recusado e não cancela nem encerra nada; outras ações não cancelam', async () => {
  const bloqueado = carregar({ enviando: true, canceladas: { entradas: 1, saidas: 2 } });
  await assert.rejects(bloqueado.modulo.controlarAtendimento(sessao, { acao: 'encerrar', conversaId: 'c', versao: 1 }), /ATENDIMENTO_ENVIO_EM_ANDAMENTO/);
  assert.equal(bloqueado.sqls("SET estado='CANCELADA' WHERE id IN").length, 0);
  assert.equal(bloqueado.sqls('UPDATE whatsapp_atendimento_conversas SET estado').length, 0);
  const assumir = carregar({ canceladas: { entradas: 1, saidas: 2 } });
  assert.deepEqual(await assumir.modulo.controlarAtendimento(sessao, { acao: 'assumir', conversaId: 'c', versao: 1 }), { canceladas: { entradas: 0, saidas: 0 } });
  assert.equal(assumir.sqls("SET estado='CANCELADA' WHERE id IN").length, 0);
  const desatualizado = carregar({ canceladas: { entradas: 1, saidas: 2 } });
  await assert.rejects(desatualizado.modulo.controlarAtendimento(sessao, { acao: 'encerrar', conversaId: 'c', versao: 7 }), /ATENDIMENTO_DESATUALIZADO/);
  assert.equal(desatualizado.sqls("SET estado='CANCELADA' WHERE id IN").length, 0);
});

test('resumo do encerramento separa respostas na fila de mensagens do cliente sem resposta automática', async () => {
  const { resumoEncerramento } = await import('./encerramento.ts');
  assert.equal(resumoEncerramento({ entradas: 0, saidas: 0 }), 'Atendimento encerrado. O histórico foi mantido.');
  assert.equal(resumoEncerramento({ entradas: 0, saidas: 1 }), 'Atendimento encerrado. 1 resposta na fila foi cancelada. O histórico foi mantido.');
  assert.equal(resumoEncerramento({ entradas: 2, saidas: 3 }), 'Atendimento encerrado. 3 respostas na fila foram canceladas; 2 mensagens do cliente ficaram sem resposta automática. O histórico foi mantido.');
  assert.equal(resumoEncerramento(undefined), 'Atendimento encerrado. O histórico foi mantido.');
});

// Empresa ativa (063 do painel): o campo só existe na sessão quando a 063 está aplicada. A piloto deste harness é 'e'.
test('empresa ativa: sem o campo (sem a 063) vale o comportamento anterior — abre na piloto provada no banco', async () => {
  const { modulo, tenants } = carregar();
  await modulo.listarAtendimento({ usuario_id: 'u', papel: 'ADMINISTRATIVO' } as never);
  assert.deepEqual(tenants, ['e']);
});
test('empresa ativa: com a 063, a piloto selecionada abre; maiúsculas não importam', async () => {
  const { modulo, tenants } = carregar();
  await modulo.listarAtendimento({ usuario_id: 'u', papel: 'ADMINISTRATIVO', id: 's', empresa_ativa_id: 'E' } as never);
  assert.deepEqual(tenants, ['e']);
});
test('empresa ativa: seleção pendente (nula) é recusada antes de abrir qualquer transação, na leitura, nas ações e na configuração', async () => {
  const { modulo, tenants, comandos } = carregar({ papel: 'REPRESENTANTE_AUTORIZADO' });
  const pendente = { usuario_id: 'u', papel: 'REPRESENTANTE_AUTORIZADO', id: 's', empresa_ativa_id: null } as never;
  await assert.rejects(modulo.listarAtendimento(pendente), /ATENDIMENTO_EMPRESA_NAO_SELECIONADA/);
  await assert.rejects(modulo.controlarAtendimento(pendente, { acao: 'assumir', conversaId: 'c', versao: 1 }), /ATENDIMENTO_EMPRESA_NAO_SELECIONADA/);
  await assert.rejects(modulo.salvarConfiguracao(pendente, { ativo: false, nome: 'Kidmais', perguntas: [], limites: { respostasPor24h: 20 } }), /ATENDIMENTO_EMPRESA_NAO_SELECIONADA/);
  assert.deepEqual(tenants, []);
  assert.equal(comandos.length, 0, 'nenhuma consulta ao banco');
});
test('empresa ativa: outra empresa ativa é divergência — recusada antes de ler ou gravar', async () => {
  const { modulo, tenants, comandos } = carregar({ papel: 'REPRESENTANTE_AUTORIZADO' });
  const outra = { usuario_id: 'u', papel: 'REPRESENTANTE_AUTORIZADO', id: 's', empresa_ativa_id: 'b' } as never;
  await assert.rejects(modulo.listarAtendimento(outra), /ATENDIMENTO_EMPRESA_DIVERGENTE/);
  await assert.rejects(modulo.controlarAtendimento(outra, { acao: 'assumir', conversaId: 'c', versao: 1 }), /ATENDIMENTO_EMPRESA_DIVERGENTE/);
  await assert.rejects(modulo.salvarConfiguracao(outra, { ativo: false, nome: 'Kidmais', perguntas: [], limites: { respostasPor24h: 20 } }), /ATENDIMENTO_EMPRESA_DIVERGENTE/);
  assert.deepEqual(tenants, []);
  assert.equal(comandos.length, 0, 'nenhuma consulta ao banco');
});
test('falta de acesso: sem vínculo ativo na piloto (tenant não comprovado) vira ATENDIMENTO_SEM_ACESSO; papel sem acesso segue ACESSO_NEGADO', async () => {
  const semVinculo = carregar({ tenantRecusado: true });
  await assert.rejects(semVinculo.modulo.listarAtendimento(sessao), /ATENDIMENTO_SEM_ACESSO/);
  const papel = carregar({ papel: 'OPERACIONAL' });
  await assert.rejects(papel.modulo.listarAtendimento(sessao), /ATENDIMENTO_ACESSO_NEGADO/);
});
