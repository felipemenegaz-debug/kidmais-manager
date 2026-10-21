import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DOCUMENTOS, hashDocumento, textoCanonico, versaoVigente } from './documentos-legais.ts';
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

test('documentos legais: versão no formato do banco, hash SHA-256 estável do texto exibido, minuta explícita e lacunas marcadas', () => {
    for (const d of Object.values(DOCUMENTOS)) {
        assert.match(d.versao, VERSAO_DB);
        assert.match(hashDocumento(d), /^[0-9a-f]{64}$/);
        assert.equal(hashDocumento(d), hashDocumento({ ...d, secoes: d.secoes.map((s) => ({ ...s })) }), 'determinístico');
        assert.notEqual(hashDocumento(d), hashDocumento({ ...d, secoes: [...d.secoes, { titulo: 'x', paragrafos: ['y'] }] }), 'mudança no texto muda o hash');
        assert.equal(d.minuta, true, 'textos legais definitivos dependem de revisão jurídica');
        assert.match(textoCanonico(d), /\[A DEFINIR\]/);
    }
    assert.match(textoCanonico(DOCUMENTOS.TERMOS_USO), /não comprova a existência da empresa nem a autoridade/);
});

test('documentos legais 20/10: canal único de contato e prazos 7/60 consistentes, sem decidir lacunas jurídicas', () => {
    assert.equal(DOCUMENTOS.TERMOS_USO.versao, '2026-10-20-minuta');
    // 21/10: versão mínima só com a seção de IA (L5) ampliada para os convites com IA; o resto é idêntico à minuta5.
    assert.equal(DOCUMENTOS.PRIVACIDADE.versao, '2026-10-21-minuta5a');
    for (const d of Object.values(DOCUMENTOS)) {
        const texto = textoCanonico(d);
        assert.match(texto, /contato@demerzellabs\.com\.br/, `${d.documento}: canal oficial`);
        assert.doesNotMatch(texto, /felipemenegaz@gmail\.com|glass@demerzellabs\.com\.br/, `${d.documento}: contatos anteriores removidos`);
        assert.doesNotMatch(texto, /R\$/, `${d.documento}: os textos legais não citam preços`);
    }
    const termos = textoCanonico(DOCUMENTOS.TERMOS_USO);
    assert.doesNotMatch(termos, /por um período/, 'somente leitura sempre com o prazo aprovado');
    assert.equal(termos.match(/somente leitura por 60 dias/g)?.length, 2, 'as duas seções citam os mesmos 60 dias');
    assert.equal(termos.match(/7 dias para regularizar/g)?.length, 2);
    assert.equal(textoCanonico(DOCUMENTOS.TERMOS_USO).match(/\[A DEFINIR\]/g)?.length, 2, 'L1 devolução e L2 retenção continuam abertas');
    assert.equal(textoCanonico(DOCUMENTOS.PRIVACIDADE).match(/\[A DEFINIR\]/g)?.length, 9, 'L3–L11 continuam abertas');
});

test('privacidade minuta5a: só a seção de IA muda (convites com IA, L5); sem os acréscimos, o hash volta ao da minuta5', () => {
    const d = structuredClone(DOCUMENTOS.PRIVACIDADE);
    const ia = d.secoes.find((x) => x.titulo === 'Recursos de inteligência artificial')!;
    assert.equal(ia.paragrafos.length, 4);
    ia.paragrafos.splice(1, 2);
    ia.paragrafos[1] = ia.paragrafos[1].replace('A ativação de cada recurso depende da verificação de suas condições contratuais e das salvaguardas aplicáveis. ', '');
    // Hash da 2026-10-20-minuta5 (publicada em 20/10, 7ce0916) — o resto do aviso é idêntico, letra por letra.
    assert.equal(hashDocumento({ ...d, versao: '2026-10-20-minuta5' }), '06e7b9a5098bd8f6325bca15a67cb472668a7fa5f487df2e08e957e365c2bfcf');
    assert.equal(DOCUMENTOS.PRIVACIDADE.minuta, true);
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
    assert.equal(codigo(() => validarPedidoCadastro(pedido({ privacidadeVersao: '2026-10-20-minuta5' }))), 'DADOS_INVALIDOS', 'a minuta5 (sem os convites com IA na seção de IA) exige aceite do texto atualizado');
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
