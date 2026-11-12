import test from 'node:test';
import assert from 'node:assert/strict';
import * as liberacao from '../../lib/agenda/saloes-liberacao.ts';
import { carregarComponente, cssFalso, elementos, texto, tique } from './teste-componente.ts';

/**
 * S-A (102): a Agenda cadastra nome, capacidade e horários dos salões; fotos, itens e declaração ficam em
 * Configurações › Salões. A seção "Salões e limites" leva até lá nos dois tipos de agenda e, com alterações não
 * salvas, avisa para salvar antes de sair (o link não descarta nada sozinho, mas a navegação perde o rascunho).
 */
const horario = { id: '00000000-0000-4000-8000-000000000081', codigo: 'TURNO_1', nome: 'Tarde', inicio: '14:00', fim: '18:00', dias: [1, 2, 3, 4, 5, 6, 7],
  capacidade: 1, desativadoAPartirDe: null, saloes: [], herdado: false, festasFuturas: { quantidade: 0, proxima: null, ultima: null } };
const agendaDe = (capacidadeTipo: 'POR_HORARIO' | 'POR_SALAO') => ({
  escopo: { estabelecimentoId: null, nome: 'Buffet', configurado: true },
  config: { modo: 'FIXO', capacidadeTipo, limiteFestasDia: null, intervaloMinimoMinutos: 0, configuradoPor: 'Ana', configuradoEm: '2026-10-26T15:00:00Z' },
  saloes: capacidadeTipo === 'POR_SALAO' ? [{ id: 'S1', nome: 'Salão 1', capacidadeConvidados: 80 }, { id: 'S2', nome: 'Salão 2', capacidadeConvidados: 60 }] : [],
  combinados: [], combinadosDisponiveis: false, versaoAgenda: `va1:${'0'.repeat(64)}`,
  horarios: [{ ...horario, saloes: capacidadeTipo === 'POR_SALAO' ? ['S1', 'S2'] : [] }],
});

function Botao(props: { children?: unknown }) { return props.children; }

async function telaCarregada(agenda: ReturnType<typeof agendaDe>, vitrine = false) {
  const dados = { instalada: true, gestao: true, escopos: [agenda.escopo], agenda };
  const adminFetch = async () => Response.json({ ok: true, data: dados });
  const base = { 'next/link': { default: (p: { children?: unknown }) => p.children }, '@/lib/http/admin-fetch': { adminFetch }, './AdminPrimaryButton': { AdminPrimaryButton: Botao }, '@/lib/agenda/saloes-liberacao': liberacao,
    './agenda-configuracao.module.css': cssFalso, './workspace.module.css': cssFalso };
  const assistente = carregarComponente('components/admin/AssistenteAgenda.tsx', base);
  const combinados = carregarComponente('components/admin/SaloesCombinados.tsx', base);
  const tela = carregarComponente('components/admin/AgendaConfiguracao.tsx', { ...base, './AssistenteAgenda': assistente.modulo, './SaloesCombinados': combinados.modulo });
  // Na vitrine (prévia do assistente) os dados vêm por props e nada é buscado.
  const props = vitrine ? { vitrine: { dados } } : {};
  const render = () => tela.render('default', props);
  render();
  tela.efeitos();
  await tique();
  await tique();
  return { render };
}

const linkSaloes = (arvore: unknown) => elementos(arvore).filter((e) => e.props.href === '/admin/configuracoes/saloes');
const paragrafo = (arvore: unknown) => elementos(arvore).find((e) => e.props['data-link-apresentacao-saloes'] !== undefined);

for (const tipo of ['POR_HORARIO', 'POR_SALAO'] as const) {
  test(`Agenda (${tipo}): a seção de salões leva à Apresentação dos salões`, async () => {
    const arvore = (await telaCarregada(agendaDe(tipo))).render();
    const links = linkSaloes(arvore);
    assert.equal(links.length, 1);
    assert.match(texto(links[0]), /Apresentação dos salões/);
    assert.doesNotMatch(texto(paragrafo(arvore)), /Salve as alterações/, 'sem rascunho, sem aviso');
  });
}

test('Agenda com alteração não salva: o link avisa para salvar antes de sair', async () => {
  const tela = await telaCarregada(agendaDe('POR_HORARIO'));
  const limite = elementos(tela.render()).find((e) => e.type === 'input' && e.props.placeholder === 'Sem limite');
  assert.ok(limite, 'campo de limite');
  (limite.props.onChange as (e: unknown) => void)({ target: { value: '3' } });
  const arvore = tela.render();
  assert.equal(linkSaloes(arvore).length, 1);
  assert.match(texto(paragrafo(arvore)), /Salve as alterações antes de sair desta tela\./);
});

test('Agenda na vitrine (prévia do assistente): sem o link para a Apresentação dos salões', async () => {
  const arvore = (await telaCarregada(agendaDe('POR_SALAO'), true)).render();
  assert.match(texto(arvore), /Salões e limites/, 'a seção aparece na vitrine');
  assert.equal(linkSaloes(arvore).length, 0);
  assert.equal(paragrafo(arvore), undefined);
});
