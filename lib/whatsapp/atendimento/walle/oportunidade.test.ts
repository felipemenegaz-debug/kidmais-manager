import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { chaveDoCartao, nomeDoCartao, qualificaPedidoFesta, variantesDoTelefone } from './oportunidade.ts';
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

test('chave do cartão: estável, no formato da 085 e distinta por empresa, ambiente, conversa e ordem', () => {
  const k = chaveDoCartao('e', 'staging', 'c', 1);
  assert.match(k, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(k, chaveDoCartao('e', 'staging', 'c', 1));
  assert.equal(new Set([k, chaveDoCartao('e2', 'staging', 'c', 1), chaveDoCartao('e', 'production', 'c', 1), chaveDoCartao('e', 'staging', 'c2', 1), chaveDoCartao('e', 'staging', 'c', 2)]).size, 5);
});

test('o módulo só depende de tipos e node:crypto (as provas em PG o montam dentro do worker e da privacidade)', () => {
  const fonte = readFileSync('lib/whatsapp/atendimento/walle/oportunidade.ts', 'utf8');
  const imports = [...fonte.matchAll(/^import (type )?.* from '([^']+)';$/gm)].map(m => `${m[1] ? 'type ' : ''}${m[2]}`);
  assert.deepEqual(imports, ['node:crypto', 'type ../../../db/contracts.ts', 'type ./tipos.ts']);
  // Nenhuma automação, atribuição, histórico ou cadastro de cliente na captura.
  for (const proibido of ['marketing_atribuicoes', 'marketing_contato_autorizacoes', 'registrarEventoHistorico', 'clienteDoContato', 'criarCliente', 'INSERT INTO clientes'])
    assert.equal(fonte.includes(proibido), false, proibido);
});

test('worker marca na resposta (savepoint) e captura ao fim do lote; exclusão a pedido do titular anonimiza', () => {
  const worker = readFileSync('lib/whatsapp/atendimento/worker.ts', 'utf8');
  assert.match(worker, /qualificaPedidoFesta\(resultado\) && !\(await marcarPendente\(tx, atual\.id\)\)/);
  assert.ok(worker.indexOf('await capturarOportunidadesDoLote()') > worker.indexOf('const resultado = await processarAtendimento(deps);'));
  const privacidade = readFileSync('lib/whatsapp/atendimento/privacidade.ts', 'utf8');
  const anon = privacidade.indexOf("alvo.motivo === 'PEDIDO_DO_TITULAR') await anonimizarOportunidadesDaConversa");
  assert.ok(anon > 0 && anon < privacidade.indexOf("await tx.query('DELETE FROM whatsapp_atendimento_conversas WHERE id=$1'"));
});
