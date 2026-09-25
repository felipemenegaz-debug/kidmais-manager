import assert from 'node:assert/strict';
import test from 'node:test';
import { cadastroVazio, type CadastroPerfil } from './cadastro.ts';
import { aposOperacao, cadastrosIguais, linhasAntesDepois, podeAplicar, recarregarDepoisDeAplicar } from './tela-cadastro.ts';

function base(parcial: Partial<CadastroPerfil> = {}): CadastroPerfil {
    return { ...cadastroVazio(), nomeComercial: 'Kidmais', unidade: { ...cadastroVazio().unidade, complemento: 'Sala 1' }, ...parcial };
}

const pronto = { sujo: false, ocupado: false, numero: 2, edicao: 4, motivo: 'Correção', permitir: true, confirmado: true };

test('não aplica rascunho salvo enquanto o formulário tem alteração local', () => {
    assert.equal(podeAplicar({ ...pronto, sujo: true }), false);
    assert.equal(podeAplicar({ ...pronto, confirmado: false }), false);
    assert.equal(podeAplicar(pronto), true);
});

test('erro, conflito e resposta tardia preservam o texto digitado', () => {
    const digitado = base({ nomeComercial: 'Texto local' });
    const enviado = base({ nomeComercial: 'Texto enviado' });
    for (const caso of [
        aposOperacao({ formAtual: digitado, enviado, ok: false, tardio: false }),
        aposOperacao({ formAtual: digitado, enviado, ok: true, tardio: true }),
    ]) {
        assert.equal(caso.form.nomeComercial, 'Texto local');
        assert.equal(caso.atualizarSalvo, false);
    }
});

test('edição feita durante o envio permanece e o salvo é só o que foi enviado', () => {
    const enviado = base({ nomeComercial: 'Enviado' });
    const durante = base({ nomeComercial: 'Digitado depois' });
    const efeito = aposOperacao({ formAtual: durante, enviado, ok: true, tardio: false });
    assert.equal(efeito.form.nomeComercial, 'Digitado depois');
    assert.equal(efeito.salvo?.nomeComercial, 'Enviado');
    assert.equal(cadastrosIguais(efeito.form, efeito.salvo ?? durante), false);
    assert.equal(recarregarDepoisDeAplicar(durante, enviado), 'preservar');
    assert.equal(recarregarDepoisDeAplicar(enviado, enviado), 'substituir');
});

test('a comparação mostra o complemento da unidade antes e depois', () => {
    const linhas = linhasAntesDepois(base(), base({ unidade: { ...cadastroVazio().unidade, complemento: 'Sala 2' } }));
    const complemento = linhas.find((linha) => linha.rotulo === 'Complemento da unidade');
    assert.equal(complemento?.antes, 'Sala 1');
    assert.equal(complemento?.depois, 'Sala 2');
});
