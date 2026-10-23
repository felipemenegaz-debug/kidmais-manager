import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { codigoErro } from './sincronizacao.ts';
import { erroAcesso } from '../acessos/erros.ts';

const { motivoSeguro } = createRequire(import.meta.url)('../../scripts/assinatura-reconciliar.cjs') as { motivoSeguro: (m: unknown) => string | null };

test('recusa de domínio: ultimo_erro guarda só o código e a conferência D-C4 o preserva', () => {
    const e = erroAcesso('FUNDADOR_OFERTA_EXPIRADA', 'Mensagem com 529.982.247-25 que não pode vazar', 409);
    const gravado = codigoErro(e);
    assert.equal(gravado, 'ERRO_INTERNO: FUNDADOR_OFERTA_EXPIRADA');
    assert.equal(motivoSeguro(gravado), 'ERRO_INTERNO: FUNDADOR_OFERTA_EXPIRADA', 'o relatório D-C4 mostra o código');
    assert.doesNotMatch(gravado, /529|Mensagem/);
});

test('erro comum continua ERRO_INTERNO: <nome>; código fora do padrão não entra', () => {
    assert.equal(codigoErro(new TypeError('x')), 'ERRO_INTERNO: TypeError');
    const ruim = Object.assign(new Error('y'), { name: 'AcessoServiceError', code: 'ruim; DROP' });
    assert.equal(codigoErro(ruim), 'ERRO_INTERNO: AcessoServiceError');
});
