import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Guarda estática da trava da reconciliação (#147 sobre a 074a). A prova de comportamento está nas suítes PostgreSQL no
 * estado `075` (contratacao-e8, transacao-com-prazo); aqui só se impede que a trava fraca se espalhe ou que alguém passe a
 * escrever antes do marcador.
 */
const ler = (f: string) => readFileSync(f, 'utf8');

test('FOR NO KEY UPDATE só na reconciliação; todo o resto continua com FOR UPDATE', () => {
    const ofertas = ler('lib/assinatura/ofertas.ts');
    const comercial = ofertas.slice(ofertas.indexOf('export async function travarEmpresaComercial('), ofertas.indexOf('export async function travarEmpresaParaReconciliacao('));
    assert.match(comercial, /FROM empresas WHERE id = \$1::uuid FOR UPDATE'/);
    assert.doesNotMatch(comercial, /NO KEY UPDATE'/);
    const reconciliacao = ofertas.slice(ofertas.indexOf('export async function travarEmpresaParaReconciliacao('), ofertas.indexOf('export async function exigirEmpresaCobravel('));
    assert.match(reconciliacao, /FOR NO KEY UPDATE'/);
    const usos = ['lib/assinatura/cobranca.ts', 'lib/assinatura/sincronizacao.ts', 'lib/assinatura/reconciliacao-contratacao.ts', 'lib/assinatura/servico.ts',
        'lib/assinatura/renovacao-repositorio.ts', 'lib/assinatura/limites-usuarios.ts']
        .filter((f) => ler(f).includes('travarEmpresaParaReconciliacao'));
    assert.deepEqual(usos, ['lib/assinatura/reconciliacao-contratacao.ts'], 'a trava fraca é exclusiva da reconciliação');
    assert.ok(!ler('lib/assinatura/reconciliacao-contratacao.ts').includes('travarEmpresaComercial('));
});

test('reconciliação: trava antes de ler; no ramo das duplicatas nada é escrito antes do marcador (o gatilho da 074a tomaria FOR UPDATE)', () => {
    const rec = ler('lib/assinatura/reconciliacao-contratacao.ts').replace(/\r\n/g, '\n');
    const corpo = rec.slice(rec.indexOf('export async function reconciliarContratacao('));
    const trava = corpo.indexOf('await travarEmpresaParaReconciliacao(tx, empresaId);');
    assert.ok(trava > 0 && trava < corpo.indexOf('FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR UPDATE'), 'a trava vem antes de qualquer leitura');
    const ramo = corpo.slice(corpo.indexOf('const preservadas:'), corpo.indexOf('const marcadorId = await persistirMarcadorPrevio('));
    assert.ok(ramo.length > 0);
    assert.doesNotMatch(ramo, /tx\.query\(\s*[`'"](UPDATE|INSERT|DELETE)/, 'nenhuma escrita na transação principal antes do marcador');
    assert.doesNotMatch(ramo, /auditarCobranca\(tx/);
});
