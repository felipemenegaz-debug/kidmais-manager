import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../../lib/acessos/teste-carregador.ts';

const semRede = () => { throw new Error('Rede proibida no teste do texto do painel.'); };
type Texto = (d: Record<string, unknown>) => { tipo: 'ok' | 'alerta'; texto: string };
const { textoResultadoArrependimento } = carregarModulo('components/desenvolvedor/cliente.ts', {
    'http/admin-fetch': { adminFetch: semRede, reautenticarSessao: semRede },
    'http/contexto-empresa-cliente': { saidaDaSessaoEmAndamento: () => false },
}) as { textoResultadoArrependimento: Texto };

// Revisão 2765be2 (P3-N2): o painel só diz que o e-mail foi enviado quando a resposta diz ENVIADO.
test('registro: protocolo sempre; "enviada" só com ENVIADO; demais estados orientam o canal oficial', () => {
    const p = 'KA-20261023-ABCDEFGH';
    assert.deepEqual(textoResultadoArrependimento({ operacao: 'arrependimento-registrar', protocolo: p, emailConfirmacao: 'ENVIADO' }),
        { tipo: 'ok', texto: `Pedido registrado: protocolo ${p}. A confirmação foi enviada por e-mail ao solicitante.` });
    for (const [estado, motivo] of [['FALHOU', 'o envio do e-mail falhou'], ['SEM_DESTINATARIO', 'não há e-mail do solicitante'], [undefined, 'o envio do e-mail não foi registrado'], ['PENDENTE', 'o envio do e-mail não foi registrado']] as const) {
        const r = textoResultadoArrependimento({ operacao: 'arrependimento-registrar', protocolo: p, emailConfirmacao: estado });
        assert.equal(r.tipo, 'alerta');
        assert.match(r.texto, new RegExp(`^Pedido registrado: protocolo ${p}\\. Atenção: ${motivo}; responda ao solicitante pelo canal oficial`));
        assert.doesNotMatch(r.texto, /foi enviada/);
    }
});

test('conclusão: usa o estado do e-mail do resultado', () => {
    const p = 'KA-20261023-ABCDEFGH';
    assert.equal(textoResultadoArrependimento({ operacao: 'arrependimento-concluir', protocolo: p, emailConclusao: 'ENVIADO' }).texto,
        `Arrependimento concluído: protocolo ${p}. O resultado foi enviado por e-mail ao solicitante.`);
    const f = textoResultadoArrependimento({ operacao: 'arrependimento-concluir', protocolo: p, emailConclusao: 'FALHOU', emailConfirmacao: 'ENVIADO' });
    assert.equal(f.tipo, 'alerta'); assert.match(f.texto, /o envio do e-mail falhou/);
});
