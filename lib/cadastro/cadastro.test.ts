import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DOCUMENTOS, hashDocumento, textoCanonico, versaoVigente } from './documentos-legais.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { rotaSemprePermitida } from '../assinatura/paywall.ts';

// publico.ts importa db/postgres (sem extensão): carregado com um banco falso que nunca é usado aqui.
const semBanco = { db: () => { throw new Error('sem banco'); }, withTransaction: () => { throw new Error('sem banco'); } };
type Publico = typeof import('./publico.ts');
const { linkConfirmacao, mensagemConfirmacao, mensagemContaExistente, situacaoCadastro, validarPedidoCadastro } = carregarModulo('lib/cadastro/publico.ts', { 'db/postgres': semBanco }, new Map()) as unknown as Publico;

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
