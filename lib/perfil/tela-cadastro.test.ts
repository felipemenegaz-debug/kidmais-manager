import assert from 'node:assert/strict';
import test from 'node:test';
import { cadastroVazio, type CadastroPerfil } from './cadastro.ts';
import { normalizarCadastro } from './cadastro.ts';
import {
    aposAplicar,
    aposCarga,
    aposConflito,
    aposOperacao,
    aplicarResultadoOperacao,
    cadastrosIguais,
    confirmarRevisao,
    devePreencherNaRetentativa,
    estadoFluxoInicial,
    linhasAntesDepois,
    pedidoRascunho,
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

    const conteudoRemoto = base({ nomeComercial: 'Edição 2' });
    const resolvido = resolverConflito(conflito, { numero: 9, edicao: 5, versaoBase: 4 }, conteudoRemoto);
    assert.equal(resolvido.form.nomeComercial, 'Texto local');
    assert.equal(resolvido.salvo.nomeComercial, 'Edição 2');
    assert.equal(resolvido.numero, 9);
    assert.equal(resolvido.edicao, 5);
    assert.equal(resolvido.versaoBase, 4);
    assert.equal(resolvido.confirmado, false);
    const confirmado = confirmarRevisao(resolvido, true);
    assert.equal(revisaoAindaConfere(confirmado), true);
    assert.equal(podeAplicar({
        ...pronto,
        numero: confirmado.numero,
        edicao: confirmado.edicao,
        confirmado: confirmado.confirmado,
        conflito: confirmado.conflito,
        sujo: !cadastrosIguais(confirmado.form, confirmado.salvo),
        confirmacaoConfere: revisaoAindaConfere(confirmado),
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

test('depois de salvar, máscara, telefone, espaços e mesmo endereço não bloqueiam aplicar', () => {
    const digitado = base({
        nomeComercial: '  Kidmais  ',
        cnpj: '11.222.333/0001-81',
        telefone: '(11) 98888-7777',
        mesmoEnderecoSede: true,
        sede: { ...cadastroVazio().sede, logradouro: 'Rua A', numero: '10' },
        unidade: { ...cadastroVazio().unidade, logradouro: 'Rua que não entra', numero: '99', complemento: 'Sala 1' },
    });
    const efeito = aposOperacao({ formAtual: digitado, enviado: digitado, ok: true, tardio: false });
    assert.equal(efeito.form.cnpj, '11.222.333/0001-81');
    assert.equal(efeito.form.telefone, '(11) 98888-7777');
    assert.equal(efeito.form.nomeComercial, '  Kidmais  ');
    assert.equal(efeito.form.mesmoEnderecoSede, true);
    assert.equal(efeito.form.unidade.logradouro, 'Rua que não entra');
    assert.equal(efeito.salvo?.cnpj, '11222333000181');
    assert.equal(efeito.salvo?.telefone, '11988887777');
    assert.equal(efeito.salvo?.nomeComercial, 'Kidmais');
    assert.equal(efeito.salvo?.unidade.logradouro, 'Rua A');
    const sujo = !cadastrosIguais(efeito.form, efeito.salvo ?? digitado);
    assert.equal(sujo, false);
    assert.equal(podeAplicar({ ...pronto, sujo, numero: 1, edicao: 1 }), true);

    const durante = { ...digitado, nomeComercial: 'Digitado durante o salvamento' };
    const comDigitacao = aposOperacao({ formAtual: durante, enviado: digitado, ok: true, tardio: false });
    assert.equal(comDigitacao.form.nomeComercial, 'Digitado durante o salvamento');
    assert.equal(cadastrosIguais(comDigitacao.form, comDigitacao.salvo ?? durante), false);
    assert.equal(podeAplicar({
        ...pronto,
        sujo: !cadastrosIguais(comDigitacao.form, comDigitacao.salvo ?? durante),
        numero: 1,
        edicao: 1,
    }), false);
});

test('resolver o conflito carrega a edição remota e não publica o texto antigo', () => {
    const edicao1 = base({ nomeComercial: 'Edição 1' });
    let estado = aposCarga(estadoFluxoInicial(), {
        contexto: {
            versao: 0,
            cadastro: edicao1,
            rascunho: { numero: 1, edicao: 1, versaoBase: 0, conteudo: edicao1 },
        },
    }, true);
    const edicao2 = base({ nomeComercial: 'Edição 2' });
    estado = aposConflito(estado, estado.form);
    estado = resolverConflito(estado, { numero: 1, edicao: 2, versaoBase: 0 }, edicao2);
    assert.equal(estado.form.nomeComercial, 'Edição 1');
    assert.equal(estado.salvo.nomeComercial, 'Edição 2');
    assert.equal(estado.numero, 1);
    assert.equal(estado.edicao, 2);
    estado = confirmarRevisao(estado, true);
    assert.equal(podeAplicar({
        ...pronto,
        numero: estado.numero,
        edicao: estado.edicao,
        confirmado: estado.confirmado,
        conflito: estado.conflito,
        sujo: !cadastrosIguais(estado.form, estado.salvo),
        confirmacaoConfere: revisaoAindaConfere(estado),
    }), false);
});

test('aplicar enquanto digita guarda a versão nova e descarta o rascunho consumido', () => {
    const salvo = base({ nomeComercial: 'Aplicado' });
    const digitando = base({ nomeComercial: 'Ainda digitando' });
    let estado: ReturnType<typeof estadoFluxoInicial> = {
        ...estadoFluxoInicial(),
        form: digitando,
        salvo,
        numero: 4,
        edicao: 2,
        versaoBase: 0,
        carregou: true,
        digitou: true,
    };
    estado = aposAplicar(estado, { formAtual: digitando, enviado: salvo, versaoAplicada: 1 });
    assert.equal(estado.form.nomeComercial, 'Ainda digitando');
    assert.equal(estado.numero, null);
    assert.equal(estado.edicao, null);
    assert.equal(estado.versaoBase, 1);
    const pedido = pedidoRascunho(estado);
    assert.equal(pedido.numero, null);
    assert.equal(pedido.edicao, null);
    assert.equal(pedido.versaoBase, 1);
    assert.equal(pedido.cadastro.nomeComercial, 'Ainda digitando');
    assert.equal(podeAplicar({
        ...pronto,
        numero: estado.numero,
        edicao: estado.edicao,
        sujo: !cadastrosIguais(estado.form, estado.salvo),
    }), false);
    const conflito = aposConflito(estado, estado.form);
    assert.equal(conflito.form.nomeComercial, 'Ainda digitando');
    assert.equal(conflito.versaoBase, 1);
    assert.equal(conflito.numero, null);
    assert.equal(pedidoRascunho(conflito).versaoBase, 1);
    assert.notEqual(pedidoRascunho(conflito).versaoBase, 0);
});
