import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as liberacao from '../../lib/agenda/saloes-liberacao.ts';
import { itensNavegacao } from '../../lib/admin/navegacao.ts';
import { carregarComponente, cssFalso, elementos, tique } from './teste-componente.ts';

/**
 * 23/11/2026 (pedido de Felipe): a Pré-reserva saiu do menu de Configurações e virou seção da Agenda, porque a
 * pré-reserva bloqueia a agenda. A seção é só de Gestão (como a API) e não aparece na vitrine do assistente; a rota
 * antiga leva à seção; Perfil da empresa abre o grupo do menu.
 */
const agenda = {
  escopo: { estabelecimentoId: null, nome: 'Buffet', configurado: true },
  config: { modo: 'FIXO', capacidadeTipo: 'POR_HORARIO', limiteFestasDia: null, intervaloMinimoMinutos: 0, configuradoPor: 'Ana', configuradoEm: '2026-10-26T15:00:00Z' },
  saloes: [], combinados: [], combinadosDisponiveis: false, versaoAgenda: `va1:${'0'.repeat(64)}`,
  horarios: [{ id: '00000000-0000-4000-8000-000000000081', codigo: 'TURNO_1', nome: 'Tarde', inicio: '14:00', fim: '18:00', dias: [1, 2, 3, 4, 5, 6, 7],
    capacidade: 1, desativadoAPartirDe: null, saloes: [], herdado: false, festasFuturas: { quantidade: 0, proxima: null, ultima: null } }],
};

function Botao(props: { children?: unknown }) { return props.children; }
function PreReservaConfiguracao() { return null; }

async function arvoreDaAgenda(gestao: boolean, vitrine = false) {
  const dados = { instalada: true, gestao, escopos: [agenda.escopo], agenda };
  const base = { 'next/link': { default: (p: { children?: unknown }) => p.children }, '@/lib/http/admin-fetch': { adminFetch: async () => Response.json({ ok: true, data: dados }) },
    './AdminPrimaryButton': { AdminPrimaryButton: Botao }, '@/lib/agenda/saloes-liberacao': liberacao, './agenda-configuracao.module.css': cssFalso, './workspace.module.css': cssFalso };
  const assistente = carregarComponente('components/admin/AssistenteAgenda.tsx', base);
  const combinados = carregarComponente('components/admin/SaloesCombinados.tsx', base);
  const tela = carregarComponente('components/admin/AgendaConfiguracao.tsx', { ...base, './AssistenteAgenda': assistente.modulo, './SaloesCombinados': combinados.modulo, './PreReservaConfiguracao': { PreReservaConfiguracao } });
  const props = vitrine ? { vitrine: { dados } } : {};
  tela.render('default', props);
  tela.efeitos();
  await tique();
  await tique();
  return tela.render('default', props);
}

const temPreReserva = (arvore: unknown) => elementos(arvore).some((e) => e.type === PreReservaConfiguracao);

test('Agenda: a seção de pré-reserva aparece para Gestão', async () => {
  assert.equal(temPreReserva(await arvoreDaAgenda(true)), true);
});

test('Agenda: sem Gestão (só leitura), sem a seção de pré-reserva', async () => {
  assert.equal(temPreReserva(await arvoreDaAgenda(false)), false);
});

test('Agenda na vitrine do assistente: sem a seção de pré-reserva', async () => {
  assert.equal(temPreReserva(await arvoreDaAgenda(true, true)), false);
});

test('rota antiga da pré-reserva leva à seção da Agenda; menu sem Pré-reserva e com Perfil da empresa primeiro', () => {
  assert.match(readFileSync('app/admin/configuracoes/pre-reserva/page.tsx', 'utf8'), /redirect\('\/admin\/configuracoes\/agenda#pre-reserva'\)/);
  assert.match(readFileSync('components/admin/PreReservaConfiguracao.tsx', 'utf8'), /id="pre-reserva"/);
  const config = itensNavegacao({ gestaoEmpresa: true, plataforma: true }).filter((i) => i.grupo === 'Configurações');
  assert.equal(config[0].rotulo, 'Perfil da empresa');
  assert.equal(config.some((i) => /pre-reserva/.test(i.href) || i.rotulo === 'Pré-reserva'), false);
  const hub = readFileSync('app/admin/configuracoes/page.tsx', 'utf8');
  assert.doesNotMatch(hub, /route:'pre-reserva'/);
  assert.ok(hub.indexOf("route:'perfil-empresa'") < hub.indexOf("route:'origens'"));
  // As devoluções de pré-reserva continuam no Financeiro.
  assert.equal(itensNavegacao({ gestaoEmpresa: true, plataforma: false }).some((i) => i.href === '/admin/financeiro/devolucoes-pre-reserva'), true);
});
