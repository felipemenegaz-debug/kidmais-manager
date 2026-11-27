/* eslint-disable @typescript-eslint/no-explicit-any -- módulos .mjs da avaliação e resultados brutos comparados campo a campo */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';
import { carregarComponente } from '../../../../components/admin/teste-componente.ts';

/**
 * Fatia 10a ("Testar o Wall-e"): o teste NÃO pode divergir do caminho real (risco nomeado no plano). Para cada mensagem
 * dos holdouts, como conversa nova, compara a caixa de teste — testarWallE com a porta REAL do Wall-e em modo sem efeito
 * (entendimento, sinais do JEV pela composition root e resolvedor reais; só o banco e as fontes trocados pelas fontes
 * sintéticas da avaliação) — com a simulação do caminho real da fila (recepção, worker, Wall-e) usada na regressão dos
 * holdouts. Exige as mesmas saídas, as mesmas fontes, o mesmo desfecho e os mesmos motivos. Sem banco nem rede.
 */
register('../../../../scripts/walle-avaliacao/alias-hooks.mjs', import.meta.url);
globalThis.fetch = async () => { throw new Error('rede proibida no teste'); };
const raiz = (rel: string) => new URL(`../../../../${rel}`, import.meta.url).href;
const imp = (rel: string) => import(raiz(rel)) as Promise<Record<string, any>>;
const pastaAvaliacao = new URL('../../../../scripts/walle-avaliacao/', import.meta.url);
const COM_LINK = new Set(['corpus-holdout-41-20261008.json', 'corpus-holdout-42-20261008.json', 'corpus-holdout-43-20261008.json', 'corpus-holdout-44-20261008.json', 'corpus-holdout-45-20261009.json', 'corpus-holdout-46-20261009.json']);

test('holdouts: a caixa de teste dá o mesmo resultado do caminho real da fila, mensagem a mensagem', async () => {
  const [fixture, simulacao, ent, res, core, ctx, worker, modelo, tipos, motivo] = await Promise.all([
    imp('scripts/walle-avaliacao/fixture.mjs'), imp('scripts/walle-avaliacao/simulacao.mjs'),
    imp('lib/whatsapp/atendimento/walle/entendimento.ts'), imp('lib/whatsapp/atendimento/walle/resolver.ts'), imp('lib/whatsapp/atendimento/core.ts'),
    imp('lib/whatsapp/atendimento/walle/contexto.ts'), imp('lib/whatsapp/atendimento/worker.ts'), imp('app/api/admin/inteligencia/whatsapp/modelo.ts'),
    imp('lib/whatsapp/atendimento/walle/tipos.ts'), imp('lib/whatsapp/atendimento/motivo-falha.ts'),
  ]);
  let fontes = fixture.FONTES;
  const sql: string[] = [];
  const proibido = () => { throw new Error('consulta proibida no teste'); };
  const porta = carregarComponente('lib/whatsapp/atendimento/walle/porta.ts', {
    '../../../db/postgres.ts': {
      db: proibido,
      withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        try { const r = await fn({ query: async (q: string) => { sql.push(q); return { rows: [], rowCount: 0 }; } }); sql.push('COMMIT'); return r; }
        catch (e) { sql.push('ROLLBACK'); throw e; }
      },
    },
    '../../../clientes/repositories/cliente.repository': { buscarClientesPorContatoExato: proibido },
    '../../../fechamentos/contratacoes.ts': { listarContratacoes: proibido },
    '../core.ts': core,
    '../multiempresa.ts': { direitoAtendimentoWhatsApp: proibido },
    '../configuracao.ts': { entendimentoSoRegras: () => true, modoEntendimento: () => ({ modo: 'REGRAS' }) },
    '../motivo-falha.ts': motivo,
    '../prontas-link.ts': { resolverLinkFechamento: proibido },
    './contexto.ts': ctx,
    './entendimento.ts': ent,
    './fontes-postgres.ts': { catalogosWallE: async () => fixture.CATALOGOS, fontesPostgres: () => fontes },
    './link-disponibilidade.ts': { ambienteDoLink: () => 'teste', linkDisponibilidadeDaEmpresa: async () => ({ ok: false }) },
    './resolver.ts': res,
  }).modulo as typeof import('./porta.ts');
  // A composição da caixa de teste (portaTesteWallE): regras + sinais do JEV, modo sem efeito.
  const real = porta.criarPortaWallE(null, { sinais: modelo.sinaisJev, semEfeito: true });
  let bruto: any = null;
  const espia = { async responder(e: any) { bruto = null; bruto = await real.responder(e); return bruto; } };
  const teste = carregarComponente('lib/whatsapp/atendimento/walle/teste.ts', {
    '../core.ts': core,
    '../configuracao.ts': { ambienteAtendimento: () => 'staging' },
    '../motivo-falha.ts': motivo,
    '../service.ts': { acessoAtendimento: async (_s: unknown, work: (tx: unknown, e: string, p: string) => unknown) => work({}, fixture.EMPRESA, 'ADMINISTRATIVO'), tem082: async () => true, configuracao: async () => fixture.CONFIG },
    './tipos.ts': tipos,
  }).modulo as typeof import('./teste.ts');
  const m = { entenderPorRegras: ent.entenderPorRegras, revalidarEntendimento: ent.revalidarEntendimento, juntarSinais: ent.juntarSinais, resolverWallE: res.resolverWallE, comandoDireto: core.comandoDireto, pausaPedidaNaRecepcao: core.pausaPedidaNaRecepcao ?? null, lerContexto: ctx.lerContexto, mensagemAindaValida: worker.mensagemAindaValida, sinaisJev: modelo.sinaisJev, registroDoBloqueio: ent.registroDoBloqueio ?? null };
  const nome = (c: string) => tipos.NOME_MOTIVO[c];
  // A hora da consulta à agenda é o relógio de cada execução (milissegundos de diferença); o resto é exigido igual.
  const semHora = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'consultadoEm' ? '*' : x)));
  const arquivos = readdirSync(pastaAvaliacao).filter((a) => /^corpus-holdout-.*\.json$/.test(a)).sort();
  assert.ok(arquivos.length >= 40, 'todos os holdouts');
  const desfechos: Record<string, number> = {};
  let total = 0;
  for (const arquivo of arquivos) {
    const corpus = JSON.parse(readFileSync(new URL(arquivo, pastaAvaliacao), 'utf8'));
    fontes = COM_LINK.has(arquivo) ? fixture.FONTES_COM_LINK : fixture.FONTES;
    for (const item of corpus.itens) {
      const id = `${arquivo} ${item.id}`;
      const [linha] = await simulacao.simularSequencia(m, [{ ...item, conversa: null, ordem: null, equipe: undefined }], { catalogos: fixture.CATALOGOS, config: fixture.CONFIG, fontes, agora: fixture.AGORA, entender: (t: string, c: unknown) => ent.entenderPorRegras(t, fixture.CATALOGOS, c) });
      bruto = null;
      const r = await teste.testarWallE({} as never, item.texto, espia, new Date(fixture.AGORA));
      total++; desfechos[r.desfecho] = (desfechos[r.desfecho] ?? 0) + 1;
      // Mesmo desfecho do worker.
      const esperado = linha.decisao === 'PARAR' ? (linha.motivos[0] === 'PARAR' ? 'BLOQUEIA_NA_RECEPCAO' : 'BLOQUEIA')
        : linha.decisao === 'EQUIPE' ? (linha.motivos.includes('FALHA_SEM_SAIDA') || linha.motivos.includes('FALHA') ? 'FALHA' : linha.saidas.length ? 'RESPONDE_E_PASSA' : 'PASSA_EM_SILENCIO')
          : 'RESPONDE';
      assert.equal(r.desfecho, esperado, `${id}: desfecho`);
      if (r.desfecho === 'BLOQUEIA_NA_RECEPCAO') { assert.equal(bruto, null, `${id}: recepção bloqueia antes do Wall-e`); continue; }
      // Mesmas saídas e fontes da porta, e a tela mostra o que o worker gravaria (legenda quando há anexo).
      assert.deepEqual(semHora(bruto.saidas.map((s: any) => ({ texto: s.texto, anexo: s.anexo?.prontaId ?? null, fontes: s.fontes }))), semHora(linha.saidas), `${id}: saídas`);
      if (r.desfecho === 'RESPONDE' || r.desfecho === 'RESPONDE_E_PASSA') {
        assert.deepEqual(r.respostas.map((x) => x.texto), bruto.saidas.map((s: any) => (s.anexo ? s.anexo.legenda : s.texto)), `${id}: texto mostrado`);
        assert.deepEqual(r.respostas.map((x) => x.fontes.length > 0), bruto.saidas.map((s: any) => s.fontes.length > 0), `${id}: toda fonte da porta aparece rotulada`);
      }
      const motivosEsperados = esperado === 'FALHA' ? [nome('FALHA')] : esperado === 'BLOQUEIA' ? linha.motivos.slice(1).map(nome) : linha.motivos.map(nome);
      assert.deepEqual(r.motivos, motivosEsperados, `${id}: motivos`);
      assert.equal(r.entendidoPor, 'REGRAS', `${id}: sem modelo`);
    }
  }
  // Leituras só em transação somente leitura, sempre desfeita; nada de COMMIT.
  assert.ok(sql.length > 0);
  assert.ok(!sql.includes('COMMIT'), 'nenhum COMMIT');
  assert.ok(sql.every((q) => q === 'SET TRANSACTION READ ONLY' || q === 'ROLLBACK'), 'só a abertura somente leitura e o desfazer');
  // A comparação cobre todos os desfechos relevantes (não só respostas simples).
  for (const d of ['RESPONDE', 'RESPONDE_E_PASSA', 'PASSA_EM_SILENCIO', 'BLOQUEIA_NA_RECEPCAO']) assert.ok((desfechos[d] ?? 0) > 0, `holdouts cobrem ${d}: ${JSON.stringify(desfechos)}`);
  console.log('[teste-holdouts] %d mensagens comparadas: %j', total, desfechos);
});
