import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CONTATO_KIDMAIS, PACOTES_FECHAMENTO_V1 } from './data.ts';
import { CODIGO_PACOTE, codigoServidorDoPacoteDaMarca, pacoteDaTela, pacotesExibidos, type FatosPacote } from './pacotes-tela.ts';
import { contatoPublicoDe } from '../../lib/fechamentos/marca-publica.ts';
import { carregarModulo, executorFalso } from '../../lib/acessos/teste-carregador.ts';

// Classes do CSS module viram o próprio nome: o teste olha o HTML, não o estilo.
const estilos = new Proxy({}, { get: (_alvo, nome) => String(nome) });
const dubles = { 'components/fechamento/FechamentoWizard.module.css': estilos };
function componente(arquivo: string) { return carregarModulo(arquivo, dubles, new Map()).default as ComponentType<Record<string, unknown>>; }
const EscolhaPacote = componente('components/fechamento/EscolhaPacote.tsx');
const ContatoEmpresa = componente('components/fechamento/ContatoEmpresa.tsx');
const nada = () => undefined;

// Resposta de /api/fechamentos/pacotes de um buffet que só vende o Pocket (como a empresa sintética do navegador local).
const SO_POCKET: FatosPacote = { POCKET: { nome: 'Pocket sintético', descricao: null, duracaoMinutos: 180, convidadosMinimos: 10, convidadosMaximos: 60, precoMinimo: '2100.00' } };
// Tudo o que identifica o catálogo/contato da Kidmais e não pode aparecer para outro buffet.
const MARCAS_KIDMAIS = [
    /kidmais/i, /scienza/i, /Mini Festa/, /Festa Compacta/, /Festa Essencial/, /Festa Completa/, /Festa Premium/, /Pizza Party/,
    /Mais escolhida/, /Experiência completa/, /5\.100/, /6\.490/, /3\.800/, /99340-5359/, /kidmaisfestas/, /Segunda a quinta/,
];
function semKidmais(html: string) {
    for (const marca of MARCAS_KIDMAIS) assert.doesNotMatch(html, marca);
}
function render(props: Record<string, unknown>) {
    return renderToStaticMarkup(createElement(EscolhaPacote, { falha: false, selecionado: '', onEscolher: nada, onTentarNovamente: nada, ...props }));
}

test('outra empresa: só os pacotes que o servidor devolveu, com nome, preço e descrição dela', () => {
    const itens = pacotesExibidos(false, PACOTES_FECHAMENTO_V1, SO_POCKET);
    // Em /b o id da tela é o código do pacote da empresa (o mesmo que a API devolve).
    assert.deepEqual(itens, [{ id: 'POCKET', nome: 'Pocket sintético', preco: 2100, descricao: 'Descrição não cadastrada.', disponibilidade: null, destaque: null }]);
    const html = render({ itens });
    assert.match(html, /Pocket sintético/);
    assert.match(html, /A partir de R\$\s?2\.100,00/);
    assert.equal((html.match(/<button/g) ?? []).length, 1, 'um cartão só');
    semKidmais(html);
});

test('outra empresa: pacote criado em Novo pacote (P_…) aparece com os dados dela, na ordem do servidor', () => {
    const LIVRE = 'P_9F2C4E1A7B3D4C5E8F6A0B1C2D3E4F5A';
    const fatos: FatosPacote = { ...SO_POCKET, [LIVRE]: { nome: 'Festa Jardim', descricao: 'Ao ar livre', duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 80, precoMinimo: '4500.00' } };
    const itens = pacotesExibidos(false, PACOTES_FECHAMENTO_V1, fatos)!;
    assert.deepEqual(itens.map((i) => i.id), ['POCKET', LIVRE]);
    const html = render({ itens, selecionado: LIVRE });
    assert.match(html, /Festa Jardim/);
    assert.match(html, /Ao ar livre/);
    assert.equal((html.match(/<button/g) ?? []).length, 2);
    semKidmais(html);
    assert.deepEqual(pacoteDaTela(false, PACOTES_FECHAMENTO_V1, fatos, LIVRE), { id: LIVRE, nome: 'Festa Jardim', precoInicial: 4500, minPagantes: 30, maxPagantes: 80,
        limiteCadastrado: true, descricao: 'Ao ar livre', disponibilidade: '', duracao: '240 minutos', buffet: '' });
    assert.equal(codigoServidorDoPacoteDaMarca(false, LIVRE), LIVRE, 'catálogo do buffet e adicionais pedidos pelo código');
    assert.equal(codigoServidorDoPacoteDaMarca(true, LIVRE), undefined, 'endereço atual: só os sete');
    assert.equal(codigoServidorDoPacoteDaMarca(true, 'pocket'), 'POCKET');
    assert.equal(codigoServidorDoPacoteDaMarca(false, ''), undefined);
});

test('outra empresa: carregando, falha e lista vazia nunca caem no catálogo da Kidmais', () => {
    assert.equal(pacotesExibidos(false, PACOTES_FECHAMENTO_V1, null), null);
    assert.deepEqual(pacotesExibidos(false, PACOTES_FECHAMENTO_V1, {}), []);
    const carregando = render({ itens: null });
    const falha = render({ itens: null, falha: true });
    const vazia = render({ itens: [] });
    assert.match(carregando, /Carregando os pacotes/);
    assert.match(falha, /Não foi possível carregar os pacotes agora/);
    assert.match(falha, /Tentar novamente/);
    assert.match(vazia, /Nenhum pacote disponível para orçamento online/);
    for (const html of [carregando, falha, vazia]) {
        assert.doesNotMatch(html, /packageCard/);
        semKidmais(html);
    }
});

test('outra empresa: pacote não oferecido não é escolhido; o escolhido não herda texto, regra ou limite da Kidmais', () => {
    assert.equal(pacoteDaTela(false, PACOTES_FECHAMENTO_V1, SO_POCKET, 'MINI_FESTA'), undefined);
    assert.equal(pacoteDaTela(false, PACOTES_FECHAMENTO_V1, SO_POCKET, 'pocket'), undefined, 'em /b o id V1 não é traduzido');
    assert.equal(pacoteDaTela(false, PACOTES_FECHAMENTO_V1, null, 'POCKET'), undefined, 'antes da lista chegar');
    assert.equal(pacoteDaTela(false, PACOTES_FECHAMENTO_V1, { PIZZA_PARTY: { ...SO_POCKET.POCKET!, nome: 'Pizza da casa' } }, 'PIZZA_PARTY')?.sobConsulta, undefined);
    const pocket = pacoteDaTela(false, PACOTES_FECHAMENTO_V1, SO_POCKET, 'POCKET');
    assert.deepEqual(pocket, { id: 'POCKET', nome: 'Pocket sintético', precoInicial: 2100, minPagantes: 10, maxPagantes: 60, limiteCadastrado: true,
        descricao: '', disponibilidade: '', duracao: '180 minutos', buffet: '' });
    semKidmais(JSON.stringify(pocket));
    const semLimite = pacoteDaTela(false, PACOTES_FECHAMENTO_V1, { POCKET: { ...SO_POCKET.POCKET!, convidadosMinimos: null, convidadosMaximos: null, precoMinimo: null } }, 'POCKET');
    assert.equal(semLimite?.limiteCadastrado, false);
    assert.equal(semLimite?.minPagantes, 1);
    assert.equal(semLimite?.precoInicial, null);
});

test('Kidmais (endereço atual): catálogo, selos e horários inalterados, com ou sem dados publicados', () => {
    // Mesmo cálculo da versão anterior da tela, para provar que o legado não mudou.
    const legado = (fatos: FatosPacote | null) => PACOTES_FECHAMENTO_V1.map((item) => {
        const publicado = fatos?.[CODIGO_PACOTE[item.id]!];
        return { id: item.id, nome: publicado?.nome ?? item.nome,
            preco: publicado ? (publicado.precoMinimo == null ? null : Number(publicado.precoMinimo)) : item.precoInicial,
            descricao: publicado ? (publicado.descricao || 'Descrição não cadastrada.') : item.descricao,
            disponibilidade: item.disponibilidade, destaque: item.destaque ?? null };
    });
    for (const fatos of [null, {}, SO_POCKET]) assert.deepEqual(pacotesExibidos(true, PACOTES_FECHAMENTO_V1, fatos), legado(fatos));
    const html = render({ itens: pacotesExibidos(true, PACOTES_FECHAMENTO_V1, null), selecionado: 'essencial' });
    assert.equal((html.match(/<button/g) ?? []).length, PACOTES_FECHAMENTO_V1.length);
    for (const item of PACOTES_FECHAMENTO_V1) {
        assert.ok(html.includes(item.nome), item.nome);
        assert.ok(html.includes(item.disponibilidade), item.disponibilidade);
        if (item.destaque) assert.ok(html.includes(item.destaque), item.destaque);
    }
    assert.match(html, /Selecionado/);
    for (const item of PACOTES_FECHAMENTO_V1) {
        const fato = { nome: `${item.nome} publicado`, descricao: null, duracaoMinutos: 200, convidadosMinimos: 7, convidadosMaximos: null, precoMinimo: '10.00' };
        assert.deepEqual(pacoteDaTela(true, PACOTES_FECHAMENTO_V1, null, item.id), { ...item, limiteCadastrado: true });
        assert.deepEqual(pacoteDaTela(true, PACOTES_FECHAMENTO_V1, { [CODIGO_PACOTE[item.id]!]: fato }, item.id),
            { ...item, limiteCadastrado: true, nome: fato.nome, minPagantes: 7, maxPagantes: item.maxPagantes, precoInicial: 10, duracao: '200 minutos' });
    }
});

test('contatos: só os da empresa, conferidos; sem contato não renderiza nada', () => {
    const contato = contatoPublicoDe({ whatsapp: '5511988887777', telefone: '1133334444', email: 'contato@buffet.test',
        site: 'https://www.buffet.test/', instagram: 'https://instagram.com/buffet_teste' });
    const html = renderToStaticMarkup(createElement(ContatoEmpresa, { nome: 'Buffet Sintético', contato, titulo: 'Fale com Buffet Sintético' }));
    assert.match(html, /Fale com Buffet Sintético/);
    assert.match(html, /href="https:\/\/wa\.me\/5511988887777"/);
    assert.match(html, /\(11\) 98888-7777/);
    assert.match(html, /href="tel:\+551133334444"/);
    assert.match(html, /\(11\) 3333-4444/);
    assert.match(html, /mailto:contato@buffet\.test/);
    assert.match(html, /@buffet_teste/);
    assert.match(html, />buffet\.test</);
    semKidmais(html);
    assert.equal(renderToStaticMarkup(createElement(ContatoEmpresa, { nome: 'Buffet Sintético', contato: null })), '');
    assert.ok(!html.includes(CONTATO_KIDMAIS.whatsapp));
});

test('contatos: valor inválido some, sem completar com outro dado', () => {
    assert.equal(contatoPublicoDe({}), null);
    assert.equal(contatoPublicoDe({ whatsapp: '123', telefone: 'abc', email: 'sem-arroba', site: 'javascript:alert(1)', instagram: 'ftp://x.test' }), null);
    assert.equal(contatoPublicoDe({ site: 'https://usuario:senha@buffet.test' }), null, 'URL com credenciais');
    assert.equal(contatoPublicoDe({ email: 'a@b.test<script>' }), null);
    const so = contatoPublicoDe({ whatsapp: '(61) 3000-0000' });
    assert.deepEqual(so, { whatsapp: { texto: '(61) 3000-0000', url: 'https://wa.me/556130000000' }, telefone: null, email: null, site: null, instagram: null });
    assert.equal(contatoPublicoDe({ instagram: 'https://linktr.ee/buffet' })?.instagram?.texto, 'Instagram');
});

test('contato público lido do cadastro aplicado da unidade; ambíguo, ausente ou com erro → sem contato', async () => {
    const { contatoPublicoDaEmpresa } = carregarModulo('lib/perfil/contato-publico.ts', {}, new Map()) as { contatoPublicoDaEmpresa: (tx: unknown, id: string) => Promise<unknown> };
    const unidade = { telefone: null, whatsapp: '11988887777', email: null, site: null, instagram: null };
    const banco = (unidades: unknown[], perfis: unknown[] = [{ id: 'perfil-1' }]) => executorFalso([
        [/to_regclass\('public\.perfil_empresas'\)/, () => [{ empresas: 'x', concessoes: 'y' }]],
        [/to_regclass\('public\.perfil_unidades'\)/, () => [{ existe: 'z' }]],
        [/FROM public\.perfil_empresas p/, () => perfis],
        [/FROM public\.perfil_unidades/, () => unidades],
    ]);
    const um = banco([unidade]);
    assert.deepEqual(await contatoPublicoDaEmpresa(um, 'empresa-1'), contatoPublicoDe(unidade));
    const leitura = um.executados.find((q) => /FROM public\.perfil_unidades/.test(q.sql))!;
    assert.deepEqual(leitura.params, ['perfil-1']);
    assert.match(leitura.sql, /email_comercial AS email/);
    assert.doesNotMatch(leitura.sql, /revis|rascunho|cep|logradouro|cnpj/i, 'só as colunas aplicadas de contato');
    assert.equal(await contatoPublicoDaEmpresa(banco([unidade, unidade]), 'empresa-1'), null, 'duas unidades');
    assert.equal(await contatoPublicoDaEmpresa(banco([unidade], []), 'empresa-1'), null, 'sem perfil');
    assert.equal(await contatoPublicoDaEmpresa(banco([unidade], [{ id: 'a' }, { id: 'b' }]), 'empresa-1'), null, 'perfil ambíguo');
    assert.equal(await contatoPublicoDaEmpresa({ query: async () => { throw new Error('falha'); } }, 'empresa-1'), null);
});

test('tela: a etapa de pacote não percorre o catálogo fixo nem mostra contato da Kidmais sem a marca', () => {
    const fonte = readFileSync('components/fechamento/FechamentoWizard.tsx', 'utf8');
    assert.doesNotMatch(fonte, /PACOTES_FECHAMENTO_V1\.(map|find|filter)/);
    assert.match(fonte, /<EscolhaPacote\s/);
    assert.match(fonte, /pacotesExibidos\(marca\.kidmais, PACOTES_FECHAMENTO_V1, fatosPacote\)/);
    assert.match(fonte, /pacoteDaTela\(marca\.kidmais, PACOTES_FECHAMENTO_V1, fatosPacote, form\.pacote\)/);
    const pagina = readFileSync('app/b/[empresa]/fechamento/page.tsx', 'utf8');
    assert.match(pagina, /contato=\{empresa\.contato\}/);
});

test('convidados: outra empresa só com mínimo e máximo dela, sem regras nem texto da Kidmais', async () => {
    const { erroConvidadosEmpresa, erroConvidadosFechamento } = await import('../../lib/fechamentos/convidados.ts');
    const pocket = pacoteDaTela(false, PACOTES_FECHAMENTO_V1, SO_POCKET, 'POCKET')!;
    assert.equal(erroConvidadosEmpresa(30, pocket), null);
    assert.equal(erroConvidadosEmpresa(61, pocket), 'Pocket sintético atende até 60 convidados neste pacote.');
    assert.equal(erroConvidadosEmpresa(9, pocket), 'Pocket sintético possui mínimo de 10 pagantes.');
    assert.equal(erroConvidadosEmpresa(0, pocket), 'Informe a quantidade de convidados pagantes.');
    const compacta = pacoteDaTela(false, PACOTES_FECHAMENTO_V1, { COMPACTA: { ...SO_POCKET.POCKET!, nome: 'Compacta da casa', convidadosMaximos: 300 } }, 'COMPACTA')!;
    assert.equal(erroConvidadosEmpresa(41, compacta), null, 'sem a regra de 40 da Festa Compacta');
    // Teto do pedido online = o do servidor (comercial-schema, 150), com redação neutra (sem “A Kidmais atende…”).
    assert.equal(erroConvidadosEmpresa(150, compacta), null);
    assert.equal(erroConvidadosEmpresa(151, compacta), 'O pedido online aceita até 150 convidados. Para mais, fale com o buffet.');
    const semLimite = pacoteDaTela(false, PACOTES_FECHAMENTO_V1, { POCKET: { ...SO_POCKET.POCKET!, convidadosMaximos: null } }, 'POCKET')!;
    assert.equal(erroConvidadosEmpresa(150, semLimite), null, 'máximo não cadastrado: vale o teto do pedido online');
    assert.equal(semLimite.maxPagantes, 150);
    // Endereço atual: a regra da Kidmais continua a mesma.
    assert.match(erroConvidadosFechamento(41, { id: 'compacta', nome: 'Compacta', minPagantes: 40, maxPagantes: 150 })!, /Festa Compacta/);
    assert.match(erroConvidadosFechamento(151, { id: 'pocket', nome: 'Pocket', minPagantes: 20, maxPagantes: 150 })!, /Kidmais atende no máximo 150/);
    const fonte = readFileSync('components/fechamento/FechamentoWizard.tsx', 'utf8');
    assert.match(fonte, /marca\.kidmais \? erroConvidadosFechamento\(convidados, pacote\) : erroConvidadosEmpresa\(convidados, pacote\)/);
});

test('teto de convidados da tela por empresa é o mesmo do servidor (comercial-schema)', async () => {
    const { LIMITE_CONVIDADOS_PEDIDO_ONLINE } = await import('../../lib/fechamentos/convidados.ts');
    const fonte = readFileSync('lib/fechamentos/comercial-schema.ts', 'utf8');
    assert.ok(fonte.includes(`convidadosPagantes: z.coerce.number().int().min(1).max(${LIMITE_CONVIDADOS_PEDIDO_ONLINE})`));
});

test('etapas Buffet e Personalização: textos e campos do catálogo da Kidmais só no endereço dela', async () => {
    const { mensagemFalhaAdicionais } = await import('./adicionais-etapa.ts');
    assert.match(mensagemFalhaAdicionais('PRECO_INDISPONIVEL', false, 'equipe do buffet'), /Fale com a equipe do buffet\.$/);
    assert.match(mensagemFalhaAdicionais('PRECO_INDISPONIVEL'), /Fale com a equipe Kidmais\.$/, 'endereço atual inalterado');
    const fonte = readFileSync('components/fechamento/FechamentoWizard.tsx', 'utf8');
    assert.match(fonte, /\{marca\.kidmais && \(\['buffetLembrancinha','buffetEmpratado','buffetBombom'\] as const\)\.map\(\(key,i\)=>/);
    assert.match(fonte, /\{marca\.kidmais && form\.pacote === "premium" && <p>A Festa Premium inclui 4 bombons\./);
    assert.match(fonte, /\{marca\.kidmais && \(adicionaisDisponiveis \?\? \[\]\)\.some\(\(item\) => item\.categoria === "MESA"\)/);
    assert.match(fonte, /mensagemFalhaAdicionais\(consultaAdicionais\?\.codigo, false, marca\.equipe\)/);
});

test('consulta de CEP: ligada por padrão; desligada só com CONSULTA_CEP_EXTERNA=desligada, sem chamar o serviço externo', async () => {
    const { consultaCepExternaLigada } = await import('../../lib/endereco/consulta-cep-externa.ts');
    assert.equal(consultaCepExternaLigada({}), true);
    assert.equal(consultaCepExternaLigada({ CONSULTA_CEP_EXTERNA: 'ligada' }), true);
    assert.equal(consultaCepExternaLigada({ CONSULTA_CEP_EXTERNA: ' Desligada ' }), false);
    const rota = readFileSync('app/api/endereco/consultar-cep/route.ts', 'utf8');
    const desligado = rota.indexOf('if (!consultaCepExternaLigada())'), chamada = rota.indexOf('fetch(`https://viacep.com.br');
    assert.ok(desligado > 0 && desligado < chamada, 'a recusa vem antes da chamada externa');
    assert.match(rota, /SERVICO_CEP_INDISPONIVEL/);
});
