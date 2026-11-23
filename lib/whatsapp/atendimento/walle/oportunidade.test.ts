import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { chaveDoCartao, chaveTravaTelefone, nomeDoCartao, qualificaPedidoFesta, variantesDoTelefone } from './oportunidade.ts';
import type { Entendimento, Intencao, Passagem, ResultadoWallE, TipoIntencao } from './tipos.ts';

const vazio = { data: null, turno: null, convidados: null, pacotes: [], unidade: null, tema: null };
function entendimento(tipos: TipoIntencao[], extra: Partial<Entendimento> = {}, intencoes?: Intencao[]): Entendimento {
  return { intencoes: intencoes ?? tipos.map(tipo => ({ tipo, trecho: 'x' })), entidades: { ...vazio }, reenviar: false, alergia: false, origem: 'REGRAS', ...extra };
}
function resultado(e: Entendimento | null, extra: Partial<ResultadoWallE> = {}): ResultadoWallE {
  return { saidas: [{ texto: 'ok', anexo: null, fontes: [] }], contexto: { ultimoEntendimento: e }, passagem: null, ...extra };
}
const passagem = (motivo: Passagem['motivo']): Passagem => ({ motivo, motivos: [motivo], em: '2026-11-23T00:00:00Z', coletado: { data: null, turno: null, convidados: null, pacote: null, unidade: null, tema: null }, enviados: [], pendentes: [], ultimaMensagem: '' } as unknown as Passagem);

test('D-WA-2: pedido de festa nova qualifica (preço, disponibilidade, pacotes, contratar, orçamento, visita, data ou convidados)', () => {
  for (const t of ['PRECOS', 'DISPONIBILIDADE', 'PACOTES', 'CONTRATAR'] as TipoIntencao[]) assert.equal(qualificaPedidoFesta(resultado(entendimento([t]))), true, t);
  assert.equal(qualificaPedidoFesta(resultado(entendimento([], {}, [{ tipo: 'NEGOCIACAO', trecho: 'x', consultaComum: 'ORCAMENTO_INFORMADO' }]))), true, 'orçamento');
  assert.equal(qualificaPedidoFesta(resultado(entendimento([], {}, [{ tipo: 'DUVIDA', trecho: 'x', consultaComum: 'VISITA_MARCADA' }]))), true, 'visita');
  assert.equal(qualificaPedidoFesta(resultado(entendimento(['SAUDACAO'], { entidades: { ...vazio, data: '2027-03-06' } }))), true, 'data nesta mensagem');
  assert.equal(qualificaPedidoFesta(resultado(entendimento(['OUTRO'], { entidades: { ...vazio, convidados: 80 } }))), true, 'convidados nesta mensagem');
  // Passagem por contratação ou negociação continua sendo pedido de festa (a equipe assume, o cartão nasce).
  assert.equal(qualificaPedidoFesta(resultado(entendimento(['CONTRATAR']), { passagem: passagem('CONTRATACAO') })), true);
});

test('D-WA-2: saudação, dúvida, suporte a contrato, pagamento, reclamação, instrução e parar não qualificam', () => {
  for (const t of ['SAUDACAO', 'DUVIDA', 'LOCALIZACAO', 'CARDAPIO', 'DECORACAO', 'CONTRATO', 'CONFIRMACAO', 'HUMANO', 'OUTRO'] as TipoIntencao[])
    assert.equal(qualificaPedidoFesta(resultado(entendimento([t]))), false, t);
  assert.equal(qualificaPedidoFesta(resultado(null)), false, 'sem entendimento');
  assert.equal(qualificaPedidoFesta(resultado(entendimento(['PRECOS', 'CONTRATO_PROPRIO']))), false, 'contrato próprio');
  assert.equal(qualificaPedidoFesta(resultado(entendimento(['PRECOS', 'PARAR']))), false, 'parar');
  assert.equal(qualificaPedidoFesta(resultado(entendimento(['PRECOS', 'EXTERNO']))), false, 'externo');
  for (const s of [{ pagamento: true }, { reclamacao: true }, { instrucao: true }, { pagamentoAcao: true }])
    assert.equal(qualificaPedidoFesta(resultado(entendimento(['PRECOS'], { sinais: { reclamacao: false, pagamento: false, instrucao: false, ...s } }))), false, JSON.stringify(s));
  assert.equal(qualificaPedidoFesta(resultado(entendimento(['PRECOS'], { parar: { tipo: 'AMBIGUO', trecho: 'x' } as unknown as Entendimento['parar'] }))), false, 'parar ambíguo');
  for (const m of ['CONTRATO_PROPRIO', 'PAGAMENTO', 'RECLAMACAO', 'INSTRUCAO_SUSPEITA', 'PARAR_A_CONFIRMAR', 'BLOQUEADO_A_PEDIDO'] as Passagem['motivo'][])
    assert.equal(qualificaPedidoFesta(resultado(entendimento(['PRECOS']), { passagem: passagem(m) })), false, m);
  assert.equal(qualificaPedidoFesta(resultado(entendimento(['PRECOS']), { parar: true })), false, 'resultado parar');
  assert.equal(qualificaPedidoFesta(resultado(entendimento(['PRECOS']), { silencio: true })), false, 'silêncio');
});

test('nome do cartão: perfil higienizado (2–120) ou "WhatsApp final NNNN"', () => {
  assert.equal(nomeDoCartao('  Ana\u0000  Souza​ \n', '5561999991234'), 'Ana Souza');
  assert.equal(nomeDoCartao('A', '5561999991234'), 'WhatsApp final 1234');
  assert.equal(nomeDoCartao(null, '5561999991234'), 'WhatsApp final 1234');
  assert.equal(nomeDoCartao('‮\u0007 ', '5561999991234'), 'WhatsApp final 1234');
  const longo = nomeDoCartao('😀'.repeat(200), '5561999991234');
  assert.equal([...longo].length, 120);
});

test('telefone com e sem 55: mesma regra de lib/marketing/contatos.ts', () => {
  // contatos.ts puxa o banco ao ser importado: a função de lá é lida do fonte e avaliada isolada (sem tipos).
  const fonte = readFileSync('lib/marketing/contatos.ts', 'utf8');
  const corpo = /export function variantesTelefone\(digitos: string\) \{\r?\n([\s\S]*?)\r?\n\}\r?\n/.exec(fonte)?.[1];
  assert.ok(corpo, 'variantesTelefone em contatos.ts');
  const variantesTelefone = new Function('digitos', corpo) as (d: string) => string[];
  for (const n of ['5561999991234', '61999991234', '6133331234', '556133331234', '12345678', '15551234567']) assert.deepEqual(variantesDoTelefone(n), variantesTelefone(n), n);
});

test('chave do cartão: estável, no formato da 085 e distinta por empresa, ambiente, conversa e marca (r2: instante, não contagem)', () => {
  const m1 = '2026-11-23 10:00:00.123456+00', m2 = '2026-11-23 10:05:00.654321+00';
  const k = chaveDoCartao('e', 'staging', 'c', m1);
  assert.match(k, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(k, chaveDoCartao('e', 'staging', 'c', m1));
  assert.equal(new Set([k, chaveDoCartao('e2', 'staging', 'c', m1), chaveDoCartao('e', 'production', 'c', m1), chaveDoCartao('e', 'staging', 'c2', m1), chaveDoCartao('e', 'staging', 'c', m2)]).size, 5);
});

test('r2: trava por telefone igual à do site e do registro manual (com e sem 55, sem ambiente)', () => {
  const fonte = readFileSync('lib/marketing/contatos.ts', 'utf8');
  const corpo = /export function chaveTravaTelefone\(empresaId: string, digitos: string\) \{\r?\n([\s\S]*?)\r?\n\}\r?\n/.exec(fonte)?.[1];
  assert.ok(corpo, 'chaveTravaTelefone em contatos.ts');
  const deContatos = new Function('empresaId', 'digitos', corpo) as (e: string, d: string) => string;
  for (const n of ['5561999991234', '61999991234', '6133331234', '556133331234', '12345678']) assert.equal(chaveTravaTelefone('e', n), deContatos('e', n), n);
  assert.equal(chaveTravaTelefone('e', '5561999991234'), chaveTravaTelefone('e', '61999991234'), 'mesma trava com e sem 55');
  // Cada INSERT de cartão em contatos.ts toma a trava logo antes.
  const inserts = [...fonte.matchAll(/INSERT INTO marketing_contatos/g)].map(m => m.index!);
  assert.equal(inserts.length, 2);
  for (const i of inserts) assert.ok(fonte.lastIndexOf('await travarTelefoneNoFunil(', i) > fonte.lastIndexOf('\n}', i), 'trava antes do INSERT na mesma função');
});

test('o módulo só depende de tipos e node:crypto (as provas em PG o montam dentro do worker e da privacidade)', () => {
  const fonte = readFileSync('lib/whatsapp/atendimento/walle/oportunidade.ts', 'utf8');
  const imports = [...fonte.matchAll(/^import (type )?.* from '([^']+)';$/gm)].map(m => `${m[1] ? 'type ' : ''}${m[2]}`);
  assert.deepEqual(imports, ['node:crypto', 'type ../../../db/contracts.ts', 'type ./tipos.ts']);
  // Nenhuma automação, atribuição, histórico ou cadastro de cliente na captura.
  const exclusao = fonte.indexOf('export async function anonimizarOportunidadesDaConversa(');
  assert.ok(exclusao > 0);
  const captura = fonte.slice(0, exclusao);
  for (const proibido of ['marketing_atribuicoes', 'marketing_contato_autorizacoes', 'registrarEventoHistorico', 'clienteDoContato', 'criarCliente', 'INSERT INTO clientes'])
    assert.equal(captura.includes(proibido), false, proibido);
  // r3: a exclusão só LÊ a atribuição (append-only pela 085) para contar em `revisar`; nunca grava nela.
  const anon = fonte.slice(exclusao);
  for (const proibido of ['INSERT INTO marketing_atribuicoes', 'UPDATE marketing_atribuicoes', 'DELETE FROM', 'clienteDoContato', 'registrarEventoHistorico'])
    assert.equal(anon.includes(proibido), false, `exclusão: ${proibido}`);
  // r3: a marca das conversas irmãs é descartada ANTES da trava do telefone (mesma ordem da captura: conversa, telefone).
  assert.ok(anon.indexOf('SET oportunidade_pendente_em=NULL') > 0 && anon.indexOf('SET oportunidade_pendente_em=NULL') < anon.indexOf('await travarTelefone('), 'marca antes da trava');
  assert.ok(anon.includes('anonimizado_em=clock_timestamp(),conversa_id=NULL'), 'vínculo solto da conversa');
});

test('r4: reuso do site/manual recortado; Origens corta por ambiente; travas do down e das conversas irmãs; revisar com id', () => {
  const fonte = readFileSync('lib/marketing/contatos.ts', 'utf8');
  assert.equal(fonte.includes('cartaoWalleAberto'), false, 'sem reuso do cartão do Wall-e pelo site ou registro manual');
  assert.ok(fonte.includes("com132 ? sqlListaContatos(CORTE_AMBIENTE_WALLE, ANONIMIZADO_WALLE) : sqlListaContatos('')"), 'lista por ambiente');
  const op = readFileSync('lib/whatsapp/atendimento/walle/oportunidade.ts', 'utf8');
  const anon = op.slice(op.indexOf('export async function anonimizarOportunidadesDaConversa('));
  const trava = anon.indexOf('ORDER BY id FOR UPDATE');
  assert.ok(trava > 0 && trava < anon.indexOf('SET oportunidade_pendente_em=NULL'), 'conversas do número travadas antes de descartar a marca');
  for (const criterio of ["a.alvo_tipo<>'CONTATO'", "h.entidade_tipo='MARKETING_CONTATO' AND h.entidade_id=k.id", 'revisarIds.push(v.contato_id)'])
    assert.ok(anon.includes(criterio), criterio);
  const down = readFileSync('database/rollback/20261123_132_walle_oportunidades_down.sql', 'utf8');
  const conversas = down.indexOf('LOCK TABLE whatsapp_atendimento_conversas IN ACCESS EXCLUSIVE MODE');
  const vinculos = down.indexOf('LOCK TABLE whatsapp_atendimento_oportunidades IN ACCESS EXCLUSIVE MODE');
  assert.ok(conversas > 0 && conversas < vinculos && vinculos < down.indexOf('IF EXISTS (SELECT 1 FROM whatsapp_atendimento_oportunidades)'), 'down trava conversa → vínculo antes de checar');
});

test('r5: empresa (FOR KEY SHARE) antes da conversa na captura e no lote; down em READ COMMITTED; cartão anonimizado só leitura', () => {
  const op = readFileSync('lib/whatsapp/atendimento/walle/oportunidade.ts', 'utf8');
  const cap = op.slice(op.indexOf('export async function capturarOportunidade('));
  const emp = cap.indexOf('await travarEmpresa(tx, escopo.empresaId)');
  assert.ok(emp > 0 && emp < cap.indexOf('FOR UPDATE SKIP LOCKED'), 'captura: empresa antes da conversa');
  assert.ok(op.includes("'SELECT id FROM empresas WHERE id=$1 FOR KEY SHARE'"));
  const lote = op.slice(op.indexOf('const candidata = '));
  const empLote = lote.indexOf('await travarEmpresa(tx, candidata.empresa_id)');
  assert.ok(empLote > 0 && empLote < lote.indexOf('FOR UPDATE SKIP LOCKED'), 'lote: empresa antes da conversa');
  assert.equal(lote.slice(0, empLote).includes('FOR UPDATE'), false, 'candidata escolhida sem trava');
  assert.ok(lote.includes('WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND oportunidade_pendente_em <= clock_timestamp() FOR UPDATE SKIP LOCKED'), 'pendência e escopo revalidados sob a trava (r6)');
  const down = readFileSync('database/rollback/20261123_132_walle_oportunidades_down.sql', 'utf8');
  assert.match(down, /^BEGIN ISOLATION LEVEL READ COMMITTED;$/m, 'down fixa o isolamento');
  assert.doesNotMatch(down, /^BEGIN;$/m);
  const contatos = readFileSync('lib/marketing/contatos.ts', 'utf8');
  const acao = contatos.slice(contatos.indexOf('export async function executarAcaoContato('));
  const guarda = acao.indexOf('await exigirContatoEditavel(tx, acao.id);');
  assert.ok(guarda > 0 && guarda < acao.indexOf('if (acao.acao === "status")'),'guarda antes das ações de edição');
  const tela = readFileSync('components/admin/marketing/MarketingOrigens.tsx', 'utf8');
  assert.ok(tela.includes('const editavel = podeEditar && !c?.anonimizado;'));
  assert.ok(tela.includes('podeEditar && !c.anonimizado && !c.fechamentoId'), 'Abrir negociação some no anonimizado');
});

test('r6: anonimizado recusado em Oportunidades e na conversão; empresa antes do telefone no site; registros só da Gestão; escopo na releitura; lote com varredura; histórico pela empresa; sem Chamar', () => {
  const conv = readFileSync('lib/marketing/conversao.ts', 'utf8');
  assert.ok(conv.includes('throw new MarketingError("MARKETING_CONTATO_ANONIMIZADO", "Este contato foi anonimizado a pedido do titular e não pode ser alterado.", 409);'));
  const vinc = conv.slice(conv.indexOf('export async function vincularContatoNegociacao('));
  const gVinc = vinc.indexOf('await exigirContatoEditavel(tx, acao.id);');
  assert.ok(gVinc > vinc.indexOf('FOR UPDATE') && gVinc < vinc.indexOf('UPDATE marketing_contatos SET fechamento_id'), 'conversão: guarda com o contato travado, antes de gravar');
  const serv = readFileSync('lib/oportunidades/service.ts', 'utf8');
  const alvo = serv.slice(serv.indexOf('export async function clienteDoAlvo('));
  const gAlvo = alvo.indexOf('if (contato) await exigirContatoEditavel(tx, alvo.id);');
  assert.ok(gAlvo > alvo.indexOf('FOR UPDATE') && gAlvo < alvo.indexOf('clienteDoContato(tx'), 'Oportunidades: guarda com o cartão travado, antes de resolver cliente');
  const contatos = readFileSync('lib/marketing/contatos.ts', 'utf8');
  const trava = contatos.slice(contatos.indexOf('async function travarTelefoneNoFunil('));
  // r7 (P3-B): compara as CHAMADAS executáveis no corpo da função (o comentário também cita as duas travas); as duas precisam existir.
  const corpoTrava = trava.slice(0, trava.indexOf('\n}\n'));
  const chamadaEmpresa = corpoTrava.indexOf("await tx.query('SELECT id FROM empresas WHERE id = $1::uuid FOR KEY SHARE', [empresaId]);");
  const chamadaTelefone = corpoTrava.indexOf("await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [chaveTravaTelefone(empresaId, telefone)]);");
  assert.ok(chamadaEmpresa > 0 && chamadaTelefone > 0, 'as duas chamadas existem no corpo');
  assert.ok(chamadaEmpresa < chamadaTelefone, 'empresa antes do telefone');
  const pub = contatos.slice(contatos.indexOf('export async function capturarContatoPublico('));
  assert.ok(pub.indexOf('await travarTelefoneNoFunil(') < pub.indexOf('INSERT INTO marketing_contatos'), 'site: trava antes do INSERT');
  assert.ok(contatos.includes('const revisar = base.anonimizado && opcoes.revisarPrivacidade === true;') && contatos.includes('registrosParaRevisar: revisar ?'), 'registros só com a opção');
  const rota = readFileSync('app/api/admin/marketing/contatos/route.ts', 'utf8');
  assert.ok(rota.includes('detalheContato(tx, empresaId, id, { revisarPrivacidade: tenant.papelAtual === "REPRESENTANTE_AUTORIZADO" })'), 'rota: papel da sessão');
  const op = readFileSync('lib/whatsapp/atendimento/walle/oportunidade.ts', 'utf8');
  assert.ok(op.includes('WHERE c.id=$1 AND c.empresa_id=$2 AND c.ambiente=$3'), 'captura: escopo na releitura');
  assert.ok(op.includes('return capturarOportunidade(tx, candidata.id, { empresaId: candidata.empresa_id, ambiente });'));
  assert.ok(op.includes('while (tentadas < limite && vistas.length < varredura)'), 'lote: limite e varredura separados');
  assert.ok(op.includes("if (r !== 'SEM_PENDENCIA') { saida.capturas++; tentadas++; }"), 'SEM_PENDENCIA não gasta o limite');
  assert.ok(op.includes("eventos_historico_cliente h JOIN clientes cl ON cl.id=h.cliente_id AND cl.empresa_id=k.empresa_id"), 'exclusão: histórico pela empresa');
  const tela = readFileSync('components/admin/marketing/MarketingOrigens.tsx', 'utf8');
  assert.ok(tela.includes('const chamar=c.anonimizado ? null : linkChamar(c.telefone,c.nome);'), 'sem Chamar no anonimizado');
});

test('r7: guarda de ambiente nas escritas, atribuições cortadas no anonimizado, cursor do lote e adiamento no escopo', () => {
  const conv = readFileSync('lib/marketing/conversao.ts', 'utf8');
  assert.ok(conv.includes("'SELECT bool_or(ambiente IS DISTINCT FROM $2::text) AS outro, bool_or(anonimizado_em IS NOT NULL) AS anonimizado FROM whatsapp_atendimento_oportunidades WHERE contato_id = $1::uuid'"));
  assert.ok(conv.includes("if (v?.outro) naoEncontrado('Contato não encontrado nesta empresa.');"), 'outro ambiente = 404');
  assert.equal(conv.includes('exigirContatoNaoAnonimizado'), false, 'guarda única');
  const contatos = readFileSync('lib/marketing/contatos.ts', 'utf8');
  assert.ok(contatos.includes('const atribuicoes = base.anonimizado && !revisar ? historico.map((a) => ({ ...a, motivo: null, detalhe: null, utm: {}, campanhaId: null, campanhaNome: null })) : historico;'), 'atribuições sem texto livre fora da Gestão');
  const op = readFileSync('lib/whatsapp/atendimento/walle/oportunidade.ts', 'utf8');
  assert.ok(op.includes('AND ($3::timestamptz IS NULL OR (oportunidade_pendente_em, id) > ($3::timestamptz, $4::uuid))'), 'lote começa depois do cursor');
  assert.ok(op.includes('cursorDoLote.set(ambiente, { ...ciclo, marca: candidata.marca, id: candidata.id });'), 'cursor avança');
  assert.ok(op.includes('if (vez.fimDaFila && !voltouAoInicio) { voltouAoInicio = true; cursorDoLote.delete(ambiente); continue; }'), 'volta ao início uma vez');
  assert.ok(op.includes('WHERE id=$1 AND oportunidade_pendente_em=$3::timestamptz AND empresa_id=$4 AND ambiente=$5 RETURNING id'), 'adiamento no escopo revalidado');
  assert.ok(op.includes('[vez.id, espera, vez.marca, vez.empresaId, ambiente]'));
});

test('r8: campanha cortada no anonimizado, UTM conta como resíduo e o ciclo do lote tem teto', () => {
  const contatos = readFileSync('lib/marketing/contatos.ts', 'utf8');
  assert.ok(contatos.includes('const cortarCampanha = l.anonimizado === true && filtros.revisarPrivacidade !== true;'), 'campanha cortada fora da Gestão em revisão');
  assert.ok(contatos.includes('campanhaId: cortarCampanha ? null : l.campanha_id, campanhaNome: cortarCampanha ? null : l.campanha_nome,'));
  assert.ok(contatos.includes('AND ($6::uuid IS NULL OR (a.campanha_id = $6::uuid AND NOT ${anonimizado}))'), 'filtro por campanha não devolve o anonimizado');
  assert.ok(contatos.includes("OR COALESCE(a.utm, '{}'::jsonb) <> '{}'::jsonb OR a.alvo_tipo <> 'CONTATO')"), 'UTM no registro para revisar');
  // A rota da lista nunca pede a visão da Gestão.
  assert.equal(readFileSync('app/api/admin/marketing/contatos/route.ts', 'utf8').includes('revisarPrivacidade: true'), false);
  const op = readFileSync('lib/whatsapp/atendimento/walle/oportunidade.ts', 'utf8');
  assert.ok(op.includes("OR COALESCE(a.utm,'{}'::jsonb)<>'{}'::jsonb OR a.alvo_tipo<>'CONTATO'))"), 'UTM é resíduo');
  assert.ok(op.includes('AND (oportunidade_pendente_em, id) <= ($5::timestamptz, $6::uuid)'), 'candidata até o teto do ciclo');
  assert.ok(op.includes('[ambiente, vistas, ciclo.marca, ciclo.id, ciclo.tetoMarca, ciclo.tetoId]'));
  assert.ok(op.includes('if (!candidata) { vez.fimDaFila = true; return null; }'), 'passou do teto = fim do ciclo');
});

test('worker marca no MESMO UPDATE da memória (r2: atômico) e captura ao fim do lote; exclusão a pedido do titular anonimiza', () => {
  const worker = readFileSync('lib/whatsapp/atendimento/worker.ts', 'utf8');
  assert.ok(worker.includes("marca ? memoriaDaConversa(SQL_MARCA_PENDENTE) : memoriaDaConversa(''), marca ? [...memoria, qualificaPedidoFesta(resultado)] : memoria"), 'marca atômica');
  assert.equal(worker.includes('marcarPendente'), false, 'sem marcação separada');
  assert.ok(worker.indexOf('await capturarOportunidadesDoLote()') > worker.indexOf('const resultado = await processarAtendimento(deps);'));
  const privacidade = readFileSync('lib/whatsapp/atendimento/privacidade.ts', 'utf8');
  const anon = privacidade.indexOf("alvo.motivo === 'PEDIDO_DO_TITULAR' ? await anonimizarOportunidadesDaConversa(tx, alvo.empresa, alvo.ambiente, conversa.id, conversa.contato)");
  assert.ok(anon > 0 && anon < privacidade.indexOf("await tx.query('DELETE FROM whatsapp_atendimento_conversas WHERE id=$1'"));
});
