import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { adicionais, comercial, custoPorFesta, descricaoPlano, filtrar, modulos, paineis, passos, perguntas, planos, precoExibido, recursos, tituloFluxo, valorPlano, visivel, type RecursoId } from './catalogo.ts';
import { configuracaoSite, linkEmail, linkWhatsApp, AGENDAR_DEMONSTRACAO, CADASTRO_FECHADO } from './configuracao.ts';
import { robotsDaPlataforma, sitemapDaPlataforma } from './indexacao.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { textoFundador } from './fundador.ts';
import type { ResumoCampanha } from '../assinatura/campanha.ts';

const semBanco = { db: () => { throw new Error('teste não acessa banco'); }, withTransaction: () => { throw new Error('teste não acessa banco'); } };
const dubles = { 'components/site/estilos': { cx: (...nomes: string[]) => nomes.filter(Boolean).join(' ') }, 'components/site/fonte': { fonteTexto: { variable: 'texto' }, fonteTitulo: { variable: 'titulo' } }, 'lib/db/postgres': semBanco, 'components/site/fundo-festa.module.css': {} };
function componente(nome: string, exportado: string) { return carregarModulo(nome, dubles, new Map())[exportado] as ComponentType<Record<string, unknown>>; }
const Cadastro = componente('components/site/elementos.tsx', 'Cadastro');
const Contato = componente('components/site/elementos.tsx', 'Contato');
const BarraCelular = componente('components/site/elementos.tsx', 'BarraCelular');
const Rodape = componente('components/site/Site.tsx', 'Rodape');
const Planos = componente('components/site/Planos.tsx', 'default');
const secao = (nome: string) => componente('components/site/secoes.tsx', nome);
const interativo = (nome: string) => componente('components/site/interativos.tsx', nome);
const metadataSite = () => carregarModulo('lib/site/metadata.ts', { ...dubles, 'next': {} }, new Map()).metadataSite as (rota?: string) => { title: string; description: string };
const render = (c: ComponentType<Record<string, unknown>>, props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(c, props));
/** Texto visível + atributos (alt, aria-label, title), em minúsculas, para procurar promessas. */
function textoDaPagina(html: string) {
    const atributos = [...html.matchAll(/(?:alt|aria-label|title)="([^"]*)"/g)].map(m => m[1]);
    // O verbo do botão "Agendar demonstração" não promete a Agenda do sistema: sai antes da busca pelos termos ("agenda" casaria com "agendar").
    return (html.replace(/<[^>]+>/g, ' ') + ' ' + atributos.join(' ')).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").toLowerCase().replace(/agendar (uma )?demonstração/g, ' ');
}
/** Toda a vitrine que o visitante vê, nos dois estados do preço e do cadastro. Com `cache`, usa o catálogo já carregado (e alterado) nele. */
function vitrineCompleta(cache = new Map<string, Record<string, unknown>>()) {
    const de = (nome: string, exportado: string) => carregarModulo(nome, { ...dubles, 'next': {} }, cache)[exportado] as ComponentType<Record<string, unknown>>;
    const s = (nome: string) => de('components/site/secoes.tsx', nome);
    const meta = carregarModulo('lib/site/metadata.ts', { ...dubles, 'next': {} }, cache).metadataSite as (rota?: string) => { title: string; description: string };
    const config = configuracaoSite({});
    const comContato = configuracaoSite({ SITE_ATENDIMENTO_EMAIL: 'contato@exemplo.com.br', SITE_ATENDIMENTO_WHATSAPP: '+55 (11) 99999-0000' });
    const PlanosC = de('components/site/Planos.tsx', 'default');
    const partes = [
        render(s('Hero'), { aberto: true, config: comContato }), render(s('AntesDepois')), render(s('Paineis')), render(s('Modulos')),
        render(s('WallE')), render(s('ComoFunciona')), render(s('Confianca')), render(s('Duvidas')),
        render(PlanosC, { publicado: true, aberto: true, contato: comContato }), render(PlanosC, { publicado: false, aberto: false, contato: config }),
        render(de('components/site/Site.tsx', 'Rodape'), { config }), render(de('components/site/elementos.tsx', 'BarraCelular'), { aberto: true, config: comContato }),
        meta().description, meta('/planos').description,
    ];
    // Todas as abas de módulo e todos os painéis visíveis entram (os painéis ocultos pelo atributo hidden também são texto da página).
    return partes.join('\n');
}

test('lançamento: nenhuma promessa sem evidência — termos de recurso oculto não aparecem em nenhuma seção', () => {
    const pagina = textoDaPagina(vitrineCompleta());
    const ocultos = Object.entries(recursos).filter(([, r]) => r.status === 'oculto');
    assert.ok(ocultos.length >= 10, 'catálogo com recursos ocultos conhecidos');
    for (const [id, recurso] of ocultos) {
        for (const termo of [recurso.nome, ...recurso.termos]) {
            assert.equal(pagina.includes(termo.toLowerCase()), false, `recurso oculto "${id}" aparece na página pelo termo "${termo}"`);
        }
    }
    for (const [id, recurso] of Object.entries(recursos)) {
        assert.ok(['disponivel', 'oculto'].includes(recurso.status), id);
        assert.ok(recurso.evidencia.length > 30, `${id}: evidência escrita`);
        assert.ok(recurso.termos.length > 0, `${id}: sem termos, o teste não consegue provar que ocultar remove a promessa`);
        if (recurso.status === 'disponivel') assert.match(recurso.evidencia, /production|decisão de Felipe/i, `${id}: disponível exige evidência de production ou decisão registrada`);
    }
});

test('lançamento: ocultar cada recurso disponível, um por vez, tira todas as promessas dele da página (topo, demos e metadata inclusive)', () => {
    const disponiveis = Object.entries(recursos).filter(([, r]) => r.status === 'disponivel').map(([id]) => id);
    assert.ok(disponiveis.length >= 10);
    const falhas: string[] = [];
    for (const id of disponiveis) {
        const cache = new Map<string, Record<string, unknown>>();
        const catalogo = carregarModulo('lib/site/catalogo.ts', dubles, cache) as { recursos: Record<string, { status: string; nome: string; termos: readonly string[] }> };
        catalogo.recursos[id].status = 'oculto';
        const pagina = textoDaPagina(vitrineCompleta(cache));
        for (const termo of [catalogo.recursos[id].nome, ...catalogo.recursos[id].termos])
            if (pagina.includes(termo.toLowerCase())) falhas.push(`${id} oculto, mas "${termo}" segue na página: …${pagina.slice(Math.max(0, pagina.indexOf(termo.toLowerCase()) - 60), pagina.indexOf(termo.toLowerCase()) + 40).replace(/\s+/g, ' ')}…`);
    }
    assert.deepEqual(falhas, []);
});

test('lançamento com tudo ligado: nos painéis e no passo novo, ocultar qualquer recurso tira as promessas dele (cards do ciclo inclusive)', () => {
    // Simula o catálogo completo (todos os recursos disponíveis) e oculta um por vez: protege os cards que hoje não aparecem.
    // Recorte: painéis "Toque e veja" + o passo novo do fluxo. Outras seções têm vazamentos anteriores no estado "tudo ligado" (registrados no vault).
    const ids = Object.keys(recursos);
    const falhas: string[] = [];
    for (const id of ids) {
        const cache = new Map<string, Record<string, unknown>>();
        const catalogo = carregarModulo('lib/site/catalogo.ts', dubles, cache) as { recursos: Record<string, { status: string; nome: string; termos: readonly string[] }> };
        for (const outro of ids) catalogo.recursos[outro].status = 'disponivel';
        catalogo.recursos[id].status = 'oculto';
        const cat = catalogo as unknown as { passos: { titulo: string; texto: string }[]; filtrar: <T>(itens: T[]) => T[] };
        const passoNovo = cat.filtrar(cat.passos).filter(p => p.titulo === 'Lembra o próximo aniversário').map(p => `${p.titulo} ${p.texto}`).join(' ');
        const pagina = textoDaPagina(render(carregarModulo('components/site/secoes.tsx', dubles, cache).Paineis as ComponentType<Record<string, unknown>>)) + ' ' + passoNovo.toLowerCase();
        for (const termo of [catalogo.recursos[id].nome, ...catalogo.recursos[id].termos])
            if (pagina.includes(termo.toLowerCase())) falhas.push(`${id} oculto (resto ligado), mas "${termo}" segue na página: …${pagina.slice(Math.max(0, pagina.indexOf(termo.toLowerCase()) - 60), pagina.indexOf(termo.toLowerCase()) + 40).replace(/\s+/g, ' ')}…`);
    }
    assert.deepEqual(falhas, []);
});

test('cards do ciclo: com tudo ligado, atendimento, fechamento e mensagens abrem a fileira e a grade fecha sem buraco', () => {
    const cache = new Map<string, Record<string, unknown>>();
    const catalogo = carregarModulo('lib/site/catalogo.ts', dubles, cache) as { recursos: Record<string, { status: string }>; paineis: { id: string }[]; passos: { titulo: string }[]; filtrar: <T>(itens: T[]) => T[] };
    for (const r of Object.values(catalogo.recursos)) r.status = 'disponivel';
    assert.deepEqual(catalogo.filtrar(catalogo.paineis).map(p => p.id), ['atendimento', 'assinatura', 'mensagens', 'convite', 'parcelas', 'ajuda', 'marca']);
    assert.equal(catalogo.filtrar(catalogo.passos).at(-1)?.titulo, 'Lembra o próximo aniversário');
    const html = render(carregarModulo('components/site/secoes.tsx', dubles, cache).Paineis as ComponentType<Record<string, unknown>>);
    const larguras = [...html.matchAll(/<article class="bentoItem ?([^"]*)"[^>]*data-painel="([a-z]+)"/g)].map(m => [m[2], m[1]]);
    // 3 + convite (fileira inteira) + parcelas/ajuda/marca: duas fileiras de 3, sem card sozinho.
    assert.deepEqual(larguras, [['atendimento', 'g2'], ['assinatura', 'g2'], ['mensagens', 'g2'], ['convite', 'g6'], ['parcelas', 'g2'], ['ajuda', 'g2'], ['marca', 'g2']]);
    assert.match(html, /Área da Família/);
    // Catálogo real (Wall-e ligado em 23/11): atendimento e fechamento dividem a 1ª fileira, convite inteiro, parcelas e ajuda dividem a última.
    const real = render(secao('Paineis'));
    assert.deepEqual([...real.matchAll(/<article class="bentoItem ?([^"]*)"[^>]*data-painel="([a-z]+)"/g)].map(m => [m[2], m[1]]), [['atendimento', ''], ['assinatura', ''], ['convite', 'g6'], ['parcelas', ''], ['ajuda', '']]);
    const video = real.match(/<video [^>]*>[\s\S]*?<\/video>/)?.[0] ?? '';
    assert.match(video, /src="\/ajuda\/videos\/do-fechamento-ao-contrato\.mp4"/);
    // Achado P3 do Astra r1: capa leve e nada do MP4 antes de tocar.
    assert.match(video, /poster="\/ajuda\/videos\/do-fechamento-ao-contrato\.jpg"/);
    assert.match(video, /preload="none"/);
    // Achado P2 do Astra r1: legenda sincronizada e versão em texto.
    assert.match(video, /<track kind="captions" src="\/ajuda\/videos\/do-fechamento-ao-contrato\.vtt" srcLang="pt-BR"[^>]*default/i);
    for (const arquivo of ['do-fechamento-ao-contrato.mp4', 'do-fechamento-ao-contrato.jpg', 'do-fechamento-ao-contrato.vtt'])
        assert.ok(readdirSync('public/ajuda/videos').includes(arquivo), `${arquivo} existe na central de ajuda`);
    // O passo a passo em texto é a legenda inteira, na ordem, menos a abertura (título) e o fecho (onde pedir ajuda no sistema).
    const falas = readFileSync('public/ajuda/videos/do-fechamento-ao-contrato.vtt', 'utf8').split(/\r?\n\r?\n/)
        .map(bloco => bloco.split(/\r?\n/).filter(l => l && !/^\d+$/.test(l) && !l.includes('-->') && l !== 'WEBVTT').join(' ')).filter(Boolean);
    const passoATexto = real.match(/<details class="passoVideo">[\s\S]*?<\/details>/)?.[0] ?? '';
    assert.match(passoATexto, /<summary>Passo a passo em texto<\/summary>/);
    const itens = [...passoATexto.matchAll(/<li>([^<]*)<\/li>/g)].map(m => m[1].replace(/&#x27;/g, "'"));
    assert.deepEqual(itens, falas.slice(1, -1));
});

test('lembrete do próximo aniversário: passo 8 e linha do painel de mensagens seguem juntos o recurso clientes (achado do Astra r1)', () => {
    const lembrete = '1 mês antes do próximo aniversário';
    for (const clientesLigado of [true, false]) {
        const cache = new Map<string, Record<string, unknown>>();
        const catalogo = carregarModulo('lib/site/catalogo.ts', dubles, cache) as { recursos: Record<string, { status: string }>; passos: { titulo: string }[]; filtrar: <T>(itens: T[]) => T[] };
        for (const r of Object.values(catalogo.recursos)) r.status = 'disponivel';
        catalogo.recursos.clientes.status = clientesLigado ? 'disponivel' : 'oculto';
        const temPasso = catalogo.filtrar(catalogo.passos).some(p => p.titulo === 'Lembra o próximo aniversário');
        const html = render(carregarModulo('components/site/secoes.tsx', dubles, cache).Paineis as ComponentType<Record<string, unknown>>);
        const mensagens = html.match(/data-painel="mensagens"[\s\S]*?<\/article>/)?.[0] ?? '';
        assert.ok(mensagens, 'o painel de mensagens aparece com o resto ligado');
        assert.equal(temPasso, clientesLigado, `passo 8 com clientes ${clientesLigado ? 'ligado' : 'oculto'}`);
        assert.equal(mensagens.includes(lembrete), clientesLigado, `linha do painel com clientes ${clientesLigado ? 'ligado' : 'oculto'}`);
        assert.equal(/comemorar de novo/.test(mensagens), clientesLigado);
        // P3 do Astra r1: o avanço da linha do tempo é anunciado numa região viva.
        assert.match(mensagens, /<p role="status" class="srOnly"><\/p>/, 'renderização inicial não anuncia nada');
    }
    // Ciclo completo (achado P3 do Astra r2): do reinício até a última mensagem, cada envio é anunciado, inclusive o último.
    const { avancarMensagens } = carregarModulo('components/site/interativos.tsx', dubles, new Map()) as { avancarMensagens: (n: number, t: readonly string[]) => { enviadas: number; anuncio: string } };
    const textos = ['Confirmação', 'Lembrete da parcela', 'Lembrete para comemorar de novo no buffet'];
    let estado = { enviadas: textos.length, anuncio: '' };
    const anuncios: string[] = [];
    for (let i = 0; i <= textos.length; i++) { estado = avancarMensagens(estado.enviadas, textos); anuncios.push(estado.anuncio); }
    assert.deepEqual(anuncios, ['Linha do tempo reiniciada. Todas as mensagens estão programadas.', 'Enviada: Confirmação.', 'Enviada: Lembrete da parcela.', 'Enviada: Lembrete para comemorar de novo no buffet.']);
    assert.equal(estado.enviadas, textos.length);
    const fonte = readFileSync('components/site/interativos.tsx', 'utf8');
    const painel = fonte.slice(fonte.indexOf('export function PainelMensagens'));
    assert.match(painel.slice(0, painel.indexOf('\n}\n')), /avancarMensagens\(enviadas[\s\S]*?setAnuncio\(proximo\.anuncio\)[\s\S]*?<p role="status" className=\{cx\('srOnly'\)\}>\{anuncio\}<\/p>/);
});

test('vídeo do card de ajuda: título, player e passo a passo somem juntos com cada dependência (achado do Astra r2)', () => {
    const titulo = 'Do fechamento ao contrato assinado';
    for (const oculto of [null, 'contratos', 'assinatura_codigo', 'agenda', 'festas', 'clientes']) {
        const cache = new Map<string, Record<string, unknown>>();
        const catalogo = carregarModulo('lib/site/catalogo.ts', dubles, cache) as { recursos: Record<string, { status: string }> };
        for (const r of Object.values(catalogo.recursos)) r.status = 'disponivel';
        if (oculto) catalogo.recursos[oculto].status = 'oculto';
        const html = render(carregarModulo('components/site/secoes.tsx', dubles, cache).Paineis as ComponentType<Record<string, unknown>>);
        const ajuda = html.match(/data-painel="ajuda"[\s\S]*?<\/article>/)?.[0] ?? '';
        assert.ok(ajuda, `card de ajuda aparece (${oculto ?? 'tudo ligado'})`);
        const esperado = oculto === null;
        assert.equal(ajuda.includes(`<li>${titulo}</li>`), esperado, `título na lista com ${oculto ?? 'tudo ligado'}`);
        assert.equal(ajuda.includes('<video'), esperado, `player com ${oculto ?? 'tudo ligado'}`);
        assert.equal(ajuda.includes('Passo a passo em texto'), esperado, `passo a passo com ${oculto ?? 'tudo ligado'}`);
    }
});

test('lançamento: o teste pega a promessa — ligar um recurso oculto faz o termo dele aparecer', () => {
    // Prova de que a guarda acima não passa por acaso: com o MCP "disponível", a dúvida dele aparece.
    const cache = new Map<string, Record<string, unknown>>();
    const catalogo = carregarModulo('lib/site/catalogo.ts', dubles, cache) as { recursos: Record<string, { status: string }> };
    catalogo.recursos.mcp.status = 'disponivel';
    const ligado = carregarModulo('components/site/secoes.tsx', dubles, cache) as Record<string, ComponentType<Record<string, unknown>>>;
    assert.match(textoDaPagina(render(ligado.Duvidas)), /chatgpt/);
    assert.doesNotMatch(textoDaPagina(render(secao('Duvidas'))), /chatgpt/, 'no catálogo real o MCP segue oculto');
});

test('sem selo "Em breve" em nenhum lugar: fonte da vitrine e página renderizada', () => {
    // A única frase com "em breve" é o aviso de cadastro fechado (guarda preservada), não um selo de recurso.
    assert.doesNotMatch(vitrineCompleta().split(CADASTRO_FECHADO).join(''), /em breve/i);
    const semComentarios = (fonte: string) => fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const arquivo of readdirSync('components/site').filter(a => /\.(tsx?|css)$/.test(a) && !a.endsWith('.test.ts')))
        assert.doesNotMatch(semComentarios(readFileSync(`components/site/${arquivo}`, 'utf8')), /Em breve|em_breve|\.soon/, arquivo);
    assert.doesNotMatch(readFileSync('lib/site/catalogo.ts', 'utf8'), /'em_breve'/);
});

test('catálogo: blocos seguem os recursos — painéis, abas, fluxo e planos só com recurso disponível', () => {
    assert.deepEqual(filtrar(paineis).map(p => p.id), ['atendimento', 'assinatura', 'convite', 'parcelas', 'ajuda']);
    assert.deepEqual(filtrar(modulos).map(m => m.id), ['agenda', 'contratos', 'financeiro', 'convites', 'equipe']);
    assert.deepEqual(filtrar(passos).map(p => p.titulo), ['Fecha a festa', 'Assina por código', 'Paga as parcelas', 'Convida os amigos', 'Acompanha os recebimentos']);
    assert.equal(tituloFluxo(), 'Uma festa, do fechamento ao dia da festa.');
    const html = render(secao('Paineis'));
    for (const id of ['orcamento', 'marca']) assert.doesNotMatch(html, new RegExp(`data-painel="${id}"`));
    assert.match(html, /Tema astronauta, cores azul e roxo, coloque o espiral de galáxia no fundo\./);
    assert.match(html, /convites-1\.webp/);
    assert.match(html, /Simulações com dados fictícios/);
    // "Recurso disponível" separado de "incluído no plano": item com qualquer recurso oculto some do plano.
    for (const plano of planos) for (const item of plano.itens) {
        const exibido = filtrar(plano.itens).includes(item);
        assert.equal(exibido, visivel(item.recursos), `${plano.id}: ${item.texto}`);
    }
    // Enquanto o orçamento e o financeiro completo estão ocultos, a linha do plano não os promete; o Premium já tem o Wall-e (23/11).
    assert.deepEqual(planos.map(descricaoPlano).map(d => d.split('.')[0]), ['Organize', 'Cresça', 'Atenda 24 h']);
    // Wall-e em production (18/11): seção e dúvida aparecem; a marca segue oculta (o painel promete logo e cores).
    assert.match(textoDaPagina(render(secao('WallE')) + render(secao('Duvidas'))), /wall-e/);
    assert.equal(recursos.marca.status, 'oculto');
});

test('abas WAI: tablist, aria-selected, aria-controls, roving tabindex e painéis ocultos', () => {
    const html = render(interativo('AbasModulos'), { modulos: filtrar(modulos) });
    assert.match(html, /role="tablist"/);
    const abas = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map(m => m[0]);
    assert.equal(abas.length, filtrar(modulos).length);
    abas.forEach((aba, i) => {
        assert.match(aba, new RegExp(`aria-selected="${i === 0}"`)); assert.match(aba, new RegExp(`tabindex="${i === 0 ? 0 : -1}"`));
        const alvo = /aria-controls="([^"]+)"/.exec(aba)![1];
        assert.match(html, new RegExp(`role="tabpanel" id="${alvo}"`));
    });
    assert.equal((html.match(/role="tabpanel"[^>]*hidden/g) || []).length, abas.length - 1);
    assert.doesNotMatch(readFileSync('components/site/interativos.tsx', 'utf8'), /setInterval\([^)]*setAtiva/, 'sem carrossel automático');
});

test('pausa global: botão único com aria-pressed, ligado ao movimento reduzido', () => {
    const html = render(interativo('PausaGlobal'));
    assert.match(html, /<button[^>]*aria-pressed="false"[^>]*>.*Pausar animações/);
    // D-LK-6: o componente mora em PausaGlobal.tsx (também usado na área "Minha festa"); interativos.tsx reexporta.
    assert.match(readFileSync('components/site/interativos.tsx', 'utf8'), /from '\.\/PausaGlobal'/);
    const fonte = readFileSync('components/site/PausaGlobal.tsx', 'utf8');
    assert.match(fonte, /prefers-reduced-motion/); assert.match(fonte, /addEventListener\('change'/);
    assert.doesNotMatch(readFileSync('components/site/FundoFesta.tsx', 'utf8'), /<button/, 'sem botão de pausa por seção');
    assert.match(readFileSync('components/site/site.module.css', 'utf8'), /\.site\[data-pausado=true\][^{]*\{animation-play-state:paused!important\}/);
});

test('demos: simulação com dados fictícios e conversa/calculadora com aria-live', () => {
    for (const nome of ['AntesDepois', 'Modulos']) assert.match(render(secao(nome)), /fictícios/, nome);
    const demo = render(interativo('DemoFesta'));
    assert.match(demo, /Simulação com dados fictícios/); assert.match(demo, /aria-live="polite"/);
    assert.match(render(interativo('ChatWallE'), { roteiro: [{ pergunta: 'Oi?', respostas: ['Olá'] }] }), /role="log" aria-live="polite"/);
    assert.match(render(interativo('Calculadora'), { planos, publicado: true, adicionaisVisiveis: false }), /aria-live="polite"/);
});

test('calculadora: rateio só da mensalidade regular, entre 2 e 40 festas; só com preço publicado', () => {
    const [essencial, profissional] = planos;
    assert.equal(custoPorFesta(profissional, 12), Math.round(39700 / 12));
    assert.equal(custoPorFesta(essencial, 1), Math.round(19700 / 2));
    assert.equal(custoPorFesta(essencial, 100), Math.round(19700 / 40));
    const publicado = render(interativo('Calculadora'), { planos, publicado: true, adicionaisVisiveis: false });
    assert.match(publicado, /R\$\s?33,08/); assert.match(publicado, /Profissional/); assert.match(publicado, /R\$ 0/);
    assert.doesNotMatch(publicado, /Adicionais ficam fora/, 'sem adicional visível, não fala de adicionais');
    assert.doesNotMatch(render(Planos, { publicado: false, aberto: false, contato: configuracaoSite({}) }), /calculadora|Quanto custa por festa/);
});

test('preços: anual 10 vezes o mensal, Fundador exatamente 60%, centavos preservados', () => {
    assert.deepEqual(planos.map(p => p.mensalCentavos), [19700, 39700, 69700]);
    for (const plano of planos) {
        assert.equal(valorPlano(plano, 'anual'), plano.mensalCentavos * 10);
        assert.equal(valorPlano(plano, 'mensal', true), Math.round(plano.mensalCentavos * .6));
        assert.equal(valorPlano(plano, 'anual', true), Math.round(plano.mensalCentavos * 10 * .6));
    }
    assert.equal(valorPlano(planos[0], 'mensal', true), 11820);
    assert.equal(comercial.testeDias, 15);
});

test('sem flag: planos, adicionais e calculadora não exibem preço', () => {
    for (const valor of [...planos.map(p => p.mensalCentavos), ...adicionais.map(a => a.centavos)]) assert.equal(precoExibido(valor, false), 'Preço a definir');
    assert.equal(configuracaoSite({ SITE_PRECOS_PUBLICADOS: 'false' }).precosPublicados, false);
    assert.equal(configuracaoSite({ SITE_PRECOS_PUBLICADOS: 'true' }).precosPublicados, true);
    const html = render(Planos, { publicado: false, aberto: false, contato: configuracaoSite({}) });
    assert.match(html, /Preço a definir/); assert.doesNotMatch(html, /R\$/);
    const publicado = render(Planos, { publicado: true, aberto: true, contato: configuracaoSite({}) });
    assert.match(publicado, /118,20/); assert.equal((publicado.match(/href="\/cadastro"/g) || []).length, 3);
    // Anual: total por ano e o equivalente mensal.
    assert.match(publicado, /R\$\s?1\.970<\/span><small>\/ano/); assert.match(publicado, /Total por ano\. Equivale a <b>R\$\s?164,17\/mês/);
});

test('implantação guiada incluída: nenhum adicional pago de implantação', () => {
    assert.equal(adicionais.some(a => a.recursos.includes('implantacao') || /implanta/i.test(a.nome)), false);
    const html = render(Planos, { publicado: true, aberto: true, contato: configuracaoSite({}) });
    assert.match(html, /Implantação guiada incluída em todos os planos/);
    assert.doesNotMatch(html, /Adicionais/, 'todos os adicionais estão ocultos hoje');
    assert.match(render(secao('Hero'), { aberto: false, config: configuracaoSite({}) }), /Implantação guiada incluída/);
});

test('horário nobre em todos os planos; contrato separado da assinatura', () => {
    const essencial = planos.find(p => p.id === 'essencial')!;
    assert.ok(essencial.itens.some(i => i.recursos.includes('horarios') && !i.excluido), 'horário nobre sem barreira por plano');
    assert.ok(!essencial.itens.some(i => i.excluido && i.recursos.includes('horarios')));
    // O contrato não depende da assinatura por código; o item da assinatura, sim, depende do contrato (assinar exige contrato).
    for (const plano of planos) for (const item of plano.itens) if (item.recursos.includes('contratos') && !/assinatura/i.test(item.texto)) assert.ok(!item.recursos.includes('assinatura_codigo'), item.texto);
    const fonte = readFileSync(new URL('../../components/site/secoes.tsx', import.meta.url), 'utf8');
    for (const frase of ['4 papéis', 'visitante', 'Clientes, festas, financeiro e contratos', 'em troca da sua opinião'])
        assert.equal(fonte.includes(frase), false, frase);
});

test('rodapé sem configuração: lacunas explícitas e links para seções legais', () => {
    const config = configuracaoSite({});
    for (const chave of ['razaoSocial','cnpj','endereco','email','whatsapp','horario','encarregado'] as const) assert.equal(config[chave], 'a definir');
    const html = render(Rodape, { config });
    assert.equal((html.match(/a definir/g) || []).length, 5);
    assert.doesNotMatch(html, /WhatsApp:|Horário:|Encarregado de dados:/, 'opcionais não configurados não aparecem');
    assert.match(html, /\/termos#cancelamento/); assert.match(html, /\/privacidade#tratamento-de-dados/);
    // Links do rodapé só para seções que existem (Wall-e em production desde 18/11).
    assert.match(html, /#wall-e/);
});

test('rodapé com dados da empresa só por variável SITE_* (nada fixo no código)', () => {
    const env = { SITE_RAZAO_SOCIAL: 'DEMERZEL LABS LTDA', SITE_CNPJ: '69.938.612/0001-26', SITE_ENDERECO: 'Endereço Sintético, 100', SITE_ATENDIMENTO_EMAIL: 'contato@exemplo.com.br' };
    const html = render(Rodape, { config: configuracaoSite(env) });
    assert.doesNotMatch(html, /a definir/);
    assert.match(html, /iA\.Fest é um produto de DEMERZEL LABS LTDA · CNPJ 69\.938\.612\/0001-26/);
    assert.match(html, /Privacidade e dados pessoais: contato@exemplo\.com\.br/);
    assert.doesNotMatch(html, /WhatsApp:|Encarregado de dados:/);
    for (const arquivo of readdirSync('components/site').filter(a => a.endsWith('.tsx')))
        assert.doesNotMatch(readFileSync(`components/site/${arquivo}`, 'utf8'), /69\.938\.612|DEMERZEL|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/i, arquivo);
    const comEncarregado = render(Rodape, { config: configuracaoSite({ ...env, SITE_ENCARREGADO_DADOS: 'Nome Sintético', SITE_ATENDIMENTO_WHATSAPP: '+55 61 90000-0000' }) });
    assert.match(comEncarregado, /Encarregado de dados: Nome Sintético/); assert.match(comEncarregado, /WhatsApp: \+55 61 90000-0000/);
});

test('WhatsApp só existe com número configurado e mensagem codificada', () => {
    for (const numero of [undefined, '', 'a definir', '123', 'javascript:1234567890']) assert.equal(linkWhatsApp(numero, 'Olá'), null);
    assert.equal(linkWhatsApp('+55 (11) 99999-0000', 'Olá & bem-vindo'), 'https://wa.me/5511999990000?text=Ol%C3%A1%20%26%20bem-vindo');
    assert.equal(render(Contato, { config: configuracaoSite({}) }), '');
    assert.equal(render(Contato, { config: configuracaoSite({}), fundador: true, flutuante: true }), '');
    const config = configuracaoSite({ SITE_ATENDIMENTO_WHATSAPP: '+55 (11) 99999-0000' });
    assert.notEqual(config.contato, config.fundador);
    assert.match(render(Contato, { config }), /noopener noreferrer/);
});

test('cadastro fechado não expõe CTA; aberto mantém /cadastro', () => {
    const fechado = render(Cadastro, { aberto: false });
    assert.ok(fechado.includes(CADASTRO_FECHADO)); assert.doesNotMatch(fechado, /href=/);
    assert.doesNotMatch(fechado, /em breve/i, 'sem "abre em breve" (23/11/2026)');
    assert.match(render(Cadastro, { aberto: true }), /href="\/cadastro"/);
    const hero = render(secao('Hero'), { aberto: false, config: configuracaoSite({}) });
    assert.doesNotMatch(hero, /href="\/cadastro"/);
    assert.doesNotMatch(render(Planos, { publicado: true, aberto: false, contato: configuracaoSite({}) }), /href="\/cadastro"/);
});

test('cadastro fechado: "Agendar demonstração" pelo WhatsApp comercial, e-mail sem WhatsApp, aviso sem canal', () => {
    const whatsapp = configuracaoSite({ SITE_ATENDIMENTO_WHATSAPP: '+55 (61) 90000-0000', SITE_ATENDIMENTO_EMAIL: 'contato@exemplo.com.br' });
    const porWhatsapp = render(Cadastro, { aberto: false, contato: whatsapp });
    assert.match(porWhatsapp, new RegExp(AGENDAR_DEMONSTRACAO));
    assert.match(porWhatsapp, /href="https:\/\/wa\.me\/5561900000000\?text=[^"]*demonstra%C3%A7%C3%A3o/); assert.match(porWhatsapp, /noopener noreferrer/);
    const soEmail = render(Cadastro, { aberto: false, contato: configuracaoSite({ SITE_ATENDIMENTO_EMAIL: 'contato@exemplo.com.br' }) });
    assert.match(soEmail, /href="mailto:contato@exemplo\.com\.br\?subject=[^"]*demonstra%C3%A7%C3%A3o/); assert.match(soEmail, new RegExp(AGENDAR_DEMONSTRACAO));
    assert.ok(render(Cadastro, { aberto: false, contato: configuracaoSite({}) }).includes(CADASTRO_FECHADO));
    // Cadastro aberto continua com o teste grátis, mesmo com WhatsApp.
    assert.match(render(Cadastro, { aberto: true, contato: whatsapp }), /href="\/cadastro"/);
    // Planos: um botão por plano, nunca /cadastro; topo sem botão repetido para o mesmo canal.
    const planosHtml = render(Planos, { publicado: true, aberto: false, contato: whatsapp });
    assert.equal(planosHtml.split('data-agendar-demonstracao').length - 1, planos.length); assert.doesNotMatch(planosHtml, /href="\/cadastro"/);
    const hero = render(secao('Hero'), { aberto: false, config: whatsapp });
    assert.match(hero, new RegExp(AGENDAR_DEMONSTRACAO)); assert.doesNotMatch(hero, /Falar com a equipe/);
    assert.match(render(secao('Hero'), { aberto: true, config: whatsapp }), /Falar com a equipe/);
});

test('barra fixa do celular: some sem cadastro e sem contato; nunca inventa canal', () => {
    assert.equal(render(BarraCelular, { aberto: false, config: configuracaoSite({}) }), '');
    const soCadastro = render(BarraCelular, { aberto: true, config: configuracaoSite({}) });
    assert.match(soCadastro, /href="\/cadastro"/); assert.doesNotMatch(soCadastro, /Falar com a equipe/);
    const soEmail = render(BarraCelular, { aberto: false, config: configuracaoSite({ SITE_ATENDIMENTO_EMAIL: 'contato@exemplo.com.br' }) });
    assert.match(soEmail, /mailto:contato@exemplo\.com\.br/); assert.doesNotMatch(soEmail, /cadastro|target=/);
});

test('contato por e-mail: sem WhatsApp, o visitante ainda tem uma ação clicável', () => {
    assert.equal(linkEmail(' contato@exemplo.com.br ', 'Olá & oi'), 'mailto:contato@exemplo.com.br?subject=Ol%C3%A1%20%26%20oi');
    for (const email of [undefined, '', 'a definir', 'sem-arroba', 'a@b', 'x@y.com?bcc=z@w.com', 'a b@c.com', 'javascript:x@y.com']) assert.equal(linkEmail(email, 'x'), null, String(email));
    const soEmail = configuracaoSite({ SITE_ATENDIMENTO_EMAIL: 'contato@exemplo.com.br' });
    const html = render(Contato, { config: soEmail });
    assert.match(html, /href="mailto:contato@exemplo\.com\.br\?subject=/);
    assert.match(html, /Falar com a equipe por e-mail/);
    assert.doesNotMatch(html, /target=/);
    assert.match(render(Contato, { config: soEmail, fundador: true }), /mailto:.*Quero ser fundador/);
    assert.equal(render(Contato, { config: soEmail, flutuante: true }), '', 'botão flutuante é só do WhatsApp');
    const ambos = configuracaoSite({ SITE_ATENDIMENTO_EMAIL: 'contato@exemplo.com.br', SITE_ATENDIMENTO_WHATSAPP: '+55 (11) 99999-0000' });
    assert.match(render(Contato, { config: ambos }), /wa\.me/);
    assert.match(render(Planos, { publicado: false, aberto: false, contato: soEmail }), /mailto:[^"]*Quero%20ser%20fundador/);
});

test('rodapé: e-mail de atendimento clicável e ano corrente', () => {
    const html = render(Rodape, { config: configuracaoSite({ SITE_ATENDIMENTO_EMAIL: 'contato@exemplo.com.br' }) });
    assert.match(html, /E-mail: <a href="mailto:contato@exemplo\.com\.br\?subject=[^"]*">contato@exemplo\.com\.br<\/a>/);
    assert.match(html, new RegExp(`© ${new Date().getFullYear()} iA.Fest`));
});

test('metadados: /planos tem título e descrição próprios, sem recurso oculto', () => {
    const conheca = metadataSite()(); const planosMeta = metadataSite()('/planos');
    assert.notEqual(planosMeta.title, conheca.title);
    assert.notEqual(planosMeta.description, conheca.description);
    assert.match(planosMeta.title, /Planos/);
    for (const descricao of [conheca.description, planosMeta.description]) assert.doesNotMatch(descricao, /orçamento online|Wall-e|Em breve/i);
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

test('staging bloqueia o rastreio de tudo e não publica sitemap; demais ambientes seguem iguais (plano D4)', () => {
    const env = { SITE_URL: 'https://manager.exemplo.com.br/conheca', KIDMAIS_DEPLOY_ENV: 'staging' };
    assert.deepEqual(robotsDaPlataforma(env), { rules: { userAgent: '*', disallow: '/' } });
    const producao = robotsDaPlataforma({ ...env, KIDMAIS_DEPLOY_ENV: 'production' });
    assert.equal(producao.sitemap, 'https://manager.exemplo.com.br/sitemap.xml');
    assert.equal((Array.isArray(producao.rules) ? producao.rules[0] : producao.rules).allow, '/');
});

test('suporte só por e-mail (19/10): nenhum plano promete canal de suporte que não existe', () => {
    const suporte = planos.flatMap(p => p.itens.filter(i => i.recursos.includes('suporte')).map(i => `${p.id}: ${i.texto}`));
    assert.deepEqual(suporte, ['essencial: Suporte por e-mail', 'premium: Suporte prioritário por e-mail']);
    for (const plano of planos) assert.doesNotMatch(descricaoPlano(plano), /vender pela internet|IA trabalhando/);
});

test('planos iA.Fest (01/11): decisões D-PL preservadas no catálogo, mesmo com os itens ocultos', () => {
    const porId = Object.fromEntries(planos.map(p => [p.id, p]));
    const incluido = (id: string, recurso: RecursoId) => porId[id].itens.filter(i => i.recursos.includes(recurso) && !i.excluido && !i.introducao);
    const excluido = (id: string, recurso: RecursoId) => porId[id].itens.filter(i => i.recursos.includes(recurso) && i.excluido);
    // D-PL-3: copiloto e convite incluídos nos três planos (o Essencial com o convite base), sem números de franquia.
    for (const id of ['essencial', 'profissional', 'premium']) for (const recurso of ['copiloto', 'convite'] as const) {
        const itens = incluido(id, recurso);
        assert.equal(itens.length, 1, `${id} inclui ${recurso}`);
        assert.doesNotMatch(itens[0].texto, /\d/, 'franquia de IA sem número até o piloto');
    }
    // Franquia maior/ampla do convite depende dos créditos: oculta enquanto não houver compra.
    for (const id of ['profissional', 'premium']) assert.ok(incluido(id, 'convite')[0].recursos.includes('creditos'));
    assert.equal(excluido('essencial', 'copiloto').length, 0);
    // D-OF-1 (13/11, substitui a D-PL-1): Wall-e só no Premium. Essencial exclui explicitamente; Profissional sem adicional.
    assert.equal(excluido('essencial', 'walle_whatsapp').length, 1);
    assert.equal(incluido('essencial', 'walle_whatsapp').length, 0);
    assert.equal(incluido('profissional', 'walle_whatsapp').length, 0);
    assert.equal(adicionais.some(a => a.recursos.includes('walle_whatsapp')), false);
    const premiumWalle = incluido('premium', 'walle_whatsapp').find(i => /uso justo/.test(i.texto))!.texto;
    assert.match(premiumWalle, /incluído/); assert.doesNotMatch(premiumWalle, /\d|franquia/);
    for (const adicional of adicionais) assert.doesNotMatch(adicional.descricao, /cobrado por uso\./, 'nenhum excedente cobrado automaticamente (D-C6)');
    // D-LAN-4 (23/11): teste grátis com tudo do Premium, aberto a todos.
    assert.ok(porId.premium.itens.some(i => i.recursos.length === 0 && i.texto === 'Teste grátis de ' + comercial.testeDias + ' dias com tudo do Premium, aberto a todos os buffets'));
    // D-LOTE-6: 5 na implantação, 10/mês, 30/mês.
    const importacao = (id: string) => incluido(id, 'importacao')[0].texto;
    assert.match(importacao('essencial'), /até 5 documentos/); assert.match(importacao('profissional'), /até 10 documentos por mês/); assert.match(importacao('premium'), /até 30 documentos por mês/);
    for (const plano of planos) for (const item of plano.itens) assert.doesNotMatch(item.texto, /sem cota/);
    // D-PL-4: implantação do Premium com a conexão do WhatsApp, oculta junto com o Wall-e.
    assert.ok(porId.premium.itens.some(i => i.recursos.includes('implantacao') && i.recursos.includes('walle_whatsapp')));
    // D-PL-6: linhas completas dos planos quando todos os recursos estiverem disponíveis.
    assert.deepEqual(planos.map(p => p.descricao.split('.')[0]), ['Organize', 'Venda mais', 'Atenda 24 h']);
});

test('iA.Fest: identidade atual e projeto publicitário pausado fora da vitrine', () => {
    const html = vitrineCompleta();
    assert.match(html, /iA\.Fest/);
    assert.doesNotMatch(html, /Kidmais Manager|Wall-e publicitário|departamento de marketing|cria a divulgação|Calendário de publicações/);
    assert.equal(adicionais.some(a => /publicitário/i.test(a.nome)), false);
    const footer = render(Rodape, { config: configuracaoSite({}) });
    assert.match(footer, /alt="iA\.Fest"/);
    assert.match(footer, /site\/iafest\/logotipo\.png/);
});

test('dúvidas: só perguntas com recurso disponível, mais o Plano Fundador', () => {
    const html = render(secao('Duvidas'));
    const esperadas = filtrar(perguntas()).map(p => p.pergunta);
    assert.equal((html.match(/<summary>/g) || []).length, esperadas.length + 1);
    assert.match(html, /O que é o Plano Fundador\?/);
    assert.match(html, /A implantação é cobrada\?/);
    for (const oculta of ['ChatGPT', 'PDFs']) assert.doesNotMatch(html, new RegExp(oculta));
    assert.match(html, /O que é o Wall-e\?/);
});

test('Fundador: campanha encerrada ou vagas em confirmação não anunciam preço Fundador, percentual nem contato', () => {
    const comContato = configuracaoSite({ SITE_ATENDIMENTO_EMAIL: 'contato@exemplo.com.br' });
    const fundadorDe = (resumo: ResumoCampanha) => textoFundador(resumo);
    const fundadorRegular = valorPlano(planos.find(p => p.id === 'essencial')!, 'mensal', true);
    const valorFundador = precoExibido(fundadorRegular, true);
    for (const resumo of [{ fase: 'ENCERRADA' }, { fase: 'POS_JANELA', vagasRestantes: 0, emConfirmacao: 2, limite: 20 }] as ResumoCampanha[]) {
        const f = fundadorDe(resumo);
        assert.equal(f.oferta, false, resumo.fase);
        for (const publicado of [true, false]) {
            const html = render(Planos, { publicado, aberto: true, contato: comContato, fundador: f });
            const texto = textoDaPagina(html);
            assert.doesNotMatch(texto, /fundador: (r\$|preço)/, `${resumo.fase}: sem linha de preço Fundador`);
            assert.equal(texto.includes(valorFundador.toLowerCase()), false, `${resumo.fase}: sem ${valorFundador}`);
            assert.doesNotMatch(texto, /quero ser fundador/, `${resumo.fase}: sem contato de fundador`);
            assert.doesNotMatch(texto, new RegExp(`${comercial.fundador.descontoPercentual}%`), `${resumo.fase}: sem percentual`);
            assert.match(texto, new RegExp(f.titulo.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'o aviso da situação continua');
        }
    }
    // Com a oferta valendo, o preço e o contato voltam.
    for (const resumo of [{ fase: 'LEGADO' }, { fase: 'DESLIGADA' }, { fase: 'POS_JANELA', vagasRestantes: 3, emConfirmacao: 0, limite: 20 }] as ResumoCampanha[]) {
        const f = fundadorDe(resumo);
        assert.equal(f.oferta, true, resumo.fase);
        const texto = textoDaPagina(render(Planos, { publicado: true, aberto: true, contato: comContato, fundador: f }));
        assert.ok(texto.includes(valorFundador.toLowerCase()), `${resumo.fase}: preço Fundador`);
        assert.match(texto, /quero ser fundador/);
    }
});

test('assinatura na demo: o código só libera o contrato; assinar exige aceite e "Aceitar e assinar eletronicamente" (como em production)', () => {
    const html = render(interativo('PainelAssinatura'));
    const texto = textoDaPagina(html);
    assert.match(texto, /código confirmado/);
    assert.doesNotMatch(texto, /contrato assinado/, 'completar o código não é assinar');
    assert.match(html, /type="checkbox"/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Aceitar e assinar eletronicamente<\/button>/, 'botão de assinar desabilitado até o aceite');
    // Mesma ação do contrato público de production.
    assert.match(readFileSync('components/contrato/ContratoPublico.tsx', 'utf8'), /Aceitar e assinar eletronicamente/);
});

test('pausa interrompe as simulações em andamento: assinatura e convite ouvem a pausa e o movimento reduzido', () => {
    const fonte = readFileSync('components/site/interativos.tsx', 'utf8');
    assert.match(fonte, /function useAoPausar\([\s\S]*?addEventListener\(EVENTO_PAUSA[\s\S]*?consulta\.addEventListener\('change'/);
    const chamadas = fonte.match(/useAoPausar\(\(\) =>/g) ?? [];
    assert.equal(chamadas.length, 3, 'PainelAssinatura, PainelConvite e PainelAtendimento');
    for (const painel of ['PainelAssinatura', 'PainelConvite']) {
        const corpo = fonte.slice(fonte.indexOf(`export function ${painel}`), fonte.indexOf('\n}\n', fonte.indexOf(`export function ${painel}`)));
        assert.match(corpo, /useAoPausar\(/, painel);
        assert.match(corpo, /clearInterval/, `${painel}: para o temporizador`);
    }
    const atendimento = fonte.slice(fonte.indexOf('export function PainelAtendimento'), fonte.indexOf('\n}\n', fonte.indexOf('export function PainelAtendimento')));
    assert.match(atendimento, /useAoPausar\([\s\S]*?clearTimeout/, 'PainelAtendimento: a pausa cancela a resposta simulada');
});

test('topo pelo catálogo: sem agenda, festas ou contratos o topo vira institucional e a demo some', () => {
    for (const id of ['agenda', 'festas', 'contratos']) {
        const cache = new Map<string, Record<string, unknown>>();
        (carregarModulo('lib/site/catalogo.ts', dubles, cache) as { recursos: Record<string, { status: string }> }).recursos[id].status = 'oculto';
        const Hero = carregarModulo('components/site/secoes.tsx', dubles, cache).Hero as ComponentType<Record<string, unknown>>;
        const html = render(Hero, { aberto: true, config: configuracaoSite({}) });
        assert.doesNotMatch(html, /Monte uma festa agora|Simulação: monte uma festa/, id);
        assert.match(html, /O sistema do seu/);
    }
    const html = render(secao('Hero'), { aberto: true, config: configuracaoSite({}) });
    assert.match(html, /Monte uma festa agora/);
    assert.match(html, /Horário nobre/);
    assert.match(html, /Pix copia e cola/);
});

test('descrição dos planos pelo catálogo: sem permissões, nenhum plano promete equipe ou "sem limite" (achado do Astra r3)', () => {
    const cache = new Map<string, Record<string, unknown>>();
    const cat = carregarModulo('lib/site/catalogo.ts', dubles, cache) as { recursos: Record<string, { status: string }>; planos: { id: string; descricaoMinima: string }[] };
    cat.recursos.permissoes.status = 'oculto';
    const PlanosC = carregarModulo('components/site/Planos.tsx', { ...dubles, 'next': {} }, cache).default as ComponentType<Record<string, unknown>>;
    for (const publicado of [true, false]) {
        const texto = textoDaPagina(render(PlanosC, { publicado, aberto: true, contato: configuracaoSite({}) }));
        for (const frase of ['sem limite de equipe', 'sem limite', 'equipe maior', 'equipe grande', 'usuários ilimitados']) {
            assert.equal(texto.includes(frase), false, 'permissoes oculto: "' + frase + '" na página');
        }
        for (const plano of cat.planos) assert.ok(texto.includes(plano.descricaoMinima.toLowerCase()), plano.id + ': linha mínima');
    }
    // Com permissões disponível, a promessa do Premium volta (com o Wall-e ligado, a linha completa: "equipe grande").
    const real = textoDaPagina(render(carregarModulo('components/site/Planos.tsx', { ...dubles, 'next': {} }).default as ComponentType<Record<string, unknown>>, { publicado: true, aberto: true, contato: configuracaoSite({}) }));
    assert.ok(real.includes('equipe grande'));
});
