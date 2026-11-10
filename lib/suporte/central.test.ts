import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { montarCorpus, type Corpus } from '../conhecimento/corpus.ts';
import { carregarCorpusAprovado } from '../conhecimento/carregar.ts';
import { artigoDaCentral, artigosDaCentral, blocos, buscarNaCentral, linkInterno, midia, naCentral, rotaDoArtigo, textoSemMarcacao, trechos } from './central.ts';
import { semEnderecoDeMidia, termos } from '../conhecimento/busca.ts';
import { ARTIGO_DA_ROTA, artigoDaRota, rotaDaAjuda } from './ajuda-da-tela.ts';
import { codigoSuporte, mensagemSuporte } from './codigo.ts';
import { linkWhatsApp } from '../site/configuracao.ts';
import { carregarComponente, cssFalso, elementos, texto, tique } from '../../components/admin/teste-componente.ts';
import { jsx } from 'react/jsx-runtime';
import ts from 'typescript';

/**
 * Valores literais do atributo JSX `id` escritos na própria tela, pela árvore do TypeScript: comentário e outros atributos
 * (data-testid, aria-labelledby) não contam. Id que só existe num componente filho reprova (o link aponta para a tela).
 */
function idsDaTela(codigo: string): Set<string> {
    const fonte = ts.createSourceFile('tela.tsx', codigo, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const ids = new Set<string>();
    const visitar = (no: ts.Node): void => {
        if (ts.isJsxAttribute(no) && no.name.getText(fonte) === 'id' && no.initializer) {
            const valor = ts.isJsxExpression(no.initializer) ? no.initializer.expression : no.initializer;
            if (valor && (ts.isStringLiteral(valor) || ts.isNoSubstitutionTemplateLiteral(valor))) ids.add(valor.text);
        }
        ts.forEachChild(no, visitar);
    };
    visitar(fonte);
    return ids;
}

/** Telas (page.tsx) na pasta e abaixo dela, relativa à raiz do repositório. */
function telasSob(pasta: string): string[] {
    const url = new URL(`../../${pasta}/`, import.meta.url);
    if (!existsSync(url)) return [];
    return (readdirSync(url, { recursive: true }) as string[]).filter((f) => /(^|[\\/])page\.tsx$/.test(f));
}

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const HOJE = '2026-11-01';

function corpusDe(docs: Array<{ id: string; titulo: string; texto: string; situacao?: string; acl?: object; desde?: string; ate?: string | null }>): Corpus {
    const arquivos = new Map(docs.map((d) => [`${d.id}.md`, d.texto]));
    return montarCorpus({
        versao: 1,
        documentos: docs.map((d) => ({
            arquivo: `${d.id}.md`, id: d.id, titulo: d.titulo, versao: 1, vigenteDesde: d.desde ?? '2026-10-01', vigenteAte: d.ate ?? null,
            situacao: d.situacao ?? 'APROVADO', acl: d.acl ?? { tipo: 'PLATAFORMA' },
            sha256: createHash('sha256').update(d.texto, 'utf8').digest('hex'),
        })),
    }, (arquivo) => arquivos.get(arquivo) ?? null);
}

const CORPUS = corpusDe([
    { id: 'contratos', titulo: 'Contratos', texto: '# Contratos\n\n## Como enviar o contrato para assinatura\n\n1. Abra a **festa**.\n2. Toque em Enviar contrato.\n\nVeja [a agenda](/admin/disponibilidade).' },
    { id: 'festas', titulo: 'Festas', texto: '# Festas\n\n## Como criar uma festa\n\nEscolha data, salão e pacote.' },
    { id: 'pendente', titulo: 'Rascunho', texto: '# Rascunho\n\n## Contrato secreto\n\nenviar contrato assinatura', situacao: 'PENDENTE_APROVACAO' },
    { id: 'da-empresa', titulo: 'Regra da empresa', texto: '# Regra\n\n## Contrato da empresa\n\nenviar contrato assinatura', acl: { tipo: 'EMPRESA', empresaId: EMPRESA } },
    { id: 'futuro', titulo: 'Futuro', texto: '# Futuro\n\n## Contrato\n\nenviar contrato assinatura', desde: '2027-01-01' },
    { id: 'vencido', titulo: 'Vencido', texto: '# Vencido\n\n## Contrato\n\nenviar contrato assinatura', ate: '2026-10-15' },
]);

test('central: só aprovado, vigente e PLATAFORMA; nunca documento de empresa, pendente ou fora da vigência', () => {
    assert.deepEqual(artigosDaCentral(CORPUS, HOJE).map((a) => a.id), ['contratos', 'festas']);
    for (const id of ['pendente', 'da-empresa', 'futuro', 'vencido']) {
        assert.equal(artigoDaCentral(CORPUS, HOJE, id), null, id);
        assert.equal(naCentral(CORPUS.documentos.find((d) => d.id === id)!, HOJE), false, id);
    }
    assert.equal(artigoDaCentral(CORPUS, HOJE, 'contratos')?.titulo, 'Contratos');
    assert.deepEqual(artigosDaCentral(null, HOJE), []);
    assert.equal(artigoDaCentral(null, HOJE, 'contratos'), null);
});

test('busca da central: acha a seção, devolve trecho sem marcação e nunca vaza documento restrito', () => {
    const r = buscarNaCentral(CORPUS, HOJE, 'enviar contrato assinatura');
    assert.equal(r[0].id, 'contratos');
    assert.equal(r[0].secao, 'Como enviar o contrato para assinatura');
    assert.equal(r[0].href, '/admin/ajuda/contratos#secao-0');
    assert.equal(r[0].trecho.includes('**'), false);
    assert.equal(r[0].trecho.includes('](/admin'), false);
    assert.equal(r.some((x) => ['pendente', 'da-empresa', 'futuro', 'vencido'].includes(x.id)), false);
    assert.deepEqual(buscarNaCentral(CORPUS, HOJE, '   '), []);
    assert.deepEqual(buscarNaCentral(null, HOJE, 'contrato'), []);
    assert.deepEqual(buscarNaCentral(CORPUS, HOJE, 'xilofone'), []);
    // Consulta enorme é cortada antes da busca (sem erro).
    assert.doesNotThrow(() => buscarNaCentral(CORPUS, HOJE, 'contrato '.repeat(500)));
    assert.equal(rotaDoArtigo('festas'), '/admin/ajuda/festas');
});

test('texto do artigo: parágrafos, listas, negrito e só link interno', () => {
    const b = blocos('Primeira linha\ncontinua.\n\n- um\n- dois\n  segue\n\n1. passo\n2) outro\n\n### Título solto');
    assert.deepEqual(b.map((x) => x.tipo), ['p', 'ul', 'ol', 'p']);
    assert.deepEqual(b[0], { tipo: 'p', trechos: [{ tipo: 'texto', texto: 'Primeira linha continua.' }] });
    assert.deepEqual(b[1], { tipo: 'ul', itens: [[{ tipo: 'texto', texto: 'um' }], [{ tipo: 'texto', texto: 'dois segue' }]] });
    assert.equal(b[2].tipo === 'ol' && b[2].itens.length, 2);
    assert.deepEqual(b[3], { tipo: 'p', trechos: [{ tipo: 'texto', texto: 'Título solto' }] });

    assert.deepEqual(trechos('Abra **Festas** e [veja](/admin/festas).'), [
        { tipo: 'texto', texto: 'Abra ' }, { tipo: 'negrito', texto: 'Festas' }, { tipo: 'texto', texto: ' e ' },
        { tipo: 'link', texto: 'veja', href: '/admin/festas' }, { tipo: 'texto', texto: '.' },
    ]);
    for (const href of ['https://evil.example', 'javascript:alert(1)', '//evil.example', '/api/admin/x', '/admin/../api', '/admin/Festas', 'mailto:a@b.c', '/admin/x?y=1']) {
        assert.equal(linkInterno(href), false, href);
        const t = trechos(`[clique](${href})`);
        assert.equal(t.some((x) => x.tipo === 'link'), false, href);
        assert.equal(t[0].tipo === 'texto' && t[0].texto, 'clique', href);
    }
    for (const href of ['/admin', '/admin/festas', '/admin/configuracoes/whatsapp', '/clientes', '/admin/ajuda/contratos#secao-1']) assert.equal(linkInterno(href), true, href);
    assert.equal(JSON.stringify(blocos('<script>alert(1)</script>')).includes('"tipo":"link"'), false);
});

test('mídia do artigo: só imagem e vídeo da própria aplicação, sempre com descrição', () => {
    assert.deepEqual(midia('![Botão Gerar contrato](/ajuda/imagens/contrato-gerar.png)'), { tipo: 'imagem', src: '/ajuda/imagens/contrato-gerar.png', alt: 'Botão Gerar contrato' });
    assert.deepEqual(midia('!video[Do fechamento ao contrato](/ajuda/videos/fechamento-contrato.mp4)'), {
        tipo: 'video', src: '/ajuda/videos/fechamento-contrato.mp4', capa: '/ajuda/videos/fechamento-contrato.jpg', legenda: '/ajuda/videos/fechamento-contrato.vtt', alt: 'Do fechamento ao contrato',
    });
    for (const linha of ['![ok ok](https://evil.example/x.png)', '![ok ok](/ajuda/imagens/../x.png)', '![ok ok](/ajuda/imagens/x.svg)', '![ok ok](/ajuda/videos/x.mp4)',
        '!video[ok ok](/ajuda/videos/x.webm)', '!video[ok ok](https://youtube.com/x.mp4)', '![ok ok](javascript:alert)', '![ok ok](/ajuda/imagens/X.png)']) {
        assert.deepEqual(midia(linha), { tipo: 'p', trechos: [{ tipo: 'texto', texto: 'ok ok' }] }, linha);
    }
    assert.equal(midia('![](/ajuda/imagens/x.png)'), null, 'sem descrição não é mídia');
    assert.equal(midia('texto com ![a b c](/ajuda/imagens/x.png) no meio'), null, 'só em linha própria');
    assert.equal(midia('veja ![a b c](/ajuda/imagens/x.png)'), null, 'nem no fim de uma frase');
    for (const vazia of ['![   ](/ajuda/imagens/x.png)', '![\t\t\t](/ajuda/imagens/x.png)', '!video[    ](/ajuda/videos/x.mp4)', '![ a  ](/ajuda/imagens/x.png)']) {
        assert.equal(midia(vazia), null, `descrição sem texto útil não é mídia: ${JSON.stringify(vazia)}`);
    }
    assert.deepEqual(midia('![  Tela de festas  ](/ajuda/imagens/festas.png)'), { tipo: 'imagem', src: '/ajuda/imagens/festas.png', alt: 'Tela de festas' });
    const b = blocos('Antes\n![Tela de festas](/ajuda/imagens/festas.png)\n1. passo');
    assert.deepEqual(b.map((x) => x.tipo), ['p', 'imagem', 'ol']);
    assert.equal(textoSemMarcacao('a\n![Tela de festas](/ajuda/imagens/festas.png)\n**b** [c](/admin)'), 'a\nTela de festas\nb c');
});

test('ajuda da tela: prefixo mais longo vence e só artigo publicado vira link', () => {
    const todos = Object.values(ARTIGO_DA_ROTA).map((id) => ({ id, ate: null }));
    const hoje = '2026-11-02';
    assert.equal(artigoDaRota('/admin/financeiro/contas-pagar', todos, hoje), 'contas-a-pagar-e-caixa');
    assert.equal(artigoDaRota('/admin/financeiro', todos, hoje), 'financeiro-recebimentos');
    assert.equal(artigoDaRota('/admin/configuracoes/saloes/abc', todos, hoje), 'saloes-pacotes-e-itens');
    assert.equal(artigoDaRota('/clientes/123', todos, hoje), 'clientes');
    assert.equal(artigoDaRota('/admin/festas-x', todos, hoje), null, 'prefixo só casa no limite do segmento');
    assert.equal(artigoDaRota('/admin/configuracoes', todos, hoje), null);
    assert.equal(artigoDaRota('/admin/festas', [], hoje), null, 'artigo não publicado não gera link');
    // Vigência revalidada no navegador: o último dia ainda vale; no dia seguinte o chip some sem recarregar o layout.
    const festas = [{ id: 'festas', ate: '2026-11-02' }];
    assert.equal(artigoDaRota('/admin/festas', festas, '2026-11-02'), 'festas');
    assert.equal(artigoDaRota('/admin/festas', festas, '2026-11-03'), null, 'artigo vencido não vira link');
    assert.equal(rotaDaAjuda('/admin/ajuda'), true);
    assert.equal(rotaDaAjuda('/admin/ajuda/contratos'), true);
    assert.equal(rotaDaAjuda('/admin/ajudante'), false);
    assert.equal(rotaDaAjuda('/admin/festas'), false);
});

test('código de suporte: curto, estável, igual à fórmula SQL e sem dado da empresa', async () => {
    const codigo = await codigoSuporte(EMPRESA);
    assert.match(codigo, /^KM-[0-9A-F]{8}$/);
    assert.equal(await codigoSuporte(EMPRESA), codigo);
    // Mesma conta do SELECT documentado: upper(substr(encode(sha256('kidmais-suporte-v1:' || id), 'hex'), 1, 8)).
    assert.equal(codigo, `KM-${createHash('sha256').update(`kidmais-suporte-v1:${EMPRESA}`, 'utf8').digest('hex').slice(0, 8).toUpperCase()}`);
    assert.notEqual(await codigoSuporte('22222222-2222-4222-8222-222222222222'), codigo);
    assert.equal(codigo.includes(EMPRESA.slice(0, 8)), false);
    assert.equal(mensagemSuporte(codigo), `Olá! Sou cliente do iA.Fest e preciso de ajuda. Código de suporte: ${codigo}`);
    assert.equal(mensagemSuporte(null).includes('Código'), false);
    assert.equal(decodeURIComponent(linkWhatsApp('+55 61 99999-0000', mensagemSuporte(codigo))!.split('text=')[1]).endsWith(codigo), true);
});

test('botão do suporte: sem empresa abre a mensagem padrão; com empresa, o link ganha só o código', async () => {
    const SEM = 'https://wa.me/5561999990000?text=padrao';
    for (const empresaId of [null, EMPRESA]) {
        const tela = carregarComponente('components/admin/ajuda/CodigoSuporte.tsx', {
            '@/lib/site/configuracao': { linkWhatsApp },
            '@/lib/suporte/codigo': { codigoSuporte, mensagemSuporte },
        });
        // O contexto do dublê devolve o valor padrão; aqui ele vira a empresa da sessão.
        (tela.modulo.EmpresaSuporteContext as { padrao: unknown }).padrao = empresaId;
        const props = { numero: '+55 61 99999-0000', rotulo: '+55 61 99999-0000', hrefSemCodigo: SEM };
        const antes = tela.render('default', props) as { props: { href: string } };
        assert.equal(antes.props.href, SEM, 'antes do cálculo, link sem código');
        assert.equal(tela.render('default', { mostrarCodigo: true }), null);
        tela.efeitos();
        await new Promise((r) => setTimeout(r, 20));
        const depois = tela.render('default', props) as { props: { href: string } };
        const codigoTela = tela.render('default', { mostrarCodigo: true });
        if (empresaId === null) {
            assert.equal(depois.props.href, SEM);
            assert.equal(codigoTela, null);
        } else {
            const codigo = await codigoSuporte(empresaId);
            assert.equal(depois.props.href, linkWhatsApp('+55 61 99999-0000', mensagemSuporte(codigo)));
            assert.match(texto(codigoTela), new RegExp(`Código de suporte da sua empresa: ${codigo}`));
            assert.equal(depois.props.href.includes(empresaId), false);
        }
    }
});

test('botão do suporte: depois de trocar de empresa, o código da anterior nunca aparece', async () => {
    const tela = carregarComponente('components/admin/ajuda/CodigoSuporte.tsx', {
        '@/lib/site/configuracao': { linkWhatsApp },
        '@/lib/suporte/codigo': { codigoSuporte, mensagemSuporte },
    });
    const contexto = tela.modulo.EmpresaSuporteContext as { padrao: unknown };
    contexto.padrao = EMPRESA;
    tela.render('default', { mostrarCodigo: true });
    tela.efeitos();
    await new Promise((r) => setTimeout(r, 20));
    assert.match(texto(tela.render('default', { mostrarCodigo: true })), new RegExp(await codigoSuporte(EMPRESA)));
    contexto.padrao = '22222222-2222-4222-8222-222222222222';
    assert.equal(tela.render('default', { mostrarCodigo: true }), null, 'antes do novo cálculo, nenhum código');
    const link = tela.render('default', { numero: '+55 61 99999-0000', hrefSemCodigo: 'sem-codigo' }) as { props: { href: string } };
    assert.equal(link.props.href, 'sem-codigo');
});

function montarPagina(arquivo: string, corpus: Corpus | null, extras: Record<string, unknown> = {}) {
    return carregarComponente(arquivo, {
        'next/link': { default: 'a' },
        'next/navigation': { notFound: () => { throw new Error('NEXT_NOT_FOUND'); } },
        '@/components/admin/admin.module.css': cssFalso,
        '@/components/admin/workspace.module.css': cssFalso,
        '@/components/admin/ajuda/ajuda.module.css': cssFalso,
        '@/components/admin/ajuda/CodigoSuporte': { default: 'CodigoSuporte' },
        '@/lib/suporte/canais': { canaisSuporte: () => ({ configurado: false }) },
        '@/lib/suporte/central': { artigosDaCentral, artigoDaCentral, buscarNaCentral, blocos, rotaDoArtigo, CONSULTA_MAX: 120 },
        '@/lib/suporte/rota': { ROTA_AJUDA: '/admin/ajuda' },
        '@/lib/conhecimento/carregar': { carregarCorpusAprovado: () => corpus },
        '@/lib/financeiro/calculos': { hojeBrasilia: () => HOJE },
        ...extras,
    });
}

test('página de ajuda: lista, busca com resultado, busca sem resultado e corpus indisponível', async () => {
    const tela = montarPagina('app/admin/ajuda/page.tsx', CORPUS);
    const lista = await tela.render('default', { searchParams: Promise.resolve({}) });
    const hrefs = elementos(lista).map((e) => e.props.href).filter(Boolean);
    assert.deepEqual(hrefs.filter((h) => String(h).startsWith('/admin/ajuda/')), ['/admin/ajuda/contratos', '/admin/ajuda/festas']);
    assert.equal(texto(lista).includes('Rascunho') || texto(lista).includes('Regra da empresa'), false);

    const achou = await tela.render('default', { searchParams: Promise.resolve({ q: 'enviar contrato' }) });
    assert(elementos(achou).some((e) => e.props.href === '/admin/ajuda/contratos#secao-0'));
    const nada = await tela.render('default', { searchParams: Promise.resolve({ q: 'xilofone' }) });
    assert.match(texto(nada), /Nenhum artigo encontrado para “xilofone”/);
    const lista2 = await tela.render('default', { searchParams: Promise.resolve({ q: ['a', 'b'] }) });
    assert(elementos(lista2).some((e) => e.props['data-lista'] !== undefined), 'q repetido vira lista, sem erro');

    const sem = await montarPagina('app/admin/ajuda/page.tsx', null).render('default', {});
    assert.equal(elementos(sem).some((e) => e.props['data-central'] !== undefined), false, 'sem corpus, sem seção de artigos');
    assert.match(texto(sem), /Fale com a equipe iA.Fest/);
});

test('página do artigo: renderiza o publicado e responde 404 para pendente, de empresa, inexistente ou id inválido', async () => {
    const tela = montarPagina('app/admin/ajuda/[artigo]/page.tsx', CORPUS);
    const pagina = await tela.render('default', { params: Promise.resolve({ artigo: 'contratos' }) });
    assert.match(texto(pagina), /Como enviar o contrato para assinatura/);
    assert(elementos(pagina).some((e) => e.type === 'ol'));
    assert(elementos(pagina).some((e) => e.type === 'strong' && texto(e) === 'festa'));
    assert(elementos(pagina).some((e) => e.props.href === '/admin/disponibilidade'));
    assert(elementos(pagina).some((e) => e.props.id === 'secao-0'));
    for (const artigo of ['pendente', 'da-empresa', 'futuro', 'nao-existe', '../manifesto', 'A']) {
        await assert.rejects(async () => tela.render('default', { params: Promise.resolve({ artigo }) }), /NEXT_NOT_FOUND/, artigo);
    }
});

test('AdminShell: ajuda e artigos abertos sem empresa e com acesso bloqueado; link da tela só do servidor', () => {
    const shell = readFileSync(new URL('../../components/admin/AdminShell.tsx', import.meta.url), 'utf8');
    assert.match(shell, /!ROTAS_ABERTAS_SEM_EMPRESA\.includes\(path\) && !rotaDaAjuda\(path\)/);
    assert.match(shell, /!ROTAS_ABERTAS_BLOQUEADO\.includes\(path\) && !rotaDaAjuda\(path\)/);
    assert.match(shell, /artigoDaRota\(path, artigosAjuda, hojeBrasilia\(\)\)/);
    // O assistente da agenda não abre por cima da ajuda (onde a pessoa vai entender a agenda).
    assert.match(shell, /path !== CONSENTIMENTO_MCP && !rotaDaAjuda\(path\) && <AssistenteAgendaPendente/);
    assert.match(shell, /EmpresaSuporteContext\.Provider value=\{vitrine \? null : contexto\?\.empresaAtual\?\.id \?\? null\}/);
    for (const layout of ['../../app/admin/layout.tsx', '../../app/clientes/layout.tsx']) {
        assert.match(readFileSync(new URL(layout, import.meta.url), 'utf8'), /artigosAjuda=\{artigosDaCentral\(carregarCorpusAprovado\(\), hojeBrasilia\(\)\)\.map\(\(a\) => \(\{ id: a\.id, ate: a\.ate \}\)\)\}/, layout);
    }
    // Componentes do navegador não podem puxar o índice do servidor (node:fs / node:crypto).
    for (const cliente of ['../../components/admin/ajuda/CodigoSuporte.tsx', './ajuda-da-tela.ts', './codigo.ts']) {
        const fonte = readFileSync(new URL(cliente, import.meta.url), 'utf8');
        assert.equal(/conhecimento\/|suporte\/central|node:/.test(fonte), false, cliente);
    }
});

test('AdminShell renderizado: chip "Ajuda desta tela" só com artigo publicado da tela; ajuda aberta sem empresa e bloqueada', async () => {
    // O chip é verificado no componente real (sessão simulada), não no texto-fonte: comentado, inalcançável ou com o link
    // errado, o teste reprova (achado P2 do Astra no recorte de production, 03/11/2026; gêmea em staging).
    const marca = (nome: string) => Object.assign(function Marca() { return null; }, { displayName: nome });
    const contextoFalso = () => ({ Provider: function Provider(p: { children?: unknown }) { return p.children; } });
    const Link = marca('Link');
    const suporte = contextoFalso();
    const Assistente = marca('AssistenteAgendaPendente');
    let caminho = '/admin/contratos';
    let sessao: object = {};
    const deps = {
        'next/navigation': { usePathname: () => caminho, useRouter: () => ({ replace() {}, push() {} }) },
        'next/link': { default: Link },
        '@/lib/http/admin-fetch': { trocarEmpresaAtiva: async () => ({}) },
        '@/lib/http/contexto-empresa-cliente': { marcaDaSessao: () => 0, registrarContextoEmpresa: () => true, reiniciarContextoEmpresa() {}, saidaDaSessaoEmAndamento: () => false, sessaoObsoletaDesde: () => false },
        '@/lib/enderecos/cliente': { conferirLeituraDaSessao: (l: { resposta: { json: () => unknown } }) => l.resposta.json(), enderecoFinal: () => false },
        './shell.module.css': cssFalso, './tokens.module.css': cssFalso, './admin.module.css': cssFalso,
        './AdminIcon': { AdminIcon: marca('AdminIcon') },
        '@/lib/admin/navegacao': { itemAtivo: () => false, itensNavegacao: () => [] },
        './sair': { lembrarCsrf() {}, sairDaSessao: async () => {} },
        './PermissoesAdmin': { PermissoesAdminContext: contextoFalso() },
        './inteligencia/PerguntarKidmais': { BotaoPerguntarKidmais: marca('BotaoPerguntarKidmais'), PerguntarKidmaisProvider: marca('PerguntarKidmaisProvider') },
        './LogoEmpresa': { default: marca('LogoEmpresa'), LogoEmpresaContext: contextoFalso(), MarcaEmpresa: marca('MarcaEmpresa'), useLogoEmpresa: () => null },
        './AvisoContexto': { default: marca('AvisoContexto') },
        './AvisoComercial': { default: marca('AvisoComercial') },
        './ExportacaoDados': { ExportacaoEmpresasSuspensas: marca('ExportacaoEmpresasSuspensas') },
        '@/lib/suporte/rota': { ROTA_AJUDA: '/admin/ajuda' },
        '@/lib/suporte/ajuda-da-tela': { artigoDaRota, rotaDaAjuda },
        '@/lib/financeiro/calculos': { hojeBrasilia: () => HOJE },
        './ajuda/CodigoSuporte': { EmpresaSuporteContext: suporte },
        './AssistenteAgenda': { AssistenteAgendaPendente: Assistente },
        '@/lib/http/retorno-login': { CONSENTIMENTO_MCP: '/admin/conexoes-ia/autorizar', loginDestaPagina: () => '/admin/login' },
    };
    const conteudo = jsx('section', { id: 'conteudo-da-tela' });
    const EMPRESAS = [{ id: EMPRESA, nome: 'Buffet Teste', papel: 'REPRESENTANTE_AUTORIZADO' }];
    const globais = globalThis as Record<string, unknown>;
    const antes = { window: globais.window, fetch: globais.fetch };
    globais.window = { setInterval: () => 0, setTimeout: () => 0, addEventListener() {}, removeEventListener() {}, location: { replace() {} } };
    globais.fetch = async () => ({ json: async () => ({ ok: true, data: sessao }) });
    async function montar(rota: string, artigosAjuda: readonly { id: string; ate: string | null }[], opcoes: { nivel?: string; empresas?: typeof EMPRESAS; vitrine?: boolean } = {}) {
        caminho = rota;
        const empresas = opcoes.empresas ?? EMPRESAS;
        sessao = { usuarioId: 'u1', nome: 'Ana', sessaoId: 's1', csrf: 'c', cadastroAberto: false, recursos: {}, comercial: { nivel: opcoes.nivel ?? 'ATIVO', cobrado: true },
            contexto: { empresas, empresaAtual: empresas[0] ?? null, gestaoNaEmpresa: true, plataforma: false, desenvolvedor: false, selecaoNecessaria: false } };
        const props = { children: conteudo, artigosAjuda, ...(opcoes.vitrine ? { vitrine: { nome: 'Administrador', caminho: rota } } : {}) };
        const shell = carregarComponente('components/admin/AdminShell.tsx', deps);
        shell.render('default', props);
        shell.efeitos();
        for (let i = 0; i < 5; i++) await tique();
        const arvore = shell.render('default', props);
        const chips = elementos(arvore).filter((e) => e.type === Link && e.props['data-ajuda-da-tela']);
        const tela = elementos(arvore).some((e) => e.props?.id === 'conteudo-da-tela');
        const assistente = elementos(arvore).some((e) => e.type === Assistente);
        return { arvore, chips, tela, assistente, titulo: texto(elementos(arvore).find((e) => e.type === 'h1')) };
    }
    const publicado = (...ids: string[]) => ids.map((id) => ({ id, ate: null }));
    try {
        const comArtigo = await montar('/admin/contratos', publicado('contratos', 'festas'));
        assert.equal(comArtigo.chips.length, 1);
        assert.equal(comArtigo.chips[0].props.href, '/admin/ajuda/contratos');
        assert.match(texto(comArtigo.chips[0]), /Ajuda desta tela/);
        assert(comArtigo.tela, 'a tela continua abaixo do chip');
        // #298: o assistente da agenda abre nas telas da empresa, nunca por cima da ajuda nem do consentimento do MCP.
        assert(comArtigo.assistente, 'assistente da agenda nas telas da empresa');
        assert.equal((await montar('/admin/ajuda/contratos', publicado('contratos'))).assistente, false, 'sem assistente na ajuda');
        assert.equal((await montar('/admin/conexoes-ia/autorizar', publicado('contratos'))).assistente, false, 'sem assistente no consentimento');
        const provedor = elementos(comArtigo.arvore).find((e) => e.type === suporte.Provider);
        assert.equal(provedor?.props.value, EMPRESA, 'código de suporte da empresa ativa');
        // Prefixo mais longo e subtelas: /admin/fechamentos não é tela, mas cobre a revisão.
        assert.equal((await montar('/admin/fechamentos/abc/revisao', publicado('fechamento-de-festa'))).chips[0]?.props.href, '/admin/ajuda/fechamento-de-festa');
        assert.equal((await montar('/admin/configuracoes/importar-documentos', publicado('importar-documentos'))).chips[0]?.props.href, '/admin/ajuda/importar-documentos');
        // Sem chip: artigo não publicado, vencido, tela sem artigo e vitrine.
        for (const [rota, artigos, vitrine] of [
            ['/admin/contratos', [], false], ['/admin/contratos', [{ id: 'contratos', ate: '2026-10-31' }], false],
            ['/admin/configuracoes', publicado('contratos', 'perfil-da-empresa'), false], ['/admin/contratos', publicado('contratos'), true],
        ] as const) {
            const r = await montar(rota, artigos, { vitrine });
            assert.equal(r.chips.length, 0, `${rota} ${JSON.stringify(artigos)} vitrine=${vitrine}`);
            assert(r.tela, rota);
        }
        // Acesso bloqueado: a tela de negócio dá lugar ao aviso (sem chip); ajuda e assinatura seguem abertas.
        const bloqueada = await montar('/admin/contratos', publicado('contratos'), { nivel: 'BLOQUEADO' });
        assert.equal(bloqueada.titulo, 'Acesso suspenso até a assinatura');
        assert.equal(bloqueada.chips.length + Number(bloqueada.tela) + Number(bloqueada.assistente), 0);
        assert((await montar('/admin/ajuda/contratos', publicado('contratos'), { nivel: 'BLOQUEADO' })).tela, 'artigo aberto com acesso bloqueado');
        assert.equal((await montar('/admin/assinatura', publicado('assinatura-e-plano'), { nivel: 'BLOQUEADO' })).chips[0]?.props.href, '/admin/ajuda/assinatura-e-plano');
        // Sem empresa ativa: só conta e ajuda.
        const semEmpresa = await montar('/admin/contratos', publicado('contratos'), { empresas: [] });
        assert.equal(semEmpresa.titulo, 'Sem empresa ativa');
        assert.equal(semEmpresa.chips.length + Number(semEmpresa.tela), 0);
        assert((await montar('/admin/ajuda', publicado('contratos'), { empresas: [] })).tela, 'ajuda aberta sem empresa');
    } finally {
        globais.window = antes.window;
        globais.fetch = antes.fetch;
    }
});

test('âncora de artigo: só o atributo id da tela conta (nem comentário, nem data-testid, nem aria)', () => {
    const ids = idsDaTela([
        'export default function T() { return <main>',
        '    {/* <div id="comentado" /> */}',
        '    <section id="secao" data-testid="so-teste" aria-labelledby="rotulo"><h2 id={\'chave\'}>A</h2><p id={`modelo`}>B</p></section>',
        '</main>; }',
    ].join('\n'));
    assert.deepEqual([...ids].sort(), ['chave', 'modelo', 'secao']);
    // Controle com a tela real que a central já usa (/admin/ajuda#t-falar).
    const ajuda = idsDaTela(readFileSync(new URL('../../app/admin/ajuda/page.tsx', import.meta.url), 'utf8'));
    assert(ajuda.has('t-falar'));
    assert.equal(ajuda.has('nao-existe'), false);
});

test('corpus real: endereço de mídia não acha artigo; artigo fora de APROVADO some da central', () => {
    const corpus = carregarCorpusAprovado();
    assert(corpus);
    // Termos que só existem dentro de endereços de mídia (nome de arquivo, extensão, pasta) não acham nada.
    const textos = corpus.documentos.flatMap((d) => [d.titulo, ...d.secoes.flatMap((s) => [s.titulo, s.texto])]);
    const limpos = new Set(textos.flatMap((t) => termos(semEnderecoDeMidia(t))));
    const soNoEndereco = [...new Set(textos.flatMap((t) => termos(t)))].filter((t) => !limpos.has(t));
    assert(soNoEndereco.includes('mp4') && soNoEndereco.includes('imagen'), `controle: ${soNoEndereco.join(' ')}`);
    for (const consulta of soNoEndereco) assert.deepEqual(buscarNaCentral(corpus, HOJE, consulta), [], consulta);
    for (const d of corpus.documentos) {
        const retirado: Corpus = { documentos: corpus.documentos.map((x) => (x === d ? { ...x, situacao: 'SUSPENSO' as const } : x)) };
        assert.equal(artigosDaCentral(retirado, HOJE).some((a) => a.id === d.id), false, d.id);
        assert.equal(artigoDaCentral(retirado, HOJE, d.id), null, d.id);
        assert.equal(buscarNaCentral(retirado, HOJE, d.titulo).some((r) => r.id === d.id), false, d.id);
    }
});

test('corpus real: carrega, todo arquivo da pasta está no manifesto e toda tela aponta para artigo existente', () => {
    const corpus = carregarCorpusAprovado();
    assert(corpus, 'manifesto e hashes válidos');
    const manifesto = JSON.parse(readFileSync(new URL('../../conhecimento/manifesto.json', import.meta.url), 'utf8')) as { documentos: { arquivo: string; id: string; acl: { tipo: string } }[] };
    const listados = new Set(manifesto.documentos.map((d) => d.arquivo));
    for (const arquivo of readdirSync(new URL('../../conhecimento/', import.meta.url)).filter((a) => a.endsWith('.md'))) assert(listados.has(arquivo), `fora do manifesto: ${arquivo}`);
    const ids = new Set(manifesto.documentos.map((d) => d.id));
    for (const [rota, id] of Object.entries(ARTIGO_DA_ROTA)) {
        assert(ids.has(id), `${rota} → ${id} sem artigo`);
        // O mapa é por prefixo: vale se a rota é uma tela ou cobre telas abaixo dela (ex.: /admin/fechamentos/[id]/revisao).
        assert(telasSob(`app${rota}`).length > 0, `${rota}: nenhuma tela neste código`);
    }
    for (const d of manifesto.documentos) {
        const fonte = readFileSync(new URL(`../../conhecimento/${d.arquivo}`, import.meta.url), 'utf8');
        assert.equal(fonte.includes('\r'), false, `${d.arquivo} em LF`);
        for (const linhaFonte of fonte.split('\n')) {
            const bloco = midia(linhaFonte.trim());
            if (bloco) {
                assert(bloco.tipo === 'imagem' || bloco.tipo === 'video', `${d.arquivo}: mídia fora da regra: ${linhaFonte}`);
                const arquivos = bloco.tipo === 'imagem' ? [bloco.src] : [bloco.src, bloco.capa, bloco.legenda];
                for (const arquivo of arquivos) assert(existsSync(new URL(`../../public${arquivo}`, import.meta.url)), `${d.arquivo}: ${arquivo} ausente em public/`);
                continue;
            }
            for (const m of linhaFonte.matchAll(/\]\(([^)]+)\)/g)) {
                assert(linkInterno(m[1]), `${d.arquivo}: link ${m[1]}`);
                const tela = new URL(`../../app${m[1].split(/[?#]/)[0]}/page.tsx`, import.meta.url);
                assert(existsSync(tela), `${d.arquivo}: tela ${m[1]} inexistente`);
                // Âncora só se a própria tela tiver o id (os artigos de hoje não usam; a guarda vale para os próximos).
                const ancora = m[1].split('#')[1];
                if (ancora) assert(idsDaTela(readFileSync(tela, 'utf8')).has(ancora), `${d.arquivo}: âncora #${ancora} inexistente em ${m[1]}`);
            }
        }
    }
});
