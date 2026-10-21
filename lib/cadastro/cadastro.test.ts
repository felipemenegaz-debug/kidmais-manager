import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DOCUMENTOS, DOCUMENTOS_COM_ACEITE, hashDocumento, MARCADORES, marcadoresPendentes, textoCanonico, versaoVigente } from './documentos-legais.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { rotaSemprePermitida } from '../assinatura/paywall.ts';

// publico.ts importa db/postgres (sem extensão): carregado com um banco falso que nunca é usado aqui.
const semBanco = { db: () => { throw new Error('sem banco'); }, withTransaction: () => { throw new Error('sem banco'); } };
type Publico = typeof import('./publico.ts');
const { exigirAgendaSemBloqueioGlobal, linkConfirmacao, mensagemConfirmacao, mensagemContaExistente, situacaoCadastro, validarPedidoCadastro } = carregarModulo('lib/cadastro/publico.ts', { 'db/postgres': semBanco }, new Map()) as unknown as Publico;

const VERSAO_DB = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]+)?$/;
const pedido = (o: Record<string, unknown> = {}) => ({
    nome: 'Ana Responsável', email: 'Ana@Exemplo.test ', senha: 'senha-forte-1', confirmacao: 'senha-forte-1',
    aceiteTermos: true, aceitePrivacidade: true, termosVersao: versaoVigente('TERMOS_USO').versao, privacidadeVersao: versaoVigente('PRIVACIDADE').versao, ...o,
});
const codigo = (f: () => unknown) => { try { f(); return 'OK'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } };

test('documentos legais: versão no formato do banco, hash SHA-256 estável do texto exibido (tabelas incluídas), minuta explícita e pendências marcadas', () => {
    assert.deepEqual(Object.keys(DOCUMENTOS).sort(), ['DPA', 'PRIVACIDADE', 'TERMOS_USO']);
    assert.deepEqual([...DOCUMENTOS_COM_ACEITE], ['TERMOS_USO', 'PRIVACIDADE'], 'só estes têm linha própria na 069 (CHECK aceites_documento_check)');
    const rotas = new Set<string>();
    for (const d of Object.values(DOCUMENTOS)) {
        assert.match(d.versao, VERSAO_DB);
        assert.ok(d.versao.length <= 40, 'cabe na coluna e no schema do pedido');
        assert.match(hashDocumento(d), /^[0-9a-f]{64}$/);
        assert.equal(hashDocumento(d), hashDocumento({ ...d, secoes: d.secoes.map((s) => ({ ...s })) }), 'determinístico');
        assert.notEqual(hashDocumento(d), hashDocumento({ ...d, secoes: [...d.secoes, { titulo: 'x', paragrafos: ['y'] }] }), 'mudança no texto muda o hash');
        assert.equal(d.minuta, true, 'textos legais definitivos dependem de revisão jurídica');
        assert.doesNotMatch(textoCanonico(d), /\[A DEFINIR\]/, `${d.documento}: as lacunas L1–L11 viraram texto ou marcador específico`);
        assert.ok(marcadoresPendentes(d).length > 0, `${d.documento}: minuta com pendências visíveis`);
        assert.equal(new Set(d.secoes.map((s) => s.titulo)).size, d.secoes.length, `${d.documento}: títulos únicos (chave da tela)`);
        const ids = d.secoes.flatMap((s) => s.id ? [s.id] : []);
        assert.equal(new Set(ids).size, ids.length, `${d.documento}: âncoras únicas`);
        for (const s of d.secoes) {
            if (!s.tabela) continue;
            const tabela = s.tabela;
            assert.ok(tabela.linhas.every((l) => l.length === tabela.colunas.length), `${d.documento}/${s.titulo}: linhas completas`);
            const semTabela = { ...d, secoes: d.secoes.map((x) => x === s ? { ...x, tabela: undefined } : x) };
            assert.notEqual(hashDocumento(d), hashDocumento(semTabela), `${d.documento}/${s.titulo}: a tabela entra no hash`);
            assert.match(textoCanonico(d), new RegExp(tabela.linhas[0].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(' \\| ')));
        }
        rotas.add(d.rota);
    }
    assert.deepEqual([...rotas].sort(), ['/acordo-de-tratamento', '/privacidade', '/termos']);
    assert.match(textoCanonico(DOCUMENTOS.TERMOS_USO), /não comprova a existência da empresa nem a autoridade/);
    // Sem tabela, o texto canônico é o mesmo formato de antes (título, versão, títulos e parágrafos).
    assert.equal(textoCanonico({ documento: 'TERMOS_USO', titulo: 'T', versao: '2026-01-01', minuta: true, rota: '/termos', secoes: [{ titulo: 'A', paragrafos: ['b', 'c'] }] }), 'T\nVersão 2026-01-01\nA\nb\nc');
});

test('documentos legais 21/10 (v2, parecer Astra): versões novas, responsável por marcador, DPA incorporado aos Termos e pendências listadas', () => {
    assert.equal(DOCUMENTOS.TERMOS_USO.versao, '2026-10-21-minuta');
    assert.equal(DOCUMENTOS.PRIVACIDADE.versao, '2026-10-21-minuta6');
    assert.equal(DOCUMENTOS.DPA.versao, '2026-10-21-minuta');
    for (const d of Object.values(DOCUMENTOS)) {
        const texto = textoCanonico(d);
        assert.match(texto, /contato@demerzellabs\.com\.br/, `${d.documento}: canal oficial`);
        assert.doesNotMatch(texto, /felipemenegaz@gmail\.com|glass@demerzellabs\.com\.br/, `${d.documento}: contatos anteriores removidos`);
        assert.doesNotMatch(texto, /R\$/, `${d.documento}: os textos legais não citam preços`);
        assert.doesNotMatch(texto, /Mary Marra|20\.119\.900|EPP/, `${d.documento}: o novo CNPJ substitui a EPP (decisão de Felipe, 21/10)`);
        for (const m of MARCADORES.IDENTIFICACAO) assert.ok(texto.includes(m), `${d.documento}: ${m} enquanto o CNPJ não sai`);
        for (const m of marcadoresPendentes(d))
            assert.ok(MARCADORES.IDENTIFICACAO.includes(m as never) || m === MARCADORES.CONSENTIMENTO
                || [MARCADORES.DECISAO, MARCADORES.CONTROLE, MARCADORES.EVIDENCIA, MARCADORES.AVALIACAO].some((p) => m.startsWith(p)), `${d.documento}: marcador fora do padrão: ${m}`);
    }
    const termos = textoCanonico(DOCUMENTOS.TERMOS_USO), privacidade = textoCanonico(DOCUMENTOS.PRIVACIDADE), dpa = textoCanonico(DOCUMENTOS.DPA);
    // DPA aceito por incorporação: os Termos citam versão e SHA-256 completo; mudar o DPA obriga nova versão dos Termos.
    assert.ok(termos.includes(`Acordo de Tratamento de Dados, versão ${versaoVigente('DPA').versao}, impressão digital ${versaoVigente('DPA').hash}`));
    assert.match(termos, /integra estes Termos e é aceito junto com eles, em nome da empresa/);
    // 7/60 continuam consistentes.
    assert.doesNotMatch(termos, /por um período/, 'somente leitura sempre com o prazo aprovado');
    assert.equal(termos.match(/somente leitura por 60 dias/g)?.length, 2, 'as duas seções citam os mesmos 60 dias');
    assert.equal(termos.match(/7 dias para regularizar/g)?.length, 2);
    // Decisões de Felipe (L1, L2) e textos da Astra.
    assert.match(termos, /15 dias de teste grátis, sem cartão e sem cobrança automática/);
    assert.match(termos, /Nos primeiros 7 dias da primeira ativação paga, devolveremos integralmente o valor pago/);
    assert.match(termos, /devolução proporcional aos dias não utilizados/);
    assert.match(termos, /nem cobramos de volta o desconto Fundador/);
    assert.match(termos, /por até 12 meses contados da suspensão/);
    assert.match(termos, /pelo menos 30 dias de antecedência da exclusão programada/);
    assert.match(termos, /continuam sendo dela/);
    assert.match(termos, /Pessoas e empresas ligadas à Kidmais também atuam no mercado de buffets infantis/);
    assert.match(privacidade, /__Host-kidmais_admin, com validade máxima de 8 horas/);
    assert.match(privacidade, /Os filtros reduzem a exposição, mas não garantem anonimização/);
    assert.match(privacidade, /região Virginia, Estados Unidos/);
    assert.match(privacidade, /DeepSeek é uma integração opcional, atualmente sem uso confirmado/);
    assert.match(privacidade, /em até 15 dias contados do pedido/);
    assert.match(privacidade, /Quando houver indicação de encarregado/);
    for (const prestador of ['Render', 'Asaas', 'Resend', 'Meta/WhatsApp', 'Gupshup', 'OpenAI', 'Google Gemini', 'ViaCEP', 'DeepSeek'])
        assert.ok(DOCUMENTOS.PRIVACIDADE.secoes.some((s) => s.tabela?.linhas.some((l) => l[0] === prestador)), `relação de prestadores: ${prestador}`);
    // Conteúdo mínimo do anexo de L4 (Astra).
    for (const titulo of ['Instruções e duração', 'Titulares e dados tratados', 'Uso próprio e confidencialidade', 'Segurança e acesso de suporte', 'Suboperadores',
        'Transferências internacionais', 'Direitos dos titulares e assistência', 'Incidentes de segurança', 'Término: devolução, exclusão e cópias de segurança'])
        assert.ok(DOCUMENTOS.DPA.secoes.some((s) => s.titulo === titulo), `DPA: seção ${titulo}`);
    assert.match(dpa, /pelo menos 30 dias de antecedência\. Nesse prazo, a Empresa pode apresentar objeção fundamentada/);
    assert.match(dpa, /meta contratual de até 24 horas a partir da ciência/);
    assert.match(dpa, /não é o prazo legal de comunicação à ANPD/);
    // Pendências que Felipe precisa ver (não decididas) e controles que ainda não existem.
    for (const [texto, padrao] of [
        [privacidade, /\[DECISÃO PENDENTE: L10 /], [privacidade, /\[DECISÃO PENDENTE: L11 /], [privacidade, /\[DECISÃO PENDENTE: tabela de retenção/],
        [termos, /\[DECISÃO PENDENTE: reajuste /], [dpa, /\[DECISÃO PENDENTE: tabela de retenção/],
    ] as const) assert.match(texto, padrao);
    assert.ok(privacidade.includes(MARCADORES.CONSENTIMENTO), 'convites com IA: comportamento planejado depende do consentimento');
    assert.equal(termos.match(/\[CONTROLE AINDA NÃO IMPLEMENTADO:/g)?.length, 8);
    assert.equal(privacidade.match(/\[CONTROLE AINDA NÃO IMPLEMENTADO:/g)?.length, 5);
    assert.equal(dpa.match(/\[CONTROLE AINDA NÃO IMPLEMENTADO:/g)?.length, 3);
    // Lista completa: qualquer marcador novo ou resolvido aparece na revisão do teste.
    assert.deepEqual(Object.fromEntries(Object.values(DOCUMENTOS).map((d) => [d.documento, marcadoresPendentes(d).length])), { TERMOS_USO: 15, PRIVACIDADE: 19, DPA: 10 });
});

test('cadastro: telas e API apontam para o Acordo de Tratamento de Dados; a rota pública existe', () => {
    assert.match(readFileSync('app/acordo-de-tratamento/page.tsx', 'utf8'), /DOCUMENTOS\.DPA/);
    assert.match(readFileSync('app/api/cadastro/route.ts', 'utf8'), /acordoTratamento: versaoVigente\('DPA'\)\.versao/);
    for (const tela of ['app/cadastro/page.tsx', 'app/cadastro/empresa/page.tsx'])
        assert.match(readFileSync(tela, 'utf8'), /href="\/acordo-de-tratamento"/, tela);
    assert.match(readFileSync('lib/cadastro/publico.ts', 'utf8'), /acordoTratamento: \{ versao: versaoVigente\('DPA'\)\.versao, hash: versaoVigente\('DPA'\)\.hash \}/);
    assert.match(readFileSync('components/cadastro/DocumentoLegal.tsx', 'utf8'), /id=\{s\.id\}/);
    const ancoras = (d: keyof typeof DOCUMENTOS) => DOCUMENTOS[d].secoes.flatMap((s) => s.id ? [s.id] : []);
    for (const id of ['cancelamento', 'contato']) assert.ok(ancoras('TERMOS_USO').includes(id), `/termos#${id}`);
    for (const id of ['tratamento-de-dados', 'exclusao-de-dados']) assert.ok(ancoras('PRIVACIDADE').includes(id), `/privacidade#${id}`);
});

test('cadastro só abre com flag, e-mail configurado e criação direta desligada', () => {
    const base = { CADASTRO_PUBLICO_ATIVO: 'true', USUARIOS_CRIACAO_DIRETA: 'desativada', EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: process.platform === 'win32' ? 'C:\\tmp\\x' : '/tmp/x', NODE_ENV: 'development' };
    assert.equal(situacaoCadastro(base).ativo, true);
    assert.equal(situacaoCadastro({ ...base, CADASTRO_PUBLICO_ATIVO: undefined }).ativo, false);
    assert.match(situacaoCadastro({ ...base, USUARIOS_CRIACAO_DIRETA: undefined }).motivo ?? '', /criação direta/);
    assert.match(situacaoCadastro({ ...base, EMAIL_PROVIDER: 'desativado' }).motivo ?? '', /e-mail/);
    assert.equal(situacaoCadastro({ ...base, RENDER: 'true' }).ativo, false, 'provedor de arquivo nunca vale em deploy');
});

test('pedido: e-mail normalizado; exige aceites da versão vigente e senha válida; nada de banco', () => {
    assert.equal(validarPedidoCadastro(pedido()).email, 'ana@exemplo.test');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ aceiteTermos: false }))), 'DADOS_INVALIDOS');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ aceitePrivacidade: undefined }))), 'DADOS_INVALIDOS');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ termosVersao: '2020-01-01' }))), 'DADOS_INVALIDOS');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: '2026-10-13-minuta' }))), 'DADOS_INVALIDOS', 'o texto anterior não autoriza um novo aceite da versão atual');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: '2026-10-15-minuta' }))), 'DADOS_INVALIDOS', 'a revisão anterior também exige novo aceite');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: '2026-10-15-minuta2' }))), 'DADOS_INVALIDOS', 'a revisão da retenção exige aceite do texto atualizado');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: '2026-10-15-minuta4' }))), 'DADOS_INVALIDOS', 'a troca do canal de contato exige aceite do texto atualizado');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ termosVersao: '2026-10-13-minuta' }))), 'DADOS_INVALIDOS', 'termos anteriores ao canal único também exigem novo aceite');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ termosVersao: '2026-10-20-minuta' }))), 'DADOS_INVALIDOS', 'termos publicados em 20/10 não cobrem o DPA incorporado na v2');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: '2026-10-20-minuta5' }))), 'DADOS_INVALIDOS', 'o aviso publicado em 20/10 exige aceite do texto v2');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: versaoVigente('DPA').versao }))), 'DADOS_INVALIDOS', 'a versão do DPA não substitui a da privacidade');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ senha: 'curta', confirmacao: 'curta' }))), 'SENHA_INVALIDA');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ confirmacao: 'outra-senha-1' }))), 'SENHA_INVALIDA');
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ extra: 1 }))), 'DADOS_INVALIDOS', 'campos estranhos recusados');
});

test('mensagens: token só no fragmento do link; conta existente não recebe link de confirmação', () => {
    const token = 'A'.repeat(43);
    const link = linkConfirmacao(token, 'https://manager.exemplo.test');
    assert.equal(link, `https://manager.exemplo.test/cadastro/confirmar#t=${token}`);
    const m = mensagemConfirmacao('ana@exemplo.test', link);
    assert.ok(m.texto.includes(link) && m.html.includes(link));
    const existente = mensagemContaExistente('ana@exemplo.test', 'https://manager.exemplo.test');
    assert.doesNotMatch(existente.texto + existente.html, /#t=|cadastro\/confirmar/);
});

test('rotas do cadastro: sempre permitidas pelo paywall; pedido responde 202 igual com after(); confirmação abre sessão; empresa usa a guarda', () => {
    assert.equal(rotaSemprePermitida('/api/cadastro/empresa'), true);
    const pedidoRota = readFileSync('app/api/cadastro/route.ts', 'utf8');
    assert.match(pedidoRota, /after\(async \(\) =>/);
    assert.match(pedidoRota, /responder\(\{ ok: true, data: \{ mensagem: MENSAGEM_PEDIDO_CADASTRO \} \}, 202\)/);
    assert.match(readFileSync('app/api/cadastro/confirmar/route.ts', 'utf8'), /verificarOrigem\(request\)/);
    const empresa = readFileSync('app/api/cadastro/empresa/route.ts', 'utf8');
    assert.match(empresa, /exigirApiAdminCrmDisponivel\(request\)/);
    assert.match(empresa, /MENSAGEM_CNPJ_EXISTENTE/);
    const servico = readFileSync('lib/cadastro/publico.ts', 'utf8');
    assert.doesNotMatch(servico, /plataforma_desenvolvedores|REPRESENTANTE_AUTORIZADO'\)\s*,\s*\$|papel\s*=\s*'REPRESENTANTE_AUTORIZADO'\s+WHERE id/, 'cadastro nunca concede plataforma');
    assert.match(servico, /inserirIdentidadeNeutra\(tx, p\.email/);
});

test('E2: cadastro público recusa (503) enquanto houver bloqueio de agenda antigo sem empresa; falha de leitura também recusa', async () => {
    const consultas: string[] = [];
    const tx = (n: unknown) => ({ query: async (sql: string) => { consultas.push(sql); return { rows: n === undefined ? [] : [{ n }], rowCount: 1 }; } });
    const erro = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { return `${(e as { code?: string }).code}:${(e as { httpStatus?: number; status?: number }).httpStatus ?? (e as { status?: number }).status}`; } };
    assert.equal(await erro(exigirAgendaSemBloqueioGlobal(tx(0) as never)), 'OK');
    assert.equal(await erro(exigirAgendaSemBloqueioGlobal(tx(2) as never)), 'CADASTRO_INDISPONIVEL:503');
    assert.equal(await erro(exigirAgendaSemBloqueioGlobal(tx(undefined) as never)), 'CADASTRO_INDISPONIVEL:503', 'sem resposta: fechado');
    assert.match(consultas[0], /empresa_id IS NULL AND ativo AND data >= current_date/);
    const fonte = readFileSync(new URL('./publico.ts', import.meta.url), 'utf8');
    assert.match(fonte, /await exigirAgendaSemBloqueioGlobal\(tx\);\s+if \(!await consumirLimite\(tx, 'IDENTIFICADOR', sessao\.usuario_id, REGRA_EMPRESA\)\)/, 'dentro do cadastro da empresa, antes de criá-la');
});
