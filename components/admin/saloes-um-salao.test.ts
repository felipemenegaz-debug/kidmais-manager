import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as paginaPublica from './saloes-pagina-publica.ts';
import { carregarComponente, cssFalso, elementos, texto, tique } from './teste-componente.ts';

/**
 * Configurações › Salões com a agenda de um salão (D-LIB-1, AGENDA_MAIS_DE_UM_SALAO desligada): a Agenda não mostra
 * cadastro de salões, então a tela não manda o usuário para lá. Achado de Felipe na conferência de production (12/11/2026).
 */
const TEXTO_UM_SALAO = 'Sua agenda funciona com um salão só. O cadastro de mais de um salão ainda não está disponível.';
const salao = { id: 'S1', nome: 'Salão 1', unidade: null, capacidadeConvidados: 80, fotos: 2, pronto: true, pendencias: 0 };

async function tela(extra: Record<string, unknown>) {
  const dados = { instalacao: 'COMPLETA', gestao: true, paginaPublica: false, saloes: [], ...extra };
  const adminFetch = async () => Response.json({ ok: true, data: dados });
  const ler = async (r: Response) => r.json();
  const componente = carregarComponente('components/admin/SaloesApresentacaoLista.tsx', {
    'next/link': { default: (p: { children?: unknown }) => p.children },
    '@/lib/http/admin-fetch': { adminFetch },
    './AssistenteAgenda': { ler },
    './saloes-pagina-publica': paginaPublica,
    './salao-apresentacao.module.css': cssFalso,
    './workspace.module.css': cssFalso,
  });
  componente.render('default', {});
  componente.efeitos();
  await tique();
  await tique();
  return componente.render('default', {});
}

const linksAgenda = (arvore: unknown) => elementos(arvore).filter((e) => e.props.href === '/admin/configuracoes/agenda');

test('um salão, cadastro desligado e sem salões: explica e não aponta para a Agenda', async () => {
  const arvore = await tela({ cadastroNaAgenda: false });
  assert.match(texto(arvore), new RegExp(TEXTO_UM_SALAO.replace(/\./g, '\\.')));
  assert.doesNotMatch(texto(arvore), /Cadastre os salões|salões novos são cadastrados/);
  assert.equal(linksAgenda(arvore).length, 0);
});

test('cadastro ligado e sem salões: continua mandando cadastrar na Agenda', async () => {
  const arvore = await tela({ cadastroNaAgenda: true });
  assert.match(texto(arvore), /Nenhum salão cadastrado\. Cadastre os salões em/);
  assert.doesNotMatch(texto(arvore), /funciona com um salão só/);
  assert.equal(linksAgenda(arvore).length, 2);
});

test('servidor antigo (sem o campo): comportamento anterior, sem o texto novo', async () => {
  const arvore = await tela({});
  assert.match(texto(arvore), /Cadastre os salões em/);
  assert.doesNotMatch(texto(arvore), /funciona com um salão só/);
});

test('com salões: lista e mantém o caminho para a Agenda', async () => {
  const arvore = await tela({ cadastroNaAgenda: true, saloes: [salao] });
  assert.match(texto(arvore), /Salão 1/);
  assert.match(texto(arvore), /salões novos são cadastrados em/);
  assert.doesNotMatch(texto(arvore), /funciona com um salão só/);
});

test('rota: cadastroNaAgenda vem da liberação do servidor ou de salões já cadastrados', () => {
  const rota = readFileSync('app/api/admin/configuracoes/saloes/route.ts', 'utf8');
  assert.match(rota, /from "@\/lib\/agenda\/saloes-liberacao-servidor"/);
  assert.match(rota, /cadastroNaAgenda: maisDeUmSalaoLiberado\(\) \|\| saloes\.length > 0/);
  assert.doesNotMatch(rota, /AGENDA_MAIS_DE_UM_SALAO\s*[:=]/, 'nenhum valor de env devolvido além do booleano');
});
