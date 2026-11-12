import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { textoFundador } from './fundador.ts';
import { prazoAnunciado, janelaCalculada } from '../assinatura/campanha.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { configuracaoSite } from './configuracao.ts';

const semBanco = { db: () => { throw new Error('teste não acessa banco'); }, withTransaction: () => { throw new Error('teste não acessa banco'); } };
const dubles = { 'components/site/estilos': { cx: (...nomes: string[]) => nomes.join(' ') }, 'components/site/fonte': { fonteTexto: { variable: 'texto' }, fonteTitulo: { variable: 'titulo' } }, 'lib/db/postgres': semBanco };
const componente = (arquivo: string, nome: string) => carregarModulo(arquivo, dubles, new Map())[nome] as ComponentType<Record<string, unknown>>;
const Planos = componente('components/site/Planos.tsx', 'default');
const Duvidas = componente('components/site/secoes.tsx', 'Duvidas');
const prazo = prazoAnunciado({ contagem: 'CALENDARIO_LOCAL', janelaFim: janelaCalculada('CALENDARIO_LOCAL', { data: '2026-11-01' }).janelaFim });
const DATA = /\d{2}\/\d{2}\/\d{4}/;

test('sem campanha ativada: regra anterior (20 primeiros), sem data', () => {
    const t = textoFundador({ fase: 'LEGADO' });
    assert.match(t.titulo, /20 vagas/); assert.doesNotMatch(Object.values(t).join(' '), DATA);
});

test('desligada, antes da abertura, sem leitura do banco: nem prazo nem estoque', () => {
    for (const r of [{ fase: 'DESLIGADA' as const }, { fase: 'ANTES' as const, inicio: '2026-11-01T03:00:00.000Z' }, null]) {
        const tudo = Object.values(textoFundador(r)).join(' ');
        assert.doesNotMatch(tudo, DATA); assert.doesNotMatch(tudo, /\b20\b|restam|vagas para/i); assert.match(tudo, /40%/);
    }
});

test('janela: prazo do banco com fuso por extenso, sem teto; explica o que é assinar', () => {
    const t = textoFundador({ fase: 'JANELA', prazo });
    assert.match(t.barra, /até 30\/11\/2026, 23h59 \(horário de Brasília\)/);
    assert.match(t.descricao, /sem limite de vagas até o prazo/); assert.match(t.descricao, /Assinar é confirmar/);
    assert.match(t.faq, /mais 20 buffets/);
});

test('lote posterior: vagas reais, em confirmação ou encerrado', () => {
    assert.match(textoFundador({ fase: 'POS_JANELA', vagasRestantes: 3, emConfirmacao: 2, limite: 20 }).titulo, /restam 3 vagas/);
    const conf = textoFundador({ fase: 'POS_JANELA', vagasRestantes: 0, emConfirmacao: 4, limite: 20 });
    assert.match(conf.titulo, /em confirmação/); assert.equal(conf.cta, null);
    for (const r of [{ fase: 'POS_JANELA' as const, vagasRestantes: 0, emConfirmacao: 0, limite: 20 }, { fase: 'ENCERRADA' as const }])
        assert.match(textoFundador(r).titulo, /encerrado/);
});

test('cartões e FAQ do site usam o mesmo texto; sem prop mantêm a regra anterior', () => {
    const config = configuracaoSite({});
    const janela = textoFundador({ fase: 'JANELA', prazo });
    assert.match(renderToStaticMarkup(createElement(Planos, { publicado: false, aberto: false, contato: config, fundador: janela })), /até 30\/11\/2026, 23h59/);
    assert.match(renderToStaticMarkup(createElement(Duvidas, { config, fundador: janela })), /mais 20 buffets/);
    assert.match(renderToStaticMarkup(createElement(Planos, { publicado: false, aberto: false, contato: config })), /20 vagas para os primeiros/);
});
