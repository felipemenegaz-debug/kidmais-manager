import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarComponente, cssFalso, elementos, texto, tique } from '../teste-componente.ts';
import * as acessoTela from '../../../lib/whatsapp/atendimento/acesso-tela.ts';
import * as identificacao from '../../../lib/whatsapp/atendimento/identificacao.ts';
import * as encerramento from '../../../lib/whatsapp/atendimento/encerramento.ts';

// Tela real renderizada sem DOM; a API é simulada. Recusa de acesso no carregamento: bloco próprio por situação e
// nenhum dado da empresa piloto fica na tela (nem os que já tinham sido carregados).
const DADOS = {
  usuarioId: 'u', mensagens: [], configuracao: null, automacaoDisponivel: false, podeConfigurar: false,
  canal: { ambiente: 'staging', receptor: false, recepcao: false, envio: false }, ia: { ia: false, orcamento: false },
  conversas: [{ id: 'c1', empresa_id: 'e', ambiente: 'staging', contato: '5561900000101', contato_final: '0101', estado: 'IA', responsavel_id: null,
    responsavel_nome: null, nao_contatar: false, versao: 1, ultima_entrada_em: new Date().toISOString(), atualizada_em: new Date().toISOString(),
    interesse: { data: null, convidados: null }, nome_perfil: null, cadastro: { situacao: 'UNICO', nome: 'Cliente da piloto' } }],
};

function montar(respostas: { status: number; corpo: unknown }[]) {
  const fila = [...respostas];
  const adminFetch = async () => { const r = fila.shift() ?? respostas[respostas.length - 1]; return { ok: r.status < 400, status: r.status, json: async () => r.corpo }; };
  const h = carregarComponente('components/admin/atendimento/AtendimentoWhatsapp.tsx', {
    'next/link': { default: (p: { children?: unknown }) => p.children },
    '@/lib/http/admin-fetch': { adminFetch },
    './atendimento.module.css': cssFalso,
    './MensagensProntas': { GerenciarMensagensProntas: () => null, MensagensProntas: () => null },
    '@/lib/whatsapp/atendimento/encerramento': encerramento,
    '@/lib/whatsapp/atendimento/identificacao': identificacao,
    '@/lib/whatsapp/atendimento/acesso-tela': acessoTela,
  });
  // Sem intervalo real (o teste termina); o primeiro carregamento roda no setTimeout(0).
  globalThis.window = { setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined } as never;
  let arvore: unknown = h.render();
  const carregarDeNovo = async () => { h.efeitos(); await new Promise(r => setTimeout(r, 5)); await tique(); arvore = h.render(); };
  return { h, carregarDeNovo, arvore: () => arvore };
}
const bloco = (arvore: unknown) => elementos(arvore).find(e => e.type === 'section' && typeof e.props['data-bloqueio'] === 'string');
const recusa = (codigo: string) => ({ status: 403, corpo: { ok: false, erro: 'mensagem da rota', codigo } });

for (const [codigo, tipo, orientacao] of [
  ['ATENDIMENTO_EMPRESA_DIVERGENTE', 'EMPRESA_DIVERGENTE', /Troque a empresa ativa/],
  ['ATENDIMENTO_EMPRESA_NAO_SELECIONADA', 'EMPRESA_NAO_SELECIONADA', /Selecione a empresa/],
  ['ATENDIMENTO_SEM_ACESSO', 'SEM_ACESSO', /Peça a liberação/],
  ['ATENDIMENTO_ACESSO_NEGADO', 'SEM_ACESSO', /Peça a liberação/],
] as const) {
  test(`recusa ${codigo}: bloco "${tipo}" com orientação, sem "Carregando" e sem erro genérico`, async () => {
    const m = montar([recusa(codigo)]);
    await m.carregarDeNovo();
    const b = bloco(m.arvore());
    assert.ok(b, 'bloco de recusa na tela');
    assert.equal(b!.props['data-bloqueio'], tipo);
    assert.equal(b!.props.role, 'alert');
    assert.match(texto(b), orientacao);
    const tudo = texto(m.arvore());
    assert.doesNotMatch(tudo, /Carregando atendimento/);
    assert.doesNotMatch(tudo, /mensagem da rota/, 'a recusa de acesso não aparece como erro genérico');
  });
}

test('dados já carregados somem quando o próximo carregamento é recusado (ex.: empresa ativa trocada)', async () => {
  const m = montar([{ status: 200, corpo: { ok: true, data: DADOS } }, recusa('ATENDIMENTO_EMPRESA_DIVERGENTE')]);
  await m.carregarDeNovo();
  assert.match(texto(m.arvore()), /Cliente da piloto/, 'primeiro carregamento mostra a conversa');
  assert.equal(bloco(m.arvore()), undefined);
  // Atualizar = novo carregamento (o mesmo do intervalo de 10 s).
  const atualizar = elementos(m.arvore()).find(e => e.type === 'button' && texto(e) === 'Atualizar');
  (atualizar!.props.onClick as () => unknown)();
  await new Promise(r => setTimeout(r, 5)); await tique();
  const depois = m.h.render();
  assert.doesNotMatch(texto(depois), /Cliente da piloto/, 'nenhum dado da piloto fica na tela');
  assert.equal(bloco(depois)?.props['data-bloqueio'], 'EMPRESA_DIVERGENTE');
});

test('erro que não é de acesso continua como mensagem comum (sem bloco)', async () => {
  const m = montar([{ status: 503, corpo: { ok: false, erro: 'Atendimento indisponível agora.', codigo: 'ATENDIMENTO_INDISPONIVEL' } }]);
  await m.carregarDeNovo();
  assert.equal(bloco(m.arvore()), undefined);
  assert.match(texto(m.arvore()), /Atendimento indisponível agora/);
});
