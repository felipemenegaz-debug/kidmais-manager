import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';
import type { Conexao, Estado } from './ConexoesAssistentes';
import type { PedidoTela } from './ConsentimentoAssistente';

// Renderiza as telas reais. CSS e rede são isolados; não abre banco nem navegador. Dados 100% sintéticos.
const semRede = () => { throw new Error('Rede proibida neste teste.'); };
const dubles = {
    'workspace.module.css': {}, 'admin.module.css': {}, 'visual.module.css': {}, 'conexoes-assistentes.module.css': {},
    'http/admin-fetch': { adminFetch: semRede }, 'components/admin/sair': { sairDaSessao: semRede },
};
const cache = new Map<string, Record<string, unknown>>();
const modulo = carregarModulo('components/admin/ConexoesAssistentes.tsx', dubles, cache) as {
    TelaConexoes: ComponentType<Record<string, unknown>>; CorpoConexoes: ComponentType<Record<string, unknown>>; passoSugerido: (s: { codigo: string }) => number;
    podeIrParaPrimeiraConsulta: (s: { codigo: string }) => boolean;
    bloqueioDaPrimeiraConsulta: (c: { ativa: Conexao | null; situacao: { codigo: string } }, canal: boolean, nome: string, ajuda: boolean) => string | null;
};
const consentimento = carregarModulo('components/admin/ConsentimentoAssistente.tsx', dubles, cache) as {
    FormularioConsentimento: ComponentType<Record<string, unknown>>; escoposIniciais: (p: readonly string[]) => string[];
};
const guia = carregarModulo('components/admin/conexoes-assistentes-guia.ts', dubles, cache) as {
    GUIAS: Record<string, { links: ReadonlyArray<{ url: string }> }>; PERGUNTA_PRIMEIRA_CONSULTA: string; ORIENTACOES: ReadonlyArray<{ id: string; oQueFazer: string }>;
};

const CHATGPT = 'https://chatgpt.com/oauth/metadata.json';
const EV = { motivoRevogacao: null, credencialInvalida: false, codigoUsado: true, codigoPendente: false, tokenVigente: true, ultimaFalha: null };

function conexao(extra: Partial<Conexao> = {}): Conexao {
    return { id: 'c1', clientId: CHATGPT, clienteNome: 'ChatGPT', empresaId: 'e1', empresaNome: 'Buffet Sintético', escopos: ['conhecimento:read'], criadaEm: '2026-11-05T16:00:00Z', ultimoUsoEm: null, ultimaFerramentaEm: null, revogadaEm: null, empresaNoPiloto: true, consultaDaAjudaLiberada: true, evidencias: EV, ...extra };
}
function estado(conexoes: Conexao[] = [], extra: Partial<Estado> = {}): Estado {
    return {
        canal: { ativo: true, urlServidor: 'https://exemplo.test/api/mcp' },
        identidade: { usuario: { nome: 'Pessoa Sintética', email: 'pessoa@example.test' }, empresaAtual: { id: 'e1', nome: 'Buffet Sintético' }, empresas: [{ id: 'e1', nome: 'Buffet Sintético' }], selecaoNecessaria: false, empresaNoPiloto: true },
        conexoes, falhasDisponiveis: true, ajudaDisponivel: true, ...extra,
    };
}
function html(e: Estado, props: Record<string, unknown> = {}) {
    return renderToStaticMarkup(createElement(modulo.TelaConexoes, { estado: e, revogar: semRede, ocupado: null, atualizar: semRede, atualizando: false, ...props })).replace(/&#x27;/g, "'");
}

test('cartões ChatGPT e Claude: sem conexão, aguardando autorização; identidade em destaque', () => {
    const h = html(estado());
    assert.match(h, /data-cartao="chatgpt"/);
    assert.match(h, /data-cartao="claude"/);
    assert.equal((h.match(/data-situacao="AGUARDANDO_AUTORIZACAO"/g) ?? []).length, 2);
    assert.match(h, /data-usuario="true">Pessoa Sintética · pessoa@example\.test/);
    assert.match(h, /data-empresa-ativa="true">Buffet Sintético/);
    assert.doesNotMatch(h, /data-cartao="gemini"/);
});

test('o status nunca vem da saúde do servidor nem de botão de teste interno', () => {
    const h = html(estado([conexao()]));
    assert.doesNotMatch(h, /testar conex|health|servidor online|data-testar/i);
    assert.match(h, /não testa o assistente/);
    assert.match(h, /Ficar sem uso não desconecta/);
});

test('consulta recebida: mostra data e horário; autorizada sem consulta não diz que funcionou', () => {
    const sem = html(estado([conexao()]), { assistenteInicial: 'chatgpt', passoInicial: 5 });
    assert.match(sem, /data-aguardando-consulta/);
    assert.doesNotMatch(sem, /data-consulta-confirmada/);
    const com = html(estado([conexao({ ultimaFerramentaEm: '2026-11-05T16:55:00Z' })]), { assistenteInicial: 'chatgpt', passoInicial: 5 });
    assert.match(com, /data-consulta-confirmada/);
    assert.match(com, /Última consulta bem-sucedida em 05\/11\/2026/);
});

test('primeiro uso: pergunta documental pronta, sem agenda nem financeiro', () => {
    // A conexão sintética é do ChatGPT: a pergunta só aparece com conexão utilizável deste assistente.
    const h = html(estado([conexao()]), { assistenteInicial: 'chatgpt', passoInicial: 5 });
    assert.match(h, /data-pergunta/);
    assert.match(guia.PERGUNTA_PRIMEIRA_CONSULTA, /Não consulte agenda nem financeiro/);
});

test('exemplos só das permissões concedidas; financeiro não aparece sem a permissão', () => {
    const so = html(estado([conexao()]));
    assert.match(so, /Pela ajuda do iA\.Fest/);
    assert.doesNotMatch(so, /Qual o resumo de contas a receber/);
    assert.match(so, /data-escopo-faltando/);
    // A nova autorização substitui a anterior: tela e guia mandam marcar o que manter e o que adicionar (8º parecer).
    const reconectar = /marque as permissões que deseja manter e as que deseja adicionar: a nova autorização substitui a anterior/;
    assert.match(so.match(/data-escopo-faltando[^>]*>([^<]*)</)?.[1] ?? '', reconectar);
    assert.match(guia.ORIENTACOES.find((o) => o.id === 'permissao')?.oQueFazer ?? '', reconectar);
    const todos = html(estado([conexao({ escopos: ['conhecimento:read', 'agenda:read', 'financeiro:read'] })]));
    assert.match(todos, /Qual o resumo de contas a receber/);
    assert.match(todos, /Quantas festas tenho hoje/);
    assert.doesNotMatch(todos, /data-escopo-faltando/);
});

test('causa comprovada fica separada das sugestões; falha temporária não pede reconexão', () => {
    const h = html(estado([conexao({ ultimaFerramentaEm: '2026-11-05T16:55:00Z', evidencias: { ...EV, ultimaFalha: { codigo: 'INDISPONIVEL', capacidade: 'kidmais_buscar_conhecimento', em: '2026-11-05T17:00:00Z' } } })]));
    assert.match(h, /data-falha-comprovada/);
    assert.match(h, /Não é preciso reconectar/);
    assert.match(h, /data-recuperacao/);
    assert.match(h, /podem não ser a causa/);
});

test('recuperação cobre as cinco situações e nenhuma manda apagar e recriar como primeiro passo', () => {
    assert.deepEqual(guia.ORIENTACOES.map((o) => o.id).sort(), ['cliente-oauth', 'conta-empresa', 'indisponivel', 'nao-habilitado', 'permissao', 'reconectar']);
    for (const o of guia.ORIENTACOES) assert.doesNotMatch(o.oQueFazer, /^(apague|recrie|remova|delete)/i, o.id);
});

test('empresa fora do piloto ou sem seleção: não deixa seguir para a configuração', () => {
    const fora = estado();
    fora.identidade = { ...fora.identidade!, empresaNoPiloto: false };
    assert.match(html(fora, { assistenteInicial: 'chatgpt', passoInicial: 2 }), /data-fora-do-piloto[\s\S]*disabled=""[^>]*data-continuar/);
    const semSelecao = estado();
    semSelecao.identidade = { ...semSelecao.identidade!, empresaAtual: null, selecaoNecessaria: true, empresaNoPiloto: false };
    assert.match(html(semSelecao, { assistenteInicial: 'claude', passoInicial: 2 }), /data-escolher-empresa/);
});

test('identidade indisponível não esconde a lista: desconectar continua disponível', () => {
    const h = html(estado([conexao()], { identidade: null }));
    assert.match(h, /data-revogar="c1"/);
    assert.match(h, /Não foi possível confirmar o usuário/);
});

test('identidade indisponível: cartões dizem situação não confirmada, nunca aguardando autorização', () => {
    const h = html(estado([conexao()], { identidade: null }));
    assert.equal((h.match(/data-cartao=/g) ?? []).length, 2);
    assert.equal((h.match(/data-situacao="NAO_CONFIRMADA"/g) ?? []).length, 2);
    assert.doesNotMatch(h, /Aguardando autorização/);
    assert.match(h, /data-conexao="c1"/, 'a conexão segue listada com a própria situação');
    const guia = html(estado([conexao()], { identidade: null }), { assistenteInicial: 'chatgpt', passoInicial: 4 });
    assert.doesNotMatch(guia, /Aguardando autorização/);
    assert.match(guia, /disabled=""[^>]*data-continuar/);
});

test('canal desligado: lista e desconectar continuam; sem endereço', () => {
    const h = html(estado([conexao()], { canal: { ativo: false, urlServidor: null } }), { assistenteInicial: 'chatgpt', passoInicial: 3 });
    assert.match(h, /data-canal="desligado"/);
    assert.doesNotMatch(h, /data-url-servidor/);
    assert.match(h, /data-revogar="c1"/);
});

test('etapa 3: só links oficiais conferidos, abertos sem referer; sem promessa de um clique', () => {
    const permitidos = new Set(['https://chatgpt.com/plugins', 'https://developers.openai.com/api/docs/guides/custom-mcp-server', 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp']);
    for (const id of ['chatgpt', 'claude']) {
        for (const l of guia.GUIAS[id].links) assert.ok(permitidos.has(l.url), l.url);
        const h = html(estado(), { assistenteInicial: id, passoInicial: 3 });
        assert.match(h, /data-url-servidor/);
        assert.match(h, /rel="noopener noreferrer"/);
        assert.doesNotMatch(h, /um clique|automaticamente conectad/i);
        const externos = [...h.matchAll(/href="(https:[^"]+)"/g)].map((m) => m[1]);
        assert.ok(externos.length > 0 && externos.every((u) => permitidos.has(u)), externos.join());
    }
});

test('guia: primeira consulta só com conexão utilizável pela situação calculada (9º parecer, P3)', () => {
    for (const c of ['AUTORIZADA_SEM_CONSULTA', 'CONSULTA_OK']) assert.equal(modulo.podeIrParaPrimeiraConsulta({ codigo: c }), true, c);
    for (const c of ['NAO_CONFIRMADA', 'AGUARDANDO_AUTORIZACAO', 'PRECISA_RECONECTAR', 'DESCONECTADA', 'SUBSTITUIDA']) assert.equal(modulo.podeIrParaPrimeiraConsulta({ codigo: c }), false, c);
    // Concessão não revogada (ativa) sem credencial vigente: Precisa reconectar, Continuar desligado, orientação para refazer.
    const semCredencial = html(estado([conexao({ evidencias: { ...EV, tokenVigente: false } })]), { assistenteInicial: 'chatgpt', passoInicial: 4 });
    assert.match(semCredencial, /data-situacao="PRECISA_RECONECTAR"/);
    assert.match(semCredencial, /disabled=""[^>]*data-continuar/);
    assert.match(semCredencial, /data-bloqueio-consulta="true">Esta conexão precisa ser refeita antes da primeira consulta/);
    const utilizavel = html(estado([conexao()]), { assistenteInicial: 'chatgpt', passoInicial: 4 });
    assert.doesNotMatch(utilizavel, /disabled=""[^>]*data-continuar/);
    assert.doesNotMatch(utilizavel, /data-bloqueio-consulta/);
});

test('guia: a primeira consulta respeita a permissão escolhida e o canal, no passo 4 e no passo 5 (10º parecer, P2)', () => {
    const passo = (e: Estado, p: number) => html(e, { assistenteInicial: 'chatgpt', passoInicial: p });
    // Só agenda: a pergunta pronta (documentação) não funcionaria.
    const soAgenda = estado([conexao({ escopos: ['agenda:read'] })]);
    assert.match(passo(soAgenda, 4), /disabled=""[^>]*data-continuar/);
    assert.match(passo(soAgenda, 4), /data-bloqueio-consulta="true">A pergunta pronta usa a ajuda e documentação/);
    const p5 = passo(soAgenda, 5);
    assert.match(p5, /data-consulta-bloqueada/);
    assert.doesNotMatch(p5, /data-pergunta/);
    assert.doesNotMatch(p5, /Copiar pergunta/);
    // Canal desligado: nada a consultar, mesmo com conexão utilizável.
    const desligado = estado([conexao()], { canal: { ativo: false, urlServidor: null } });
    assert.match(passo(desligado, 4), /disabled=""[^>]*data-continuar/);
    assert.doesNotMatch(passo(desligado, 5), /data-pergunta/);
    // Credencial vence com o passo 5 já aberto: "Precisa reconectar" e nenhuma pergunta oferecida.
    const vencida = passo(estado([conexao({ evidencias: { ...EV, tokenVigente: false } })]), 5);
    assert.match(vencida, /data-situacao-agora="PRECISA_RECONECTAR"/);
    assert.doesNotMatch(vencida, /data-pergunta/);
    assert.match(vencida, /refeita antes da primeira consulta/);
    // Utilizável, canal ligado e com a permissão: a pergunta aparece.
    assert.match(passo(estado([conexao({ escopos: ['agenda:read', 'conhecimento:read'] })]), 5), /data-pergunta/);
    assert.equal(modulo.bloqueioDaPrimeiraConsulta({ ativa: conexao(), situacao: { codigo: 'AUTORIZADA_SEM_CONSULTA' } }, true, 'ChatGPT', true), null);
});

test('guia: empresa fora do piloto ou consultas desligadas para a empresa bloqueiam a pergunta nos passos 4 e 5 (11º parecer, P2)', () => {
    const passo = (e: Estado, p: number) => html(e, { assistenteInicial: 'chatgpt', passoInicial: p });
    for (const [extra, motivo] of [[{ empresaNoPiloto: false }, /não está no piloto agora/], [{ consultaDaAjudaLiberada: false }, /desligadas para esta empresa neste ambiente/]] as const) {
        const e = estado([conexao(extra)]);
        assert.match(passo(e, 4), /disabled=""[^>]*data-continuar/);
        assert.match(passo(e, 4), motivo);
        assert.doesNotMatch(passo(e, 5), /data-pergunta/);
        assert.match(passo(e, 5), motivo);
    }
});

test('guia: consulta já registrada mostra "Funcionou" mesmo com a pergunta pronta bloqueada (11º parecer, P3)', () => {
    const h = html(estado([conexao({ escopos: ['agenda:read'], ultimaFerramentaEm: '2026-11-08T13:00:00Z' })]), { assistenteInicial: 'chatgpt', passoInicial: 5 });
    assert.match(h, /data-consulta-bloqueada/);
    assert.doesNotMatch(h, /data-pergunta/);
    assert.match(h, /data-consulta-confirmada="true">Funcionou/);
});

test('passo sugerido segue a evidência', () => {
    assert.equal(modulo.passoSugerido({ codigo: 'AGUARDANDO_AUTORIZACAO' }), 2);
    assert.equal(modulo.passoSugerido({ codigo: 'DESCONECTADA' }), 2);
    assert.equal(modulo.passoSugerido({ codigo: 'PRECISA_RECONECTAR' }), 2);
    assert.equal(modulo.passoSugerido({ codigo: 'AUTORIZADA_SEM_CONSULTA' }), 5);
    assert.equal(modulo.passoSugerido({ codigo: 'CONSULTA_OK' }), 5);
});

const PEDIDO: PedidoTela = {
    clienteNome: 'Claude', clientHost: 'claude.ai', redirectHost: 'claude.ai', escopos: ['agenda:read', 'financeiro:read', 'conhecimento:read'], expiraEm: '2026-11-05T17:00:00Z', empresaNoPiloto: true,
    usuario: { nome: 'Pessoa Sintética', email: 'pessoa@example.test' }, empresas: [{ id: 'e1', nome: 'Buffet Sintético' }, { id: 'e2', nome: 'Buffet Beta' }],
};
const formulario = (pedido: PedidoTela = PEDIDO) => renderToStaticMarkup(createElement(consentimento.FormularioConsentimento, { pedido, empresa: { id: 'e1', nome: 'Buffet Sintético' }, ocupado: false, enviar: semRede, trocarConta: semRede }));

test('consentimento: mesmo com o assistente pedindo tudo, financeiro e agenda começam desmarcados', () => {
    assert.deepEqual(consentimento.escoposIniciais(PEDIDO.escopos), ['conhecimento:read']);
    assert.deepEqual(consentimento.escoposIniciais(['financeiro:read', 'agenda:read']), []);
    const h = formulario();
    const marcados = [...h.matchAll(/<input[^>]*>/g)].map((m) => m[0]).filter((i) => /checked/.test(i));
    assert.equal(marcados.length, 1);
    assert.match(marcados[0], /data-escopo="conhecimento:read"/);
});

test('consentimento: só mostra as permissões pedidas e nunca amplia', () => {
    const h = formulario({ ...PEDIDO, escopos: ['conhecimento:read'] });
    assert.doesNotMatch(h, /data-escopo="financeiro:read"/);
    assert.doesNotMatch(h, /data-escopo="agenda:read"/);
});

test('consentimento: permissões em linguagem simples, ajuda primeiro', () => {
    const h = formulario();
    const ajuda = h.indexOf('Consultar ajuda e documentação');
    assert.ok(ajuda >= 0 && ajuda < h.indexOf('Consultar resumo da agenda') && h.indexOf('Consultar resumo da agenda') < h.indexOf('Consultar resumo dos recebíveis'));
});

test('consentimento: usuário e empresa em destaque, com troca de conta e aviso sobre e-mails', () => {
    const h = formulario();
    assert.match(h, /data-usuario="true">Pessoa Sintética · pessoa@example\.test/);
    assert.match(h, /data-empresa="true">Buffet Sintético/);
    assert.match(h, /data-trocar-conta/);
    assert.match(h, /data-trocar-empresa="true">Para conectar outra empresa, troque a empresa ativa no menu da conta\. A troca leva ao painel e não volta para esta página\. Depois, volte ao assistente e inicie a conexão de novo/);
    assert.doesNotMatch(h, /botão Voltar/);
    // 9º parecer, P3: reabrir o link só vale com o pedido pendente e no prazo; responder encerra o pedido.
    assert.match(h, /O link anterior só abre este pedido outra vez enquanto ele estiver sem resposta e dentro do prazo, até \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}: Permitir ou Não permitir encerra o pedido\./);
    assert.doesNotMatch(h, /pode ser reaberto/);
    assert.match(h, /data-prazo-pedido="true">Este pedido fica aberto até [^<]*, enquanto não for respondido: Permitir ou Não permitir o encerra./);
    assert.doesNotMatch(h, /<select/, 'a troca de empresa é a do menu da conta, não desta tela');
    assert.match(h, /não precisa ser igual ao do iA\.Fest/);
    assert.match(h, /não passa sozinha para outro usuário ou empresa/);
    assert.match(h, /não o cancela/);
});

test('consentimento: uma empresa só não oferece troca de empresa; conta continua trocável', () => {
    const h = formulario({ ...PEDIDO, empresas: [{ id: 'e1', nome: 'Buffet Sintético' }] });
    assert.doesNotMatch(h, /data-trocar-empresa/);
    assert.match(h, /data-trocar-conta/);
});

test('guias orientam a identidade OAuth que este servidor aceita (CIMD), sem registro automático nem cliente próprio', () => {
    const passos = guia.GUIAS as unknown as Record<string, { configurar: readonly string[] }>;
    const claude = passos.claude.configurar.join(' ');
    assert.match(claude, /Use Claude’s published identity/);
    assert.match(claude, /não use “No sign in”/);
    assert.match(claude, /não aceita “Register automatically” nem cliente próprio/);
    assert.match(passos.chatgpt.configurar.join(' '), /Se aparecer a escolha .* \(CIMD\) e não informe client ID nem secret próprios/);
    const oauth = (guia.ORIENTACOES as unknown as ReadonlyArray<{ id: string; oQueFazer: string }>).find((o) => o.id === 'cliente-oauth');
    assert.match(oauth?.oQueFazer ?? '', /published identity.*CIMD/);
});

test('falta de consulta registrada fica como hipótese: não afirma que a pergunta não chegou', () => {
    const o = (guia.ORIENTACOES as unknown as ReadonlyArray<{ id: string; comoConfirmar: string }>).find((x) => x.id === 'nao-habilitado');
    assert.match(o?.comoConfirmar ?? '', /nova consulta registrada/);
    assert.match(o?.comoConfirmar ?? '', /não prova a causa/);
    assert.doesNotMatch(o?.comoConfirmar ?? '', /não chegou/);
});

test('falhas indisponíveis: avisa, mantém situação e Desconectar; sem conexão ativa, não avisa', () => {
    const h = html(estado([conexao({ ultimaFerramentaEm: '2026-11-05T16:55:00Z' })], { falhasDisponiveis: false }));
    assert.match(h, /data-falhas-indisponiveis/);
    assert.match(h, /pode não mostrar uma falha recente/);
    assert.match(h, /data-revogar="c1"/);
    assert.match(h, /data-situacao="CONSULTA_OK"/);
    assert.doesNotMatch(html(estado([conexao()])), /data-falhas-indisponiveis/);
    assert.doesNotMatch(html(estado([], { falhasDisponiveis: false })), /data-falhas-indisponiveis/);
});

const corpo = (vista: Record<string, unknown>) => renderToStaticMarkup(createElement(modulo.CorpoConexoes, { revogar: semRede, atualizar: semRede, vista: { estado: null, erroLeitura: '', erroRevogacao: '', ocupado: null, emEspera: [], atualizando: false, ...vista } }));

test('primeira leitura sem resposta: oferece tentar de novo; carregando não oferece; com lista, o botão é o de sempre', () => {
    const h = corpo({ erroLeitura: 'Demorou.' });
    assert.match(h, /data-tentar-de-novo/);
    assert.match(h, /Tentar de novo/);
    assert.doesNotMatch(h, /disabled/);
    assert.match(corpo({ erroLeitura: 'Demorou.', atualizando: true }), /disabled[^>]*>Atualizando/);
    assert.doesNotMatch(corpo({}), /data-tentar-de-novo/);
    assert.match(corpo({}), /Carregando/);
    const comLista = corpo({ estado: estado([conexao()]), erroLeitura: 'Demorou.' });
    assert.doesNotMatch(comLista, /data-tentar-de-novo/);
    assert.match(comLista, /data-atualizar-topo/);
});

test('POST sem confirmação: só o botão daquela conexão fica preso, com outro rótulo', () => {
    const h = corpo({ estado: estado([conexao(), conexao({ id: 'c2' })]), emEspera: ['c1'] });
    assert.match(h, /disabled=""[^>]*data-revogar="c1"[^>]*>Aguardando confirmação/);
    assert.match(h, /data-revogar="c2"[^>]*>Desconectar/);
    assert.doesNotMatch(h, /disabled=""[^>]*data-revogar="c2"/);
});

test('guia: ajuda e documentação indisponível (ou campo ausente) bloqueia a pergunta com mensagem própria (12º parecer, P2)', () => {
    const passo = (e: Estado, p: number) => html(e, { assistenteInicial: 'chatgpt', passoInicial: p });
    const semCampo = estado([conexao()]);
    delete (semCampo as { ajudaDisponivel?: boolean }).ajudaDisponivel;
    for (const e of [estado([conexao()], { ajudaDisponivel: false }), semCampo]) {
        assert.match(passo(e, 4), /disabled=""[^>]*data-continuar/);
        assert.match(passo(e, 4), /ajuda e documentação do iA.Fest está indisponível agora/);
        assert.doesNotMatch(passo(e, 5), /data-pergunta/);
        assert.match(passo(e, 5), /ajuda e documentação do iA.Fest está indisponível agora/);
    }
    assert.match(passo(estado([conexao()]), 5), /data-pergunta/);
    assert.match(modulo.bloqueioDaPrimeiraConsulta({ ativa: conexao(), situacao: { codigo: 'AUTORIZADA_SEM_CONSULTA' } }, true, 'ChatGPT', false) ?? '', /indisponível agora/);
});
