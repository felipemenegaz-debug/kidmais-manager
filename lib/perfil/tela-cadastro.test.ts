import assert from 'node:assert/strict';
import test from 'node:test';
import { cadastroVazio, type CadastroPerfil } from './cadastro.ts';
import { normalizarCadastro } from './cadastro.ts';
import {
    aposCarga,
    aposConflito,
    aposOperacao,
    aplicarResultadoOperacao,
    cadastrosIguais,
    confirmarRevisao,
    devePreencherNaRetentativa,
    estadoFluxoInicial,
    linhasAntesDepois,
    podeAplicar,
    recarregarDepoisDeAplicar,
    resolverConflito,
    revisaoAindaConfere,
} from './tela-cadastro.ts';

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

test('a comparação usa o conteúdo normalizado e cobre endereço, contato e referência', () => {
    const antes = normalizarCadastro({
        ...cadastroVazio(),
        nomeComercial: 'Antes',
        sede: { ...cadastroVazio().sede, cep: '01001000', logradouro: 'Rua A', numero: '10', bairro: 'Centro', cidade: 'Sao Paulo', uf: 'RJ' },
        unidadeNome: 'Unidade',
        unidade: { ...cadastroVazio().unidade, cep: '02002000', logradouro: 'Rua B', numero: '20', complemento: 'Sala 1', bairro: 'Bela', cidade: 'Sao Paulo', uf: 'SP' },
        referenciaChegada: 'Portão azul',
        telefone: '11988887777',
        emailComercial: 'antes@example.invalid',
    });
    const digitadoDurante = base({ nomeComercial: 'Digitado depois do envio' });
    const enviado = {
        ...cadastroVazio(),
        nomeComercial: '  Depois  ',
        sede: { ...cadastroVazio().sede, cep: '01310-100', logradouro: 'Rua C', semNumero: true, numero: '10', bairro: 'Centro', cidade: 'Sao Paulo', uf: 'sp' },
        mesmoEnderecoSede: true,
        unidadeNome: 'Unidade nova',
        unidade: { ...cadastroVazio().unidade, cep: '02002000', logradouro: 'Rua B', numero: '20', complemento: 'Sala 1', bairro: 'Bela', cidade: 'Sao Paulo', uf: 'SP' },
        referenciaChegada: '  Muro amarelo  ',
        telefone: '(11) 97777-6666',
        whatsapp: '(11) 96666-5555',
        emailComercial: 'Depois@Example.invalid',
        site: 'https://example.invalid',
        instagram: 'https://instagram.example.invalid',
    };
    const salvo = normalizarCadastro(enviado);
    const linhas = linhasAntesDepois(antes, salvo);
    const porRotulo = Object.fromEntries(linhas.map((linha) => [linha.rotulo, linha]));
    assert.equal(porRotulo['Número da sede']?.depois, 'sem número');
    assert.equal(porRotulo['Mesmo endereço da sede']?.depois, 'sim');
    assert.equal(porRotulo['Referência de chegada']?.depois, 'Muro amarelo');
    assert.equal(porRotulo['Telefone']?.depois, '11977776666');
    assert.equal(porRotulo['WhatsApp']?.depois, '11966665555');
    assert.equal(porRotulo['E-mail comercial']?.depois, 'depois@example.invalid');
    assert.equal(porRotulo['Site']?.depois, 'https://example.invalid');
    assert.equal(porRotulo['Instagram']?.depois, 'https://instagram.example.invalid');
    assert.equal(porRotulo['CEP da sede']?.depois, '01310100');
    assert.equal(porRotulo['Logradouro da sede']?.depois, 'Rua C');
    assert.equal(porRotulo['UF da sede']?.depois, 'SP');
    assert.equal(linhas.some((linha) => linha.depois.includes('(')), false);
    assert.equal(linhas.some((linha) => linha.rotulo === 'Nome que os clientes veem' && linha.depois === digitadoDurante.nomeComercial), false);
    assert.equal(porRotulo['Nome que os clientes veem']?.depois, 'Depois');
});

test('conflito, retentativa e resposta tardia não grudam o texto local numa revisão nova', () => {
    const recebido = base({ nomeComercial: 'Cadastro recebido' });
    const carga = {
        contexto: {
            versao: 3,
            cadastro: recebido,
            rascunho: { numero: 8, edicao: 2, versaoBase: 3, conteudo: recebido },
        },
    };
    let estado = estadoFluxoInicial();
    assert.equal(devePreencherNaRetentativa(estado), true);
    estado = aposCarga(estado, carga, devePreencherNaRetentativa(estado));
    assert.equal(estado.form.nomeComercial, 'Cadastro recebido');
    assert.equal(estado.numero, 8);
    assert.equal(estado.edicao, 2);
    assert.equal(estado.versaoBase, 3);

    const local = base({ nomeComercial: 'Texto local' });
    estado = {
        ...estado,
        form: local,
        salvo: local,
        digitou: true,
        confirmado: true,
        conteudoConfirmado: local,
    };
    const cargaNova = {
        contexto: {
            versao: 4,
            cadastro: base({ nomeComercial: 'Servidor' }),
            rascunho: { numero: 9, edicao: 5, versaoBase: 4, conteudo: base({ nomeComercial: 'Servidor' }) },
        },
    };
    const recarga = aposCarga(estado, cargaNova, false);
    assert.equal(recarga.form.nomeComercial, 'Texto local');
    assert.equal(recarga.numero, 8);
    assert.equal(recarga.edicao, 2);
    assert.equal(recarga.versaoBase, 3);

    const conflito = aposConflito(recarga, local);
    assert.equal(conflito.form.nomeComercial, 'Texto local');
    assert.equal(conflito.numero, 8);
    assert.equal(conflito.confirmado, false);
    assert.equal(podeAplicar({ ...pronto, confirmado: true, conflito: true, confirmacaoConfere: true }), false);
    assert.equal(podeAplicar({
        ...pronto,
        numero: conflito.numero,
        edicao: conflito.edicao,
        confirmado: conflito.confirmado,
        conflito: conflito.conflito,
        confirmacaoConfere: revisaoAindaConfere(conflito),
    }), false);

    const resolvido = resolverConflito(conflito, { numero: 9, edicao: 5, versaoBase: 4 });
    assert.equal(resolvido.form.nomeComercial, 'Texto local');
    assert.equal(resolvido.numero, 9);
    assert.equal(resolvido.edicao, 5);
    assert.equal(resolvido.versaoBase, 4);
    assert.equal(resolvido.confirmado, false);
    const confirmado = confirmarRevisao({ ...resolvido, salvo: local }, true);
    assert.equal(revisaoAindaConfere(confirmado), true);
    const salvoMudou = { ...confirmado, salvo: base({ nomeComercial: 'Outro conteúdo' }) };
    assert.equal(revisaoAindaConfere(salvoMudou), false);
    assert.equal(podeAplicar({
        ...pronto,
        numero: salvoMudou.numero,
        edicao: salvoMudou.edicao,
        confirmado: salvoMudou.confirmado,
        conflito: salvoMudou.conflito,
        sujo: !cadastrosIguais(salvoMudou.form, salvoMudou.salvo),
        confirmacaoConfere: revisaoAindaConfere(salvoMudou),
    }), false);

    const enviado = base({ nomeComercial: '  Texto enviado  ' });
    const durante = base({ nomeComercial: 'Digitado durante o envio' });
    const tardio = aposOperacao({ formAtual: durante, enviado, ok: true, tardio: true });
    const aposTardio = aplicarResultadoOperacao(confirmado, tardio, { numero: 12, edicao: 7, versaoBase: 9 });
    assert.equal(aposTardio.form.nomeComercial, 'Digitado durante o envio');
    assert.equal(aposTardio.numero, confirmado.numero);
    assert.equal(aposTardio.salvo.nomeComercial, confirmado.salvo.nomeComercial);
    const sucesso = aposOperacao({ formAtual: durante, enviado, ok: true, tardio: false });
    assert.equal(sucesso.form.nomeComercial, 'Digitado durante o envio');
    assert.equal(sucesso.salvo?.nomeComercial, 'Texto enviado');
    const aposSucesso = aplicarResultadoOperacao(confirmado, sucesso, { numero: 9, edicao: 6, versaoBase: 4 });
    assert.equal(aposSucesso.confirmado, false);
    assert.equal(revisaoAindaConfere(aposSucesso), false);
});
