import assert from 'node:assert/strict';
import test from 'node:test';
import { TIPOS_AVISO, type MarcoAviso } from './avisos.ts';
import { mensagemAviso, nomeEmpresaAviso, origemDosAvisos, PREFIXO_IDEMPOTENCIA_AVISO } from './avisos-mensagens.ts';

/** Textos dos avisos (087): links, escape, chave idempotente e ausência de valores/dados sensíveis. Dados sintéticos. */
const ID = '55555555-5555-4555-8555-555555555555';
const P = { regularizacaoDias: 7, somenteLeituraDias: 60 };
const marco = (tipo: MarcoAviso['tipo'], o: Partial<MarcoAviso> = {}): MarcoAviso => ({ tipo, marco: '2026-11-01T03:00:00.000Z', motivo: 'TESTE', ate: '2026-11-01T03:00:00.000Z', ...o });
const msg = (m: MarcoAviso, o: { empresa?: string; origem?: string } = {}) => mensagemAviso({ id: ID, marco: m, empresa: o.empresa ?? 'Buffet Sintético', para: 'gestao@example.invalid', origem: o.origem ?? 'https://manager.example', prazos: P });

test('todo tipo tem assunto, texto e HTML com os links de Assinatura e Ajuda e a chave idempotente fixa', () => {
    for (const tipo of TIPOS_AVISO) {
        const m = msg(marco(tipo, tipo === 'CANCELAMENTO_CONFIRMADO' ? { motivo: 'CANCELADA_NO_PERIODO' } : tipo === 'SUSPENSO' ? { ate: null } : {}));
        assert.ok(m.assunto.length > 10 && !/[\r\n]/.test(m.assunto), tipo);
        assert.equal(m.para, 'gestao@example.invalid');
        assert.equal(m.idempotencia, `${PREFIXO_IDEMPOTENCIA_AVISO}${ID}`);
        assert.match(m.idempotencia!, /^[A-Za-z0-9_:/-]{1,200}$/, 'formato aceito por criarEnviarEmail');
        for (const parte of [m.texto, m.html]) {
            assert.ok(parte.includes('https://manager.example/admin/assinatura'), tipo);
            assert.ok(parte.includes('https://manager.example/admin/ajuda'), tipo);
            assert.ok(parte.includes('Buffet Sintético'), tipo);
            assert.doesNotMatch(parte, /R\$|\d+,\d{2}\b|asaas|cpf|cnpj|senha/i, tipo);
        }
    }
});

test('datas pelo último dia em Brasília; textos citam o prazo de leitura configurado', () => {
    assert.match(msg(marco('TESTE_FIM_3_DIAS')).assunto, /31\/10\/2026/);
    assert.match(msg(marco('TESTE_FIM_3_DIAS')).texto, /somente leitura por 60 dias/);
    assert.match(msg(marco('TESTE_FIM_HOJE')).texto, /Hoje \(31\/10\/2026\)/);
    assert.match(msg(marco('PAGAMENTO_PENDENTE', { motivo: 'PAGAMENTO_PENDENTE', ate: '2026-11-17T03:00:00.000Z' })).texto, /completo até 16\/11\/2026/);
    // P2-1 (02/11): o texto nomeia o vencimento (dia do marco, Brasília), manda não pagar de novo e dá o prazo do boleto.
    const pendente = msg(marco('PAGAMENTO_PENDENTE', { marco: '2026-11-10T03:00:00.000Z', motivo: 'PAGAMENTO_PENDENTE', ate: '2026-11-17T03:00:00.000Z' })).texto;
    assert.match(pendente, /vencimento em 10\/11\/2026/); assert.match(pendente, /não pague de novo/); assert.match(pendente, /até 3 dias úteis/);
    assert.doesNotMatch(pendente, /alguns minutos/);
    assert.match(msg(marco('SOMENTE_LEITURA', { motivo: 'CANCELADA' })).texto, /cancelada terminou/);
    assert.match(msg(marco('CANCELAMENTO_CONFIRMADO', { motivo: 'ENCERRADA', ate: null })).texto, /acesso aos dados fica suspenso/);
    const semLeitura = mensagemAviso({ id: ID, marco: marco('TESTE_FIM_HOJE'), empresa: 'X', para: 'a@b.invalid', origem: 'https://m.example', prazos: { regularizacaoDias: 0, somenteLeituraDias: 0 } });
    assert.match(semLeitura.texto, /suspenso até a assinatura/);
});

test('nome da empresa escapado no HTML e limpo no assunto', () => {
    const m = msg(marco('SOMENTE_LEITURA', { motivo: 'TESTE_ENCERRADO' }), { empresa: '<b>Festa</b> "&"\nLinha' });
    assert.ok(!m.html.includes('<b>Festa</b>'));
    assert.ok(m.html.includes('&lt;b&gt;Festa&lt;/b&gt; &quot;&amp;&quot; Linha'));
    assert.ok(!/[\r\n]/.test(m.assunto));
    assert.equal(nomeEmpresaAviso('   '), 'Sua empresa');
    assert.equal(nomeEmpresaAviso('x'.repeat(200)).length, 80);
});

test('origem: https, ou http só em localhost; qualquer outra recusada', () => {
    assert.equal(origemDosAvisos('https://manager.example/qualquer'), 'https://manager.example');
    assert.equal(origemDosAvisos('http://localhost:3000'), 'http://localhost:3000');
    for (const o of ['http://manager.example', 'javascript:alert(1)', 'ftp://x.example'])
        assert.throws(() => origemDosAvisos(o), /Origem de aviso inválida/, o);
});
