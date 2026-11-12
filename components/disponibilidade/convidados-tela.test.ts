import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { convidadosDaUrl, datasProximas, estadoDoDia, linkContatoBuffet, textoCapacidade } from './convidados-tela.ts';
import { motivoNaoComporta, pacotesExibidos, separarPorConvidados, type FatosPacote } from '../fechamento/pacotes-tela.ts';
import { PACOTES_FECHAMENTO_V1 } from '../fechamento/data.ts';
import { convidadosDaConsulta, pacoteComporta } from '../../lib/fechamentos/convidados-consulta.ts';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';
import type { DisponibilidadeDataPublica, PeriodoDisponibilidadePublica } from '../../lib/disponibilidade/services/models.ts';

// Classes do CSS module viram o próprio nome (__esModule falso: o import default recebe o próprio Proxy).
const estilos = new Proxy({}, { get: (_alvo, nome) => (nome === '__esModule' ? false : String(nome)) });
const EscolhaPacote = carregarModulo('components/fechamento/EscolhaPacote.tsx', { 'components/fechamento/FechamentoWizard.module.css': estilos }, new Map())
    .default as ComponentType<Record<string, unknown>>;
const nada = () => undefined;

const periodo = (status: 'DISPONIVEL' | 'INDISPONIVEL'): PeriodoDisponibilidadePublica =>
    ({ configuracaoId: 'c', codigo: 'TURNO_1', nome: 'Tarde', horarioInicioPadrao: '15:00', horarioFimPadrao: '19:00', status, horarios: [] });
const dia = (data: string, status: Array<'DISPONIVEL' | 'INDISPONIVEL'>, motivoDia?: DisponibilidadeDataPublica['motivoDia']): DisponibilidadeDataPublica =>
    ({ data, periodos: status.map(periodo), ...(motivoDia ? { motivoDia } : {}) });

test('S-C: parâmetro convidados das leituras públicas', () => {
    assert.equal(convidadosDaConsulta(null), undefined, 'ausente = resposta de antes');
    for (const invalido of ['', '0', '1001', 'abc', '8.5', '-3', '1e2', ' ']) assert.equal(convidadosDaConsulta(invalido), null, invalido);
    assert.equal(convidadosDaConsulta('1'), 1);
    assert.equal(convidadosDaConsulta(' 80 '), 80);
    assert.equal(convidadosDaConsulta('1000'), 1000);
});

test('S-C: pacote comporta N (limites nulos abertos)', () => {
    assert.equal(pacoteComporta({ convidadosMinimos: 20, convidadosMaximos: 60 }, 60), true);
    assert.equal(pacoteComporta({ convidadosMinimos: 20, convidadosMaximos: 60 }, 61), false);
    assert.equal(pacoteComporta({ convidadosMinimos: 20, convidadosMaximos: 60 }, 19), false);
    assert.equal(pacoteComporta({ convidadosMinimos: null, convidadosMaximos: null }, 999), true);
});

test('S-C: estado do dia distingue "sem salão" de ocupado', () => {
    assert.equal(estadoDoDia(undefined), 'NEUTRO');
    assert.equal(estadoDoDia(dia('2026-11-01', ['DISPONIVEL', 'DISPONIVEL'])), 'DISPONIVEL');
    assert.equal(estadoDoDia(dia('2026-11-01', ['DISPONIVEL', 'INDISPONIVEL'])), 'PARCIAL');
    assert.equal(estadoDoDia(dia('2026-11-01', ['INDISPONIVEL'])), 'INDISPONIVEL', 'sem motivo (antes da S-C)');
    assert.equal(estadoDoDia(dia('2026-11-01', ['INDISPONIVEL'], { opcoes: 0, motivo: 'OCUPADO' })), 'INDISPONIVEL');
    assert.equal(estadoDoDia(dia('2026-11-01', ['INDISPONIVEL'], { opcoes: 0, motivo: 'CAPACIDADE' })), 'SEM_SALAO');
});

test('S-C: textos de opções', () => {
    assert.equal(textoCapacidade(undefined, 80), null);
    assert.equal(textoCapacidade({ opcoes: 2, motivo: 'OK' }, null), null);
    assert.equal(textoCapacidade({ opcoes: 2, motivo: 'OK' }, 80), '2 opções de salão');
    assert.equal(textoCapacidade({ opcoes: 1, motivo: 'OK' }, 80), 'Só 1 opção de salão');
    assert.equal(textoCapacidade({ opcoes: 0, motivo: 'CAPACIDADE' }, 80), 'Sem salão para 80');
    assert.equal(textoCapacidade({ opcoes: 0, motivo: 'OCUPADO' }, 80), 'Indisponível');
});

test('S-C: datas próximas — só livres, a partir de hoje, as 3 mais perto, em ordem', () => {
    const porData = Object.fromEntries([
        dia('2026-11-02', ['DISPONIVEL']), dia('2026-11-08', ['DISPONIVEL']), dia('2026-11-09', ['INDISPONIVEL']),
        dia('2026-11-10', ['INDISPONIVEL']), dia('2026-11-11', ['DISPONIVEL', 'INDISPONIVEL']), dia('2026-11-12', ['DISPONIVEL']),
        dia('2026-11-28', ['DISPONIVEL']),
    ].map((d) => [d.data, d]));
    assert.deepEqual(datasProximas(porData, '2026-11-10', '2026-11-05'), ['2026-11-08', '2026-11-11', '2026-11-12']);
    assert.deepEqual(datasProximas(porData, '2026-11-10', '2026-11-29'), [], 'passado não entra');
    assert.deepEqual(datasProximas({}, '2026-11-10', '2026-11-01'), []);
});

test('S-C: "falar com o buffet" usa só o contato publicado da empresa', () => {
    assert.equal(linkContatoBuffet(null), null);
    const vazio = { whatsapp: null, telefone: null, email: null, site: null, instagram: null };
    assert.equal(linkContatoBuffet(vazio), null);
    assert.equal(linkContatoBuffet({ ...vazio, email: 'a@b.co' }), 'mailto:a@b.co');
    assert.equal(linkContatoBuffet({ ...vazio, email: 'a@b.co', whatsapp: { texto: 'x', url: 'https://wa.me/5511999999999' } }), 'https://wa.me/5511999999999');
});

test('S-C: convidados da URL do fechamento (teto do pedido online)', () => {
    assert.equal(convidadosDaUrl(null), null);
    for (const invalido of ['0', '151', 'x', '8.5', '']) assert.equal(convidadosDaUrl(invalido), null, invalido);
    assert.equal(convidadosDaUrl('150'), 150);
    assert.equal(convidadosDaUrl('80'), 80);
});

const DOIS: FatosPacote = {
    PEQ: { nome: 'Pequeno sintético', descricao: null, duracaoMinutos: 180, convidadosMinimos: 10, convidadosMaximos: 60, precoMinimo: '1000.00' },
    GRD: { nome: 'Grande sintético', descricao: null, duracaoMinutos: 240, convidadosMinimos: 50, convidadosMaximos: 120, precoMinimo: '3000.00' },
};

test('S-C: motivo de não comportar segue a validação da etapa Convidados', () => {
    assert.equal(motivoNaoComporta(false, PACOTES_FECHAMENTO_V1, DOIS, 'GRD', 80), null);
    assert.match(motivoNaoComporta(false, PACOTES_FECHAMENTO_V1, DOIS, 'PEQ', 80) ?? '', /atende até 60/);
    assert.match(motivoNaoComporta(false, PACOTES_FECHAMENTO_V1, DOIS, 'GRD', 20) ?? '', /mínimo de 50/);
    assert.equal(motivoNaoComporta(false, PACOTES_FECHAMENTO_V1, null, 'GRD', 80), null, 'lista ainda não chegou: nada some');
    const itens = pacotesExibidos(false, PACOTES_FECHAMENTO_V1, DOIS)!;
    const { comportam, naoComportam } = separarPorConvidados(itens, (id) => motivoNaoComporta(false, PACOTES_FECHAMENTO_V1, DOIS, id, 80));
    assert.deepEqual(comportam.map((i) => i.id), ['GRD']);
    assert.deepEqual(naoComportam.map((i) => i.id), ['PEQ']);
});

test('S-C: lista de pacotes — comportam primeiro, contador e "ver mesmo assim"', () => {
    const itens = pacotesExibidos(false, PACOTES_FECHAMENTO_V1, DOIS)!;
    const naoComporta = (id: string) => motivoNaoComporta(false, PACOTES_FECHAMENTO_V1, DOIS, id, 80);
    const render = (props: Record<string, unknown>) =>
        renderToStaticMarkup(createElement(EscolhaPacote, { itens, falha: false, selecionado: '', onEscolher: nada, onTentarNovamente: nada, ...props }));
    const semConvidados = render({});
    assert.ok(semConvidados.indexOf('Pequeno sintético') < semConvidados.indexOf('Grande sintético'), 'sem convidados: ordem de antes');
    assert.doesNotMatch(semConvidados, /não comporta/);
    const com = render({ convidados: 80, naoComporta });
    assert.match(com, /Grande sintético/);
    assert.doesNotMatch(com, /Pequeno sintético/, 'o que não comporta fica atrás do botão');
    assert.match(com, /1 pacote não comporta.*80.*convidados/);
    assert.match(com, /Ver mesmo assim/);
    const escolhido = render({ convidados: 80, naoComporta, selecionado: 'PEQ' });
    assert.ok(escolhido.indexOf('Grande sintético') < escolhido.indexOf('Pequeno sintético'), 'o escolhido aparece, depois dos que comportam');
    assert.match(escolhido, /packageFaded/);
    assert.match(escolhido, /atende até 60/);
    const nenhum = render({ convidados: 130, naoComporta: (id: string) => motivoNaoComporta(false, PACOTES_FECHAMENTO_V1, DOIS, id, 130) });
    assert.match(nenhum, /Nenhum pacote comporta 130 convidados/);
    assert.match(nenhum, /2 pacotes não comportam/);
});

test('P3-R2: a consulta vai até o fim do mês seguinte (no máximo 62 dias) e as sugestões incluem esse mês', async () => {
    const { fimDoMesSeguinte, doMes } = await import('./convidados-tela.ts');
    assert.deepEqual(fimDoMesSeguinte(2026, 9), { ano: 2026, mes: 10, dia: 30 }, 'outubro → 30/11');
    assert.deepEqual(fimDoMesSeguinte(2026, 11), { ano: 2027, mes: 0, dia: 31 }, 'dezembro → 31/01 do ano seguinte');
    assert.deepEqual(fimDoMesSeguinte(2027, 0), { ano: 2027, mes: 1, dia: 28 }, 'janeiro → 28/02');
    for (let mes = 0; mes < 12; mes++) {
        const f = fimDoMesSeguinte(2026, mes);
        const dias = (Date.UTC(f.ano, f.mes, f.dia) - Date.UTC(2026, mes, 1)) / 86400000 + 1;
        assert.ok(dias <= 62, `mês ${mes + 1}: ${dias} dias`);
    }
    const porData = Object.fromEntries([dia('2026-10-30', ['INDISPONIVEL']), dia('2026-10-31', ['INDISPONIVEL']), dia('2026-11-01', ['DISPONIVEL']), dia('2026-11-03', ['DISPONIVEL'], { opcoes: 0, motivo: 'CAPACIDADE' })].map((d) => [d.data, d]));
    assert.deepEqual(datasProximas(porData, '2026-10-31', '2026-10-20'), ['2026-11-01', '2026-11-03'], 'fim do mês: vagas do seguinte aparecem');
    assert.deepEqual(doMes(porData, 2026, 9).map((d) => d.data), ['2026-10-30', '2026-10-31'], 'calendário e legenda só do mês visível');
});

test('P3-R2: a tela pede até o fim do mês seguinte', () => {
    const fonte = readFileSync('components/disponibilidade/DisponibilidadePublica.tsx', 'utf8');
    assert.match(fonte, /fimDoMesSeguinte\(ano, mes\)/);
    assert.match(fonte, /doMes\(porData, ano, mes\)\.some/);
});
