import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { adicionais, ancora, comercial, planos, precoExibido, recursos, statusDosRecursos, valorPlano, type RecursoId } from './catalogo.ts';
import { configuracaoSite, linkWhatsApp, CADASTRO_FECHADO } from './configuracao.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

const semBanco = { db: () => { throw new Error('teste não acessa banco'); }, withTransaction: () => { throw new Error('teste não acessa banco'); } };
const dubles = { 'components/site/estilos': { cx: (...nomes: string[]) => nomes.join(' ') }, 'components/site/fonte': { fonteTexto: { variable: 'texto' }, fonteTitulo: { variable: 'titulo' } }, 'lib/db/postgres': semBanco };
function componente(nome: string, exportado: string) { return carregarModulo(nome, dubles, new Map())[exportado] as ComponentType<Record<string, unknown>>; }
const Recurso = componente('components/site/elementos.tsx', 'Recurso');
const Cadastro = componente('components/site/elementos.tsx', 'Cadastro');
const Contato = componente('components/site/elementos.tsx', 'Contato');
const Rodape = componente('components/site/Site.tsx', 'Rodape');
const Planos = componente('components/site/Planos.tsx', 'default');

test('catálogo: status obrigatório; cada recurso futuro renderiza selo, inclusive em grupos', () => {
    const futuros: RecursoId[] = ['walle_whatsapp','walle_publicitario','cartao','convite','assinatura_whatsapp','copiloto','importacao_contratos','importacao_precos'];
    for (const [id, recurso] of Object.entries(recursos)) {
        assert.ok(['disponivel', 'em_breve'].includes(recurso.status));
        assert.ok(recurso.evidencia.length > 20);
        const html = renderToStaticMarkup(createElement(Recurso, { ids: [id] }, recurso.nome));
        assert.equal(html.includes('Em breve'), recurso.status === 'em_breve');
    }
    for (const id of futuros) assert.equal(recursos[id].status, 'em_breve');
    assert.equal(statusDosRecursos(['pix', 'cartao']), 'em_breve');
});
test('preços: anual 10 vezes o mensal, Fundador exatamente 60%, centavos preservados', () => {
    assert.deepEqual(planos.map(p => p.mensalCentavos), [19700, 34700, 59700]);
    for (const plano of planos) {
        assert.equal(valorPlano(plano, 'anual'), plano.mensalCentavos * 10);
        assert.equal(valorPlano(plano, 'mensal', true), Math.round(plano.mensalCentavos * .6));
        assert.equal(valorPlano(plano, 'anual', true), Math.round(plano.mensalCentavos * 10 * .6));
    }
    assert.equal(valorPlano(planos[0], 'mensal', true), 11820);
    assert.equal(ancora.reduce((total, item) => total + item.centavos, 0), 70200);
    assert.equal(comercial.testeDias, 15);
});
test('sem flag: planos e adicionais não exibem preço nem âncora monetária', () => {
    for (const valor of [...planos.map(p => p.mensalCentavos), ...adicionais.map(a => a.centavos)]) assert.equal(precoExibido(valor, false), 'Preço a definir');
    assert.equal(configuracaoSite({ SITE_PRECOS_PUBLICADOS: 'false' }).precosPublicados, false);
    assert.equal(configuracaoSite({ SITE_PRECOS_PUBLICADOS: 'true' }).precosPublicados, true);
    const html = renderToStaticMarkup(createElement(Planos, { publicado: false, aberto: false, contato: configuracaoSite({}) }));
    assert.match(html, /Preço a definir/); assert.doesNotMatch(html, /R\$/);
    const publicado = renderToStaticMarkup(createElement(Planos, { publicado: true, aberto: true, contato: configuracaoSite({}) }));
    assert.match(publicado, /118,20/); assert.match(publicado, /702/); assert.equal((publicado.match(/href="\/cadastro"/g) || []).length, 3);
});
test('rodapé sem configuração: lacunas explícitas e links para seções legais', () => {
    const config = configuracaoSite({});
    for (const chave of ['razaoSocial','cnpj','endereco','email','whatsapp','horario','encarregado'] as const) assert.equal(config[chave], 'a definir');
    const html = renderToStaticMarkup(createElement(Rodape, { config }));
    assert.equal((html.match(/a definir/g) || []).length, 7);
    assert.match(html, /\/termos#cancelamento/); assert.match(html, /\/privacidade#tratamento-de-dados/);
});
test('WhatsApp só existe com número configurado e mensagem codificada', () => {
    for (const numero of [undefined, '', 'a definir', '123', 'javascript:1234567890']) assert.equal(linkWhatsApp(numero, 'Olá'), null);
    assert.equal(linkWhatsApp('+55 (11) 99999-0000', 'Olá & bem-vindo'), 'https://wa.me/5511999990000?text=Ol%C3%A1%20%26%20bem-vindo');
    assert.equal(renderToStaticMarkup(createElement(Contato, { config: configuracaoSite({}) })), '');
    assert.equal(renderToStaticMarkup(createElement(Contato, { config: configuracaoSite({}), fundador: true, flutuante: true })), '');
    const config = configuracaoSite({ SITE_ATENDIMENTO_WHATSAPP: '+55 (11) 99999-0000' });
    assert.notEqual(config.contato, config.fundador);
    assert.match(renderToStaticMarkup(createElement(Contato, { config })), /noopener noreferrer/);
});
test('cadastro fechado não expõe CTA; aberto mantém /cadastro', () => {
    const fechado = renderToStaticMarkup(createElement(Cadastro, { aberto: false }));
    assert.ok(fechado.includes(CADASTRO_FECHADO)); assert.doesNotMatch(fechado, /href=/);
    assert.match(renderToStaticMarkup(createElement(Cadastro, { aberto: true })), /href="\/cadastro"/);
});
