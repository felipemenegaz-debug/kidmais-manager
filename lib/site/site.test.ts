import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { adicionais, ancora, ancoraExibivel, comercial, planos, precoExibido, recursos, statusDosRecursos, valorPlano, type RecursoId } from './catalogo.ts';
import { configuracaoSite, linkEmail, linkWhatsApp, CADASTRO_FECHADO } from './configuracao.ts';
import { robotsDaPlataforma, sitemapDaPlataforma } from './indexacao.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

const semBanco = { db: () => { throw new Error('teste não acessa banco'); }, withTransaction: () => { throw new Error('teste não acessa banco'); } };
const dubles = { 'components/site/estilos': { cx: (...nomes: string[]) => nomes.join(' ') }, 'components/site/fonte': { fonteTexto: { variable: 'texto' }, fonteTitulo: { variable: 'titulo' } }, 'lib/db/postgres': semBanco };
function componente(nome: string, exportado: string) { return carregarModulo(nome, dubles, new Map())[exportado] as ComponentType<Record<string, unknown>>; }
const Recurso = componente('components/site/elementos.tsx', 'Recurso');
const Cadastro = componente('components/site/elementos.tsx', 'Cadastro');
const Contato = componente('components/site/elementos.tsx', 'Contato');
const Rodape = componente('components/site/Site.tsx', 'Rodape');
const Planos = componente('components/site/Planos.tsx', 'default');
const metadataSiteDescricao = () => String((carregarModulo('lib/site/metadata.ts', { ...dubles, 'next': {} }, new Map()).metadataSite as () => { description: string })().description);

test('catálogo: status obrigatório; cada recurso futuro renderiza selo, inclusive em grupos', () => {
    const futuros: RecursoId[] = ['walle_whatsapp','cartao','convite','assinatura_whatsapp','copiloto','importacao_contratos','importacao_precos'];
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
    assert.deepEqual(planos.map(p => p.mensalCentavos), [19700, 39700, 69700]);
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
    assert.match(publicado, /118,20/); assert.equal((publicado.match(/href="\/cadastro"/g) || []).length, 3);
    // Âncora "se fosse comprar separado" usa itens Em breve (orçamento, IA, Wall-e): não aparece até todos estarem disponíveis.
    assert.equal(ancoraExibivel(ancora), false);
    assert.doesNotMatch(publicado, /Se fosse comprar separado/); assert.doesNotMatch(publicado, /702/);
    assert.equal(ancoraExibivel([{ recursos: ['agenda'] }, { recursos: ['pix'] }]), true);
});

test('vitrine honesta: nada indisponível sem selo; horário nobre em todos os planos; unidade extra e assinatura Em breve', () => {
    assert.equal(recursos.multiunidade.status, 'em_breve');
    const essencial = planos.find(p => p.id === 'essencial')!;
    assert.ok(essencial.itens.some(i => i.recursos.includes('horarios') && !i.excluido), 'horário nobre sem barreira por plano');
    assert.ok(!essencial.itens.some(i => i.excluido && i.recursos.includes('horarios')));
    // Contrato (disponível) separado da assinatura por WhatsApp (Em breve): o selo não cobre o que está disponível.
    for (const plano of planos) for (const item of plano.itens) {
        if (item.recursos.includes('contratos')) assert.ok(!item.recursos.includes('assinatura_whatsapp'));
    }
    const fonte = readFileSync(new URL('../../components/site/secoes.tsx', import.meta.url), 'utf8');
    for (const frase of ['4 papéis', 'visitante', 'Clientes, festas, financeiro e contratos', 'em troca da sua opinião'])
        assert.equal(fonte.includes(frase), false, frase);
    assert.doesNotMatch(metadataSiteDescricao(), /orçamento online/i, 'descrição de busca sem recurso Em breve');
});
test('rodapé sem configuração: lacunas explícitas e links para seções legais', () => {
    const config = configuracaoSite({});
    for (const chave of ['razaoSocial','cnpj','endereco','email','whatsapp','horario','encarregado'] as const) assert.equal(config[chave], 'a definir');
    const html = renderToStaticMarkup(createElement(Rodape, { config }));
    // Obrigatórios ausentes continuam visíveis como lacuna (razão social, CNPJ, endereço, e-mail — este também no canal de dados).
    assert.equal((html.match(/a definir/g) || []).length, 5);
    assert.doesNotMatch(html, /WhatsApp:|Horário:|Encarregado de dados:/, 'opcionais não configurados não aparecem');
    assert.match(html, /\/termos#cancelamento/); assert.match(html, /\/privacidade#tratamento-de-dados/);
});
test('rodapé com a configuração aprovada (11/10): nenhuma lacuna; canal de dados = e-mail aprovado, sem nomear encarregado', () => {
    const aprovada = JSON.parse(readFileSync(new URL('../../docs/CONFIGURACAO_VENDA_APROVADA_20261011.json', import.meta.url), 'utf8')).valoresSemSegredos as Record<string, string>;
    const html = renderToStaticMarkup(createElement(Rodape, { config: configuracaoSite(aprovada) }));
    assert.doesNotMatch(html, /a definir/);
    assert.match(html, /Privacidade e dados pessoais: felipemenegaz@gmail\.com/);
    assert.match(html, /CNPJ 20\.119\.900\/0001-60/);
    assert.doesNotMatch(html, /WhatsApp:|Encarregado de dados:/);
    const comEncarregado = renderToStaticMarkup(createElement(Rodape, { config: configuracaoSite({ ...aprovada, SITE_ENCARREGADO_DADOS: 'Nome Sintético', SITE_ATENDIMENTO_WHATSAPP: '+55 61 90000-0000' }) }));
    assert.match(comEncarregado, /Encarregado de dados: Nome Sintético/); assert.match(comEncarregado, /WhatsApp: \+55 61 90000-0000/);
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

test('contato por e-mail: sem WhatsApp, o visitante ainda tem uma ação clicável', () => {
    assert.equal(linkEmail(' contato@exemplo.com.br ', 'Olá & oi'), 'mailto:contato@exemplo.com.br?subject=Ol%C3%A1%20%26%20oi');
    for (const email of [undefined, '', 'a definir', 'sem-arroba', 'a@b', 'x@y.com?bcc=z@w.com', 'a b@c.com', 'javascript:x@y.com']) assert.equal(linkEmail(email, 'x'), null, String(email));
    const soEmail = configuracaoSite({ SITE_ATENDIMENTO_EMAIL: 'contato@exemplo.com.br' });
    const html = renderToStaticMarkup(createElement(Contato, { config: soEmail }));
    assert.match(html, /href="mailto:contato@exemplo\.com\.br\?subject=/);
    assert.match(html, /Falar com a equipe por e-mail/);
    assert.doesNotMatch(html, /target=/);
    assert.match(renderToStaticMarkup(createElement(Contato, { config: soEmail, fundador: true })), /mailto:.*Quero ser fundador/);
    assert.equal(renderToStaticMarkup(createElement(Contato, { config: soEmail, flutuante: true })), '', 'botão flutuante é só do WhatsApp');
    // Com WhatsApp, ele continua sendo o canal principal.
    const ambos = configuracaoSite({ SITE_ATENDIMENTO_EMAIL: 'contato@exemplo.com.br', SITE_ATENDIMENTO_WHATSAPP: '+55 (11) 99999-0000' });
    assert.match(renderToStaticMarkup(createElement(Contato, { config: ambos })), /wa\.me/);
    const planos = renderToStaticMarkup(createElement(Planos, { publicado: false, aberto: false, contato: soEmail }));
    assert.match(planos, /mailto:[^"]*Quero%20ser%20fundador/);
});
test('rodapé: e-mail de atendimento clicável e ano corrente', () => {
    const html = renderToStaticMarkup(createElement(Rodape, { config: configuracaoSite({ SITE_ATENDIMENTO_EMAIL: 'contato@exemplo.com.br' }) }));
    assert.match(html, /E-mail: <a href="mailto:contato@exemplo\.com\.br\?subject=[^"]*">contato@exemplo\.com\.br<\/a>/);
    assert.match(html, new RegExp(`© ${new Date().getFullYear()} iA.Fest`));
});
test('metadados: /planos tem título e descrição próprios, sem recurso Em breve', () => {
    const metadataSite = carregarModulo('lib/site/metadata.ts', { ...dubles, 'next': {} }, new Map()).metadataSite as (rota?: string) => { title: string; description: string };
    const conheca = metadataSite(); const planos = metadataSite('/planos');
    assert.notEqual(planos.title, conheca.title);
    assert.notEqual(planos.description, conheca.description);
    assert.match(planos.title, /Planos/);
    assert.doesNotMatch(planos.description, /orçamento online|Wall-e|convite/i);
});
test('robots e sitemap da plataforma: só com origem confiável; áreas privadas seguem pelo cabeçalho noindex', () => {
    assert.deepEqual(sitemapDaPlataforma({}), []);
    assert.equal('sitemap' in robotsDaPlataforma({}), false);
    const env = { SITE_URL: 'https://manager.exemplo.com.br/conheca' };
    assert.deepEqual(sitemapDaPlataforma(env).map(e => e.url), ['https://manager.exemplo.com.br/conheca', 'https://manager.exemplo.com.br/planos']);
    const robots = robotsDaPlataforma(env);
    assert.equal(robots.sitemap, 'https://manager.exemplo.com.br/sitemap.xml');
    const regras = Array.isArray(robots.rules) ? robots.rules[0] : robots.rules;
    assert.equal(regras.allow, '/');
    assert.equal(([] as string[]).concat(regras.disallow ?? []).some(c => c.startsWith('/admin')), false, 'não esconder o X-Robots-Tag do Admin');
    assert.equal(sitemapDaPlataforma({ SITE_URL: 'javascript:alert(1)' }).length, 0);
    for (const arquivo of ['app/robots.ts', 'app/sitemap.ts']) assert.match(readFileSync(new URL(`../../${arquivo}`, import.meta.url), 'utf8'), /dynamic = 'force-dynamic'/);
});

test('oferta inicial = núcleo de gestão (19/10): topo, antes/depois e fluxo principal sem selo Em breve', () => {
    const secao = (nome: string) => componente('components/site/secoes.tsx', nome);
    const hero = renderToStaticMarkup(createElement(secao('Hero'), { aberto: false, config: configuracaoSite({}) }));
    assert.doesNotMatch(hero, /Em breve/);
    assert.doesNotMatch(hero, /madrugada|orçamentos online/i);
    assert.doesNotMatch(renderToStaticMarkup(createElement(secao('AntesDepois'))), /Em breve/);
    const fluxo = renderToStaticMarkup(createElement(secao('ComoFunciona')));
    // Só a nota sobre o orçamento pelo próprio cliente fica marcada como futura.
    assert.equal((fluxo.match(/Em breve/g) || []).length, 1);
    assert.doesNotMatch(fluxo, /Quatro das cinco/);
});

test('suporte só por e-mail (19/10): nenhum plano promete canal de suporte que não existe', () => {
    const suporte = planos.flatMap(p => p.itens.filter(i => i.recursos.includes('suporte')).map(i => `${p.id}: ${i.texto}`));
    assert.deepEqual(suporte, ['essencial: Suporte por e-mail', 'premium: Suporte prioritário por e-mail']);
    for (const plano of planos) assert.doesNotMatch(plano.descricao, /vender pela internet|IA trabalhando/);
});

test('planos iA.Fest (01/11): IA assistiva em todos os planos; WhatsApp.IA incluído só no Premium e adicional só do Profissional; cotas de importação da D-LOTE-6', () => {
    const porId = Object.fromEntries(planos.map(p => [p.id, p]));
    const incluido = (id: string, recurso: RecursoId) => porId[id].itens.filter(i => i.recursos.includes(recurso) && !i.excluido && !i.introducao);
    const excluido = (id: string, recurso: RecursoId) => porId[id].itens.filter(i => i.recursos.includes(recurso) && i.excluido);
    // D-PL-3: copiloto e convite aparecem como incluídos (com selo Em breve) nos três planos, sem números de franquia no site.
    for (const id of ['essencial', 'profissional', 'premium']) for (const recurso of ['copiloto', 'convite'] as const) {
        const itens = incluido(id, recurso);
        assert.equal(itens.length, 1, `${id} inclui ${recurso}`);
        assert.doesNotMatch(itens[0].texto, /\d/, 'franquia de IA sem número até o piloto');
    }
    assert.equal(excluido('essencial', 'copiloto').length, 0);
    // D-PL-1: WhatsApp.IA — Essencial exclui explicitamente; Profissional só como adicional; Premium incluído.
    assert.equal(excluido('essencial', 'walle_whatsapp').length, 1);
    assert.equal(incluido('essencial', 'walle_whatsapp').length, 0);
    assert.match(incluido('profissional', 'walle_whatsapp')[0].texto, /adicional/);
    assert.match(incluido('premium', 'walle_whatsapp').find(i => /franquia/.test(i.texto))!.texto, /incluída/);
    const adicional = adicionais.find(a => a.recursos.includes('walle_whatsapp'))!;
    assert.match(adicional.descricao, /Para o Profissional/);
    assert.doesNotMatch(adicional.descricao, /cobrado por uso\./, 'nenhum excedente cobrado automaticamente (D-C6)');
    // D-LOTE-6: 5 na implantação, 10/mês, 30/mês — nada de "sem cota".
    const importacao = (id: string) => incluido(id, 'importacao_contratos')[0].texto;
    assert.match(importacao('essencial'), /até 5 documentos/); assert.match(importacao('profissional'), /até 10 documentos por mês/); assert.match(importacao('premium'), /até 30 documentos por mês/);
    for (const plano of planos) for (const item of plano.itens) assert.doesNotMatch(item.texto, /sem cota/);
    // D-PL-4: implantação do Premium inclui a conexão do WhatsApp, com o selo do recurso.
    assert.ok(porId.premium.itens.some(i => i.recursos.includes('implantacao') && i.recursos.includes('walle_whatsapp')));
    // D-PL-6: linhas dos planos; as descrições não prometem recurso Em breve sem selo.
    assert.deepEqual(planos.map(p => p.descricao.split('.')[0]), ['Organize', 'Venda mais', 'Atenda 24 h']);
    for (const plano of planos) assert.doesNotMatch(plano.descricao, /orçamento online|WhatsApp|copiloto|convite/i);
});

test('iA.Fest: identidade atual e projeto publicitário pausado fora da vitrine', () => {
    const html = ['Hero', 'Diferenciais', 'WallE', 'Duvidas', 'Confianca'].map(nome =>
        renderToStaticMarkup(createElement(componente('components/site/secoes.tsx', nome), { aberto: false, config: configuracaoSite({}) }))
    ).join('') + renderToStaticMarkup(createElement(Planos, { publicado: false, aberto: false, contato: configuracaoSite({}) }));
    assert.match(html, /iA\.Fest/);
    assert.doesNotMatch(html, /Kidmais Manager|Wall-e publicitário|departamento de marketing|cria a divulgação|Calendário de publicações/);
    assert.equal(adicionais.some(a => /publicitário/i.test(a.nome)), false);
    const footer = renderToStaticMarkup(createElement(Rodape, { config: configuracaoSite({}) }));
    assert.match(footer, /alt="iA\.Fest"/);
    assert.match(footer, /site\/iafest\/logotipo\.png/);
});
