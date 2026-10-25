import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DbExecutor } from '../../lib/db/contracts.ts';
import * as duracao from '../../lib/comercial/duracao.ts';
import * as liberacao from '../../lib/agenda/saloes-liberacao.ts';
import { definirSaloesPacote, exigirTipoDeAgendaLiberado } from '../../lib/agenda/configuracao-unidade.ts';
import { achar, carregarComponente, cssFalso, elementos, texto } from './teste-componente.ts';

/**
 * Parecer do Astra de 25/10/2026 sobre a agenda com um salão (P2/P3, sem banco; o P1 da regra SQL fica para a migration):
 * - voltar de "por salão" para "um salão" é recusado com festas futuras no mesmo horário, com os dias travados;
 * - o salão só é exigido no pacote quando a unidade é por salão; pacote novo sem salões conta como nenhum escolhido;
 * - duplicar e revisar copiam os salões;
 * - "Revisar e confirmar" pede o salão antes de esconder o formulário.
 */
type Consulta = { sql: string; params: unknown[] };
function executor(responder: (sql: string, params: unknown[]) => unknown[] | undefined) {
  const consultas: Consulta[] = [];
  const tx = { async query(sql: string, params: unknown[] = []) { consultas.push({ sql, params }); return { rows: responder(sql, params) ?? [], rowCount: 0 }; } };
  return { tx: tx as unknown as DbExecutor, consultas };
}
const EMPRESA = '11111111-1111-4111-8111-111111111111';

test('volta para um salão: bloqueada por ora (parecer do Astra, P2 da corrida em dias vazios), com ou sem liberação', () => {
  assert.throws(() => exigirTipoDeAgendaLiberado('POR_HORARIO', 'POR_SALAO'), /Voltar da agenda com mais de um salão para um salão ainda não está disponível/);
  assert.throws(() => exigirTipoDeAgendaLiberado('POR_HORARIO', 'POR_SALAO', true), /ainda não está disponível pela tela/);
  assert.doesNotThrow(() => exigirTipoDeAgendaLiberado('POR_HORARIO', 'POR_HORARIO'));
  assert.doesNotThrow(() => exigirTipoDeAgendaLiberado('POR_HORARIO', null));
  const fonte = readFileSync('lib/agenda/configuracao-unidade.ts', 'utf8');
  assert.doesNotMatch(fonte, /exigirVoltaParaUmSalaoSemSobreposicao/, 'sem conferência parcial: a troca não é feita');
});

test('salão do pacote: exigido só com salão de unidade por salão; omitido preserva; lista mostra só esses salões', async () => {
  const consultaDe = (porSalao: number) => executor((sql) => {
    if (sql.includes('to_regclass')) return [{ ok: true }];
    if (sql.includes('count(*)::int AS n FROM agenda_saloes s')) return [{ n: porSalao }];
    return undefined;
  });
  const porSalao = consultaDe(1);
  await assert.rejects(definirSaloesPacote(porSalao.tx, EMPRESA, 'p', []), /Escolha o salão ou os salões deste pacote\./);
  assert.match(porSalao.consultas.find((c) => c.sql.includes('FROM agenda_saloes s'))!.sql, /capacidade_tipo = 'POR_SALAO'/);
  assert.equal(porSalao.consultas.some((c) => c.sql.startsWith('DELETE')), false, 'recusa antes de apagar');

  const umSalao = consultaDe(0);
  await definirSaloesPacote(umSalao.tx, EMPRESA, 'p', []);
  assert.ok(umSalao.consultas.some((c) => c.sql.startsWith('DELETE FROM pacote_saloes')), 'com um salão, sem salões é aceito');

  // Campo omitido preserva os salões (nenhuma escrita), mas na agenda por salão o vínculo efetivo precisa existir.
  const efetivoDe = (por_salao: boolean, tem: boolean) => executor((sql) => {
    if (sql.includes('to_regclass')) return [{ ok: true }];
    if (sql.includes('AS por_salao')) return [{ por_salao, tem }];
    return undefined;
  });
  const semVinculo = efetivoDe(true, false);
  await assert.rejects(definirSaloesPacote(semVinculo.tx, EMPRESA, 'p', undefined), /Este pacote ainda não tem salão. Abra o pacote, escolha o salão/);
  assert.match(semVinculo.consultas.find((c) => c.sql.includes('AS por_salao'))!.sql, /capacidade_tipo = 'POR_SALAO'/);
  for (const [por, tem] of [[true, true], [false, false]] as const) {
    const ok = efetivoDe(por, tem);
    await definirSaloesPacote(ok.tx, EMPRESA, 'p', undefined);
    assert.equal(ok.consultas.some((c) => /^(DELETE|INSERT|UPDATE)/.test(c.sql)), false, 'campo omitido não escreve');
  }

  const fonte = readFileSync('lib/agenda/configuracao-unidade.ts', 'utf8');
  const lista = fonte.slice(fonte.indexOf('export async function saloesDaEmpresa'));
  assert.match(lista, /WHERE s\.empresa_id = \$1::uuid AND s\.ativo AND \$\{SALAO_DE_AGENDA_POR_SALAO\}/);
});

test('pacote novo sem salões conta como nenhum; duplicar/revisar copiam os salões; a rota antiga "criar" segue a regra', () => {
  const comercial = readFileSync('lib/comercial/pacote-comercial.ts', 'utf8').replace(/\r\n/g, '\n');
  assert.match(comercial, /definirSaloesPacote\(tx, ctx\.empresaId, pacote\.id, input\.saloes \?\? \(input\.id \? undefined : \[\]\)\)/);
  const admin = readFileSync('lib/comercial/pacotes-admin.ts', 'utf8');
  const clone = admin.slice(admin.indexOf('async function clonarAgregadoPacote'));
  assert.match(clone, /INSERT INTO pacote_saloes \(pacote_id, salao_id\) SELECT \$1::uuid, salao_id FROM pacote_saloes WHERE pacote_id = \$2::uuid/);
  assert.match(admin, /await clonarAgregadoPacote\(tx, origem\.id, criado\.id\);/, 'duplicar');
  assert.match(admin, /await clonarAgregadoPacote\(tx, id, novaId\);/, 'revisar');
  // Pareceres do Astra (delta 3): a guarda fica no domínio de pacotes — duplicar, editar, revisar e ativar (tela, IA, importação).
  const n = admin.replace(/\r\n/g, '\n');
  assert.match(n, /await clonarAgregadoPacote\(tx, origem\.id, criado\.id\);\n\s*await exigirSalaoNaAgendaPorSalao\(tx, ctx\.empresaId, criado\.id\);/, 'duplicar');
  assert.match(n, /recusar\("CONFLITO", "A revisão vigente mudou durante a edição\.", 409\);\n\s*await exigirSalaoNaAgendaPorSalao\(tx, ctx\.empresaId, id\);/, 'editar');
  assert.match(n, /await preservarPrecosDaRevisao\(tx, ctx, id, criada\.novaId\);\n\s*await exigirSalaoNaAgendaPorSalao\(tx, ctx\.empresaId, criada\.novaId\);\n\s*return promoverRevisaoPacoteAdmin\(/, 'revisar: confere a sucessora antes de promover');
  assert.match(n, /if \(situacao === "ativar"\) await exigirSalaoNaAgendaPorSalao\(tx, ctx\.empresaId, id\);/, 'ativar (desativar/arquivar livres)');
  // Salvar: salões informados entram antes da edição (corrigir legado no mesmo salvar).
  assert.match(comercial, /if \(input\.saloes !== undefined\) await definirSaloesPacote\(tx, ctx\.empresaId, input\.id, input\.saloes\);\n\s*pacote = await editarPacoteNaoUtilizado\(/);
  const rota = readFileSync('app/api/admin/configuracoes/pacotes/route.ts', 'utf8').replace(/\r\n/g, '\n');
  assert.match(rota, /const criado = await criarPacoteAdmin\([^)]*\);\s*\/\/[^\n]*\n\s*await definirSaloesPacote\(tx, tenant\.empresaComprovada, criado\.id, \[\]\);/);
});

test('"Revisar e confirmar" de pacote antigo sem salão pede o salão e não esconde o formulário', () => {
  function Botao(props: { children?: unknown }) { return props.children; }
  function Vazio() { return null; }
  const tela = carregarComponente('components/admin/PacotesAdmin.tsx', {
    '@/lib/http/admin-fetch': { adminFetch: async () => Response.json({ ok: true, data: {} }) },
    './workspace.module.css': cssFalso, './visual.module.css': cssFalso, './catalogo-editor.module.css': cssFalso,
    './DurationField': { DurationField: Vazio }, '@/lib/comercial/duracao': duracao, './AjudaCampo': { AjudaCampo: Vazio },
    './AdminPrimaryButton': { AdminPrimaryButton: Botao }, './ConfirmarPrecosPacote': { ConfirmarPrecosPacote: Vazio },
    './SaloesCombinados': { AVISO_COMBINADO: '' }, '@/lib/agenda/saloes-liberacao': liberacao,
    './PrecosPorQuantidade': { erroDosPontos: () => null, PrecosPorQuantidade: Vazio, pontosDaTela: () => [], valorDigitado: (v: unknown) => String(v) },
  });
  const pacote = { id: 'p1', nome: 'Festa antiga', descricao: null, duracaoMinutos: 240, convidadosMinimos: 50, convidadosMaximos: 100, diasPermitidos: [6], ativo: true, arquivadoEm: null };
  const vitrine = {
    pacotes: [pacote], horarios: [], categorias: [], saloes: [{ id: 'S1', nome: 'Salão 1', unidade: null }, { id: 'S2', nome: 'Salão 2', unidade: null }],
    edicao: { pacote, disponibilidade: [], categorias: [], saloes: [],
      faixas: { editavel: true, aConfirmar: true, faixas: [{ convidadosMin: 50, convidadosMax: 100, valor: '5000' }], proposta: [] } },
  };
  let arvore = tela.render('default', { vitrine });
  (achar(arvore, Botao, 'Revisar e confirmar').props.onClick as () => void)();
  arvore = tela.render('default', { vitrine });
  assert.match(texto(arvore), /Escolha o salão ou os salões deste pacote\./);
  assert.equal(elementos(arvore).some((e) => e.type === Vazio && 'faixas' in e.props && 'proposta' in e.props), false, 'confirmação não abriu');
  assert.equal(elementos(arvore).find((e) => e.type === 'form')?.props.hidden, false, 'o seletor de salões continua visível');
  // Escolhido o salão, a confirmação abre.
  (achar(arvore, 'button', 'Salão 1').props.onClick as () => void)();
  arvore = tela.render('default', { vitrine });
  (achar(arvore, Botao, 'Revisar e confirmar').props.onClick as () => void)();
  arvore = tela.render('default', { vitrine });
  assert.doesNotMatch(texto(arvore), /Escolha o salão ou os salões deste pacote\./);
  assert.equal(elementos(arvore).find((e) => e.type === 'form')?.props.hidden, true, 'formulário escondido: confirmação aberta');
});
