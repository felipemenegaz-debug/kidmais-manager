import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarComponente, cssFalso, elementos, texto, tique } from '../teste-componente.ts';
import * as acessoTela from '../../../lib/whatsapp/atendimento/acesso-tela.ts';
import * as identificacao from '../../../lib/whatsapp/atendimento/identificacao.ts';
import * as encerramento from '../../../lib/whatsapp/atendimento/encerramento.ts';

// Tela real renderizada sem DOM; API simulada; a biblioteca é substituída por um dublê que guarda as props (onUsar e
// cicloResposta). Cenário entre a prévia e o envio: o envio vai preso à versão vista; se a pronta mudou, o servidor
// recusa (409) e a tela marca o anexo, bloqueia o envio e pede nova revisão — nada é trocado em silêncio.
const P = '3f3f3f3f-3f3f-4f3f-8f3f-3f3f3f3f3f3f';
const DADOS = {
  usuarioId: 'u', mensagens: [], configuracao: { ativo: true, nome: 'Kidmais', perguntas: [], limites: { respostasPor24h: 20 } }, automacaoDisponivel: true, podeConfigurar: false,
  canal: { ambiente: 'staging', receptor: true, recepcao: true, envio: true }, ia: { ia: true, orcamento: true },
  conversas: [{ id: 'c1', empresa_id: 'e', ambiente: 'staging', contato: '5561900000101', contato_final: '0101', estado: 'HUMANO', responsavel_id: 'u',
    responsavel_nome: 'Atendente', nao_contatar: false, versao: 4, ultima_entrada_em: new Date().toISOString(), atualizada_em: new Date().toISOString(),
    interesse: { data: null, convidados: null }, nome_perfil: null, cadastro: { situacao: 'SEM_CADASTRO' } }],
};
const ALTERADA = { status: 409, corpo: { ok: false, erro: 'A foto ou o vídeo desta mensagem pronta mudou ou foi removido depois da prévia.', codigo: 'ATENDIMENTO_PRONTA_MIDIA_ALTERADA' } };

function montar(envios: { status: number; corpo: unknown }[]) {
  const corpos: Record<string, unknown>[] = [];
  const adminFetch = async (_url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method) return { ok: true, status: 200, json: async () => ({ ok: true, data: DADOS }) };
    corpos.push(JSON.parse(init.body!));
    const r = envios.shift()!;
    return { ok: r.status < 400, status: r.status, json: async () => r.corpo };
  };
  // O renderizador de teste não chama componentes filhos: as props da biblioteca são lidas do elemento na árvore.
  const Biblioteca = () => null;
  const h = carregarComponente('components/admin/atendimento/AtendimentoWhatsapp.tsx', {
    'next/link': { default: (p: { children?: unknown }) => p.children },
    '@/lib/http/admin-fetch': { adminFetch },
    './atendimento.module.css': cssFalso,
    './MensagensProntas': { GerenciarMensagensProntas: () => null, MensagensProntas: Biblioteca },
    '@/lib/whatsapp/atendimento/encerramento': encerramento,
    '@/lib/whatsapp/atendimento/identificacao': identificacao,
    '@/lib/whatsapp/atendimento/acesso-tela': acessoTela,
  });
  globalThis.window = { setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => undefined } as never;
  globalThis.document = { hidden: false } as never;
  let arvore: unknown = h.render();
  const ciclo = async () => { h.efeitos(); await new Promise(r => setTimeout(r, 5)); await tique(); arvore = h.render(); h.efeitos(); arvore = h.render(); };
  const botao = (rotulo: RegExp) => elementos(arvore).find(e => e.type === 'button' && rotulo.test(texto(e)));
  // Antes de enviar, termina o carregamento pendente (ele limparia o erro depois, como a atualização de 10 s faz na tela).
  const enviar = async () => { await new Promise(r => setTimeout(r, 10)); await tique(); arvore = h.render(); const f = elementos(arvore).find(e => e.type === 'form')!; (f.props.onSubmit as (e: unknown) => void)({ preventDefault() {} }); await new Promise(r => setTimeout(r, 5)); await tique(); arvore = h.render(); };
  // Só re-renderiza: rodar os efeitos de novo recarregaria a tela (o useCallback do renderizador de teste não memoriza) e apagaria o erro.
  const props = () => elementos(arvore).find(e => e.type === Biblioteca)!.props as { onUsar: (texto: string, conversaId: string, midia: unknown) => void; cicloResposta: number };
  return { h, ciclo, botao, enviar, corpos, props, arvore: () => arvore };
}
const foto = (versao: number) => ({ tipo: 'IMAGEM', url: 'https://midia.exemplo.test/salgados.jpg', prontaId: P, versao, titulo: 'Foto de exemplo' });
const anexo = (arvore: unknown) => elementos(arvore).find(e => e.props['aria-label'] === 'Anexo da resposta');

test('envio vai com a versão da prévia; pronta alterada: anexo marcado, envio bloqueado, aviso limpo; reanexar e enviar', async () => {
  const m = montar([ALTERADA, { status: 200, corpo: { ok: true, data: {} } }]);
  await m.ciclo();
  (m.botao(/0101/)!.props.onClick as () => void)();                      // abre a conversa assumida pela pessoa
  await m.ciclo();
  const ciclo0 = m.props().cicloResposta;
  m.props().onUsar('Legenda revisada', 'c1', foto(3)); await m.ciclo();
  assert.match(texto(anexo(m.arvore())), /Foto anexada/);
  await m.enviar();
  assert.deepEqual(m.corpos[0], { acao: 'enviar', conversaId: 'c1', versao: 4, prontaMidiaId: P, prontaVersao: 3, texto: 'Legenda revisada' }, 'id E versão vistos na prévia; nenhuma URL');
  // Recusa: o anexo continua visível (não some nem é trocado), marcado, com o aviso dentro dele; envio bloqueado.
  const a = anexo(m.arvore())!;
  assert.equal(a.props['data-desatualizado'], true);
  const alerta = elementos(a).find(e => e.props.role === 'alert')!;
  assert.match(texto(alerta), /Esta foto mudou ou foi removida na biblioteca depois da prévia e não foi enviada\. Remova o anexo e abra a prévia de novo/);
  assert.equal(m.botao(/^Enviar foto$/)!.props.disabled, true, 'nada sai com a mídia desatualizada');
  assert.ok(!elementos(m.arvore()).some(e => e.props.role === 'alert' && /mensagem pronta mudou ou foi removido/.test(texto(e))), 'sem segundo alerta genérico no topo');
  assert.equal(m.props().cicloResposta, ciclo0 + 1, 'o aviso "anexada" da biblioteca deixa de valer');
  await m.enviar();
  assert.equal(m.corpos.length, 1, 'enviar de novo (Enter no formulário) não chama a API');
  // Remover e revisar de novo: o anexo novo (versão nova) substitui o marcado; o envio sai e tudo é limpo.
  (m.botao(/^Remover anexo$/)!.props.onClick as () => void)(); await m.ciclo();
  assert.equal(anexo(m.arvore()), undefined);
  assert.equal(m.props().cicloResposta, ciclo0 + 2);
  m.props().onUsar('Legenda nova', 'c1', foto(4)); await m.ciclo();
  assert.equal(anexo(m.arvore())!.props['data-desatualizado'], undefined, 'anexo revisado de novo, sem marca');
  await m.enviar();
  assert.deepEqual(m.corpos[1], { acao: 'enviar', conversaId: 'c1', versao: 4, prontaMidiaId: P, prontaVersao: 4, texto: 'Legenda nova' });
  assert.equal(anexo(m.arvore()), undefined, 'depois do envio aceito o anexo sai');
  assert.equal(m.props().cicloResposta, ciclo0 + 3, 'e o aviso de anexo da biblioteca é limpo');
});

test('envio aceito de texto também limpa o aviso; erro comum não muda o ciclo nem marca anexo', async () => {
  const m = montar([{ status: 503, corpo: { ok: false, erro: 'Atendimento indisponível agora.', codigo: 'ATENDIMENTO_INDISPONIVEL' } }, { status: 200, corpo: { ok: true, data: {} } }]);
  await m.ciclo();
  (m.botao(/0101/)!.props.onClick as () => void)(); await m.ciclo();
  const ciclo0 = m.props().cicloResposta;
  m.props().onUsar('Olá! Segue a tabela.', 'c1', null); await m.ciclo();
  await m.enviar();
  assert.equal(m.props().cicloResposta, ciclo0, 'falha comum: o rascunho e o aviso continuam');
  assert.match(texto(m.arvore()), /Atendimento indisponível agora/);
  await m.enviar();
  assert.deepEqual(m.corpos.map(c => c.texto), ['Olá! Segue a tabela.', 'Olá! Segue a tabela.']);
  assert.equal(m.props().cicloResposta, ciclo0 + 1, 'envio aceito: aviso limpo');
});
