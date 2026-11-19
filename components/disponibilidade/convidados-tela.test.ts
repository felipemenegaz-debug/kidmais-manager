import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { legendaMinimo, minimoDoDia, convidadosDaUrl, datasProximas, estadoDoDia, linkContatoBuffet, resumoSemanal, whatsappComMensagem, textoCapacidade } from './convidados-tela.ts';
import { precoDoMinimo } from '../../lib/comercial/oferta-intervalo.ts';
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
    assert.match(com, /1 pacote indisponível para.*80.*convidados/);
    assert.match(com, /Ver outros pacotes/);
    const escolhido = render({ convidados: 80, naoComporta, selecionado: 'PEQ' });
    assert.ok(escolhido.indexOf('Grande sintético') < escolhido.indexOf('Pequeno sintético'), 'o escolhido aparece, depois dos que comportam');
    assert.match(escolhido, /packageFaded/);
    assert.doesNotMatch(escolhido, /disabled/);
    assert.match(render({ convidados: 80, naoComporta, selecionado: "PEQ", veioDaDisponibilidade: true }), /disabled/);
    assert.match(escolhido, /atende até 60/);
    const nenhum = render({ convidados: 130, naoComporta: (id: string) => motivoNaoComporta(false, PACOTES_FECHAMENTO_V1, DOIS, id, 130) });
    assert.match(nenhum, /Nenhum pacote disponível para 130 convidados/);
    assert.match(nenhum, /2 pacotes indisponíveis para/);
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

test('Pacotes e preços desde a abertura: antes dos convidados e depois, só pela instalação', () => {
    const fonte = readFileSync('components/disponibilidade/DisponibilidadePublica.tsx', 'utf8');
    const ocorrencias = fonte.match(/<PacotesPdf \/>/g) ?? [];
    assert.equal(ocorrencias.length, 2, 'um lugar antes e outro depois dos convidados');
    const antes = fonte.indexOf('{!convidados && !empresa ? <div className={styles.pacotesAntes}><PacotesPdf /></div> : null}');
    const fimCartao = fonte.indexOf('aria-labelledby="convidados-titulo"');
    const agenda = fonte.search(/\{convidados \? \(\r?\n\s*<section className=\{styles\.card\}>/);
    assert.ok(antes > fimCartao && agenda > antes, 'logo depois do cartão de convidados e antes da agenda');
    assert.match(fonte, /\{!empresa && <PacotesPdf \/>\}/, 'endereço de outra empresa continua sem o PDF');
});

test('Pizza Party: frase, valor inicial e limites do campo usam a faixa publicada ou a reserva 20–100', () => {
    const Painel = carregarModulo('components/fechamento/AdicionaisPizzaConsulta.tsx', { './FechamentoWizard.module.css': estilos, 'components/fechamento/FechamentoWizard.module.css': estilos }, new Map()).default as ComponentType<Record<string, unknown>>;
    for (const [props, min, max] of [[{ limites: { minimo: 1, maximo: 50 } }, 1, 50], [{}, 20, 100]] as const) {
        const html = renderToStaticMarkup(createElement(Painel, props));
        assert.ok(html.includes(`mínimo de ${min} e máximo de ${max} convidados`));
        assert.match(html, new RegExp(`type="number" min="${min}" max="${max}"[^>]*value="${min}"`));
    }
});

test("WhatsApp preserva o telefone e substitui o texto anterior", () => {
  const url = new URL(whatsappComMensagem("https://api.whatsapp.com/send?phone=5511999999999&text=oi", "28/11 para 30 convidados")!);
  assert.equal(url.searchParams.get("phone"), "5511999999999");
  assert.deepEqual(url.searchParams.getAll("text"), ["28/11 para 30 convidados"]);
});

test("WhatsApp inválido não oferece link", () => {
    for (const valor of ["", "sem endereço", "javascript:void(0)"]) assert.equal(whatsappComMensagem(valor, "Olá"), null);
});

test("resumo de dias úteis só aparece quando a oferta se repete no intervalo", () => {
  const dias = Array.from({length:14}, (_, i) => {
    const data = "2026-11-" + String(i+1).padStart(2,"0");
    const dia = i%7;
    const periodo = {configuracaoId:"a",codigo:"TURNO_1",nome:"Almoço",horarioInicioPadrao:"12:00",horarioFimPadrao:"15:00",status:"DISPONIVEL" as const,horarios:[]};
    return {data,periodos: dia > 0 && dia < 6 ? [periodo] : []};
  });
  assert.match(resumoSemanal(dias,30) ?? "",/30 convidados.*segunda a sexta.*Almoço/);
  dias[1].periodos = [];
  assert.equal(resumoSemanal(dias,30),null);
});

test('D-FP-6: só marca o dia se todos os períodos vendáveis exigirem mínimo', () => {
    const sabado = dia('2026-11-28', ['DISPONIVEL', 'DISPONIVEL', 'INDISPONIVEL']);
    sabado.periodos[0].minimoFaturavel = 50;
    assert.equal(estadoDoDia(sabado), 'PARCIAL');
    sabado.periodos[1].minimoFaturavel = 70;
    assert.equal(estadoDoDia(sabado), 'MINIMO');
    assert.equal(minimoDoDia(sabado), 50);
    const quinta = dia('2026-11-26', ['DISPONIVEL']);
    assert.equal(legendaMinimo([quinta], 30), null);
    assert.equal(legendaMinimo([quinta, sabado], 30), 'Mínimo de 50 convidados');
    quinta.periodos[0].minimoFaturavel = 40;
    assert.equal(legendaMinimo([quinta, sabado], 30), 'Cobrança mínima acima de 30 convidados');
    const mista = dia('2026-12-01', ['DISPONIVEL', 'DISPONIVEL']);
    mista.periodos[0].minimoFaturavel = 80;
    assert.equal(estadoDoDia(mista), 'DISPONIVEL');
    assert.deepEqual(datasProximas({ sabado, quinta, mista }, sabado.data, '2026-11-19', 3, undefined, true), [mista.data]);
});

test('D-FP-6: preço da cobrança mínima considera categoria, faixa, preço por convidado e pontos', () => {
    const geral = { exata: false, tipo: 'FIXO', min: 1, max: 100, valor: '1200.00' };
    const propria = { ...geral, exata: true, tipo: 'POR_CONVIDADO', valor: '40.19' };
    assert.equal(precoDoMinimo([geral, propria], 50), 2009.5);
    assert.equal(precoDoMinimo([geral, { ...propria, min: 51 }], 50), 1200);
    const pontos = [40, 60].map(min => ({ ...propria, tipo: 'PONTO', min, valor: String(min * 30) }));
    assert.equal(precoDoMinimo([geral, ...pontos], 50), 1500);
    assert.equal(precoDoMinimo(pontos, 20), null);
});

test('D-FP-6: cartão público abaixo do mínimo oferece o preço da seleção e continua selecionável', () => {
    const fatos: FatosPacote = { POCKET: { nome: 'Festa', descricao: null, duracaoMinutos: 240,
        convidadosMinimos: 50, convidadosMaximos: 150, precoMinimo: '800.00', precoNoMinimo: 2400 } };
    for (const kidmais of [true, false]) {
        const itens = pacotesExibidos(kidmais, PACOTES_FECHAMENTO_V1.filter(p => p.id === 'pocket'), fatos);
        const render = (convidados: number, publico: boolean) => renderToStaticMarkup(createElement(EscolhaPacote, {
            itens, convidados, veioDaDisponibilidade: publico, selecionado: '', onEscolher: nada, onTentarNovamente: nada,
        }));
        const html = render(30, true);
        assert.match(html, /2\.400,00/);
        assert.match(html, /Preço de tabela para 50 convidados\. Descontos do dia aparecem na próxima etapa\./);
        assert.doesNotMatch(html, /disabled|packageFaded|800,00/);
        assert.doesNotMatch(render(50, true), /Descontos do dia aparecem na próxima etapa/);
        assert.doesNotMatch(render(30, false), /Descontos do dia aparecem na próxima etapa/);
    }
});
