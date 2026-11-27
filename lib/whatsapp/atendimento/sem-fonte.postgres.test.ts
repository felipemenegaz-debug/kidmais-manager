import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { carregarComponente } from '../../../components/admin/teste-componente.ts';
import { conectarDescartavel } from '../../comercial/postgres-descartavel.ts';
import type { DbExecutor } from '../../db/contracts.ts';
import * as preferencias from '../../marketing/automacoes/preferencias.ts';
import { executarNoTenant, type SessaoParaTenant } from '../../saas/provar-tenant.ts';
import * as supressao from '../../satisfacao/supressao.ts';
import * as arquivos from './arquivos.ts';
import * as core from './core.ts';
import * as erros from './erros.ts';
import { cod, db, withTransaction } from './harness-postgres.ts';
import * as multiempresa from './multiempresa.ts';
import * as avisoEquipe from './aviso-equipe.ts';
import * as semFonteTexto from './sem-fonte-texto.ts';
import * as entendimento from './walle/entendimento.ts';
import * as tetoMensal from './teto-mensal.ts';

const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`;
const AGORA = new Date('2027-01-20T15:00:00Z');
const DIA = 86_400_000;
const emDias = (dias: number) => new Date(AGORA.getTime() - dias * DIA).toISOString();

/**
 * Fatia 7 no PG descartável (082): perguntas sem fonte por empresa e ambiente, "não contatar" fora, sensível só contado,
 * janela de 30 dias, papel (só REPRESENTANTE_AUTORIZADO), a rota chamada com a sessão de cada perfil e a validação do
 * texto publicado no salvar. Dados sintéticos.
 */
test('sem fonte: escopo por empresa e ambiente, papel pela rota e texto publicado validado', { timeout: 600_000 }, async t => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== 'kidmais_pacotes_v1_descartavel') {
    t.skip('opt-in ausente: harness PostgreSQL não executado');
    return;
  }
  const c = await conectarDescartavel();
  try {
    assert.equal((await c.query(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_name='whatsapp_atendimento_conversas' AND column_name='passagem') AS ok`)).rows[0].ok, true, '082 presente');

    const id = async (sql: string, valores: unknown[]) => (await c.query(sql, valores)).rows[0].id as string;
    async function empresaCom(papel: string, empresaExistente?: string) {
      let empresa = empresaExistente;
      if (!empresa) {
        empresa = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa sintética sem fonte', 'PROVISIONAMENTO') RETURNING id`, [cod('sf')]);
        await c.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1`, [empresa]);
      }
      const usuario = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo)
        VALUES ($1, 'Usuário sintético sem fonte', $2, $3, true) RETURNING id`, [`${cod('u')}@example.test`, SENHA, papel]);
      const membership = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel)
        VALUES ($1, $2, 'PENDENTE', clock_timestamp(), $3) RETURNING id`, [empresa, usuario, papel]);
      await c.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1`, [membership]);
      const sessao = await id(`INSERT INTO sessoes_administrativas (usuario_id, token_hash, csrf_hash, autenticado_em, ultima_atividade_em, expira_em, empresa_ativa_id)
        VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 hour', $4) RETURNING id`,
      [usuario, randomBytes(32).toString('hex'), randomBytes(32).toString('hex'), empresa]);
      return { id: sessao, usuario_id: usuario, papel, empresa_ativa_id: empresa } satisfies SessaoParaTenant;
    }

    const rep = await empresaCom('REPRESENTANTE_AUTORIZADO');
    const adm = await empresaCom('ADMINISTRATIVO', rep.empresa_ativa_id);
    const outra = await empresaCom('REPRESENTANTE_AUTORIZADO');

    const configuracao = { ambienteAtendimento: () => 'staging', canalEnvio: () => 'GUPSHUP' as const, empresaPiloto: () => rep.empresa_ativa_id, atendimentoAtivo: () => true, recepcaoAtiva: () => true, receptorDoNumero: () => true, contatoPermitido: () => true, entendimentoSoRegras: () => true, origemMidia: () => 'https://midia.kidmais.example' };
    const tenant = { withTenantTransaction: (s: SessaoParaTenant, e: string, w: Parameters<typeof executarNoTenant>[3]) => withTransaction((tx: DbExecutor) => executarNoTenant(tx, s, e, w)) };
    const servico = carregarComponente('lib/whatsapp/atendimento/service.ts', {
      '../../db/postgres.ts': { withTransaction, db }, '../../saas/provar-tenant.ts': tenant, './configuracao.ts': configuracao, './core.ts': core, './arquivos.ts': arquivos,
      './walle/entendimento.ts': entendimento, './multiempresa.ts': multiempresa, './aviso-equipe.ts': avisoEquipe, './teto-mensal.ts': tetoMensal, '../../satisfacao/supressao.ts': supressao, '../../marketing/automacoes/preferencias.ts': preferencias,
    }).modulo as typeof import('./service.ts');
    const semFonte = carregarComponente('lib/whatsapp/atendimento/sem-fonte.ts', {
      './configuracao.ts': configuracao, './core.ts': core, './service.ts': servico, './sem-fonte-texto.ts': semFonteTexto,
    }).modulo as typeof import('./sem-fonte.ts');

    async function passagem(empresa: string, ambiente: string, ultimaMensagem: unknown, dias: number, extra: { motivo?: string; naoContatar?: boolean; soMotivoAntigo?: boolean; em?: string } = {}) {
      const motivo = extra.motivo ?? 'INFORMACAO_INDISPONIVEL';
      const em = extra.em ?? emDias(dias);
      const p = extra.soMotivoAntigo ? { motivo, em, ultimaMensagem } : { motivo, motivos: [motivo], em, ultimaMensagem };
      await c.query(`INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, passagem, nao_contatar)
        VALUES ($1, $2, $3, $4::jsonb, $5)`, [empresa, ambiente, `55619${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, JSON.stringify(p), extra.naoContatar ?? false]);
    }
    const A = rep.empresa_ativa_id, B = outra.empresa_ativa_id;
    await passagem(A, 'staging', 'Vocês têm fraldário no salão?', 1);
    await passagem(A, 'staging', 'voces tem fraldario no salao', 3);
    await passagem(A, 'staging', 'Tem wi-fi? me chama no 11987654321', 2);
    await passagem(A, 'staging', 'Pode levar pula-pula próprio?', 5, { soMotivoAntigo: true });
    await passagem(A, 'staging', core.REGISTRO_SENSIVEL, 4);
    await passagem(A, 'staging', 'Tem estacionamento coberto?', 6);
    // Fora do recorte: outro ambiente, outra empresa, não contatar, outro motivo, mais de 30 dias.
    await passagem(A, 'production', 'Pergunta de production?', 1);
    await passagem(B, 'staging', 'Pergunta da outra empresa?', 1);
    await passagem(A, 'staging', 'Cliente pediu para não contatar?', 1, { naoContatar: true });
    await passagem(A, 'staging', 'Quero falar com uma pessoa', 1, { motivo: 'PEDIU_HUMANO' });
    await passagem(A, 'staging', 'Pergunta antiga de dois meses?', 31);
    // Extremos da janela (Astra r1, P3): exatamente 30 dias entra; 1 s antes disso e qualquer data futura ficam de fora.
    await passagem(A, 'staging', 'Tem cama elástica?', 0, { em: emDias(30) });
    await passagem(A, 'staging', 'Pergunta de trinta dias e um segundo?', 0, { em: new Date(AGORA.getTime() - 30 * DIA - 1000).toISOString() });
    await passagem(A, 'staging', 'Pergunta do futuro?', 0, { em: new Date(AGORA.getTime() + 60_000).toISOString() });
    await passagem(A, 'staging', 'Tem cama elástica?', 0, { em: AGORA.toISOString() });
    // Contagem (Astra r1, P3/P1): apresentação com nome em minúsculas é omitida e contada; texto curto é só descartado.
    await passagem(A, 'staging', 'me chamo ana silva, tem wifi?', 2);
    await passagem(A, 'staging', 'ok', 2);
    // Astra r2 (P3): ultimaMensagem que não é texto (número de 5 dígitos, objeto) fica fora da consulta: nem grupo nem contagem.
    await passagem(A, 'staging', 12345, 2);
    await passagem(A, 'staging', { a: 1 }, 2);
    // A pergunta já publicada fica por último e marcada.
    await c.query(`INSERT INTO whatsapp_atendimento_config (empresa_id, ambiente, configuracao) VALUES ($1, 'staging', $2::jsonb)`,
      [A, JSON.stringify({ ativo: false, nome: 'Empresa sintética', perguntas: [{ id: 'faq_estac', pergunta: 'Tem estacionamento coberto?', resposta: 'Sim, para 20 carros.' }] })]);

    const r = await semFonte.perguntasSemFonte(rep, AGORA);
    assert.equal(r.disponivel, true);
    assert.equal(r.dias, 30);
    assert.equal(r.limite, 30);
    assert.equal(r.publicadas, 1);
    assert.equal(r.omitidasSensiveis, 2, 'sensível e apresentação com nome só contados; "ok" não');
    const esperado = [
      ['Tem cama elástica?', 2, false, false],
      ['Vocês têm fraldário no salão?', 2, false, false],
      // 11 dígitos soltos: a máscara existente marca como documento; o que importa é o número não aparecer.
      ['Tem wi-fi? me chama no [documento omitido]', 1, false, true],
      ['Pode levar pula-pula próprio?', 1, false, false],
      ['Tem estacionamento coberto?', 1, true, false],
    ];
    assert.deepEqual(r.grupos.map(g => [g.texto, g.ocorrencias, g.jaPublicada, g.precisaRevisar]), esperado);
    // A janela inteira é lida em lotes (Astra r1, P2): lote de 2 dá o mesmo resultado que o lote padrão.
    assert.deepEqual(await semFonte.perguntasSemFonte(rep, AGORA, 2), r);
    assert.deepEqual(await semFonte.perguntasSemFonte(rep, AGORA, 1), r);
    const tudo = JSON.stringify(r);
    for (const proibido of ['11987654321', 'production', 'outra empresa', 'não contatar', 'falar com uma pessoa', 'dois meses', 'um segundo', 'futuro', 'ana silva']) {
      assert.ok(!tudo.includes(proibido), `fora do recorte: ${proibido}`);
    }
    assert.deepEqual((await semFonte.perguntasSemFonte(outra, AGORA)).grupos.map(g => g.texto), ['Pergunta da outra empresa?']);

    // Papel e empresa: administrativo da mesma empresa não vê; sessão apontando outra empresa não prova o tenant.
    await assert.rejects(semFonte.perguntasSemFonte(adm, AGORA), /ATENDIMENTO_ACESSO_NEGADO/);
    await assert.rejects(semFonte.perguntasSemFonte({ ...outra, empresa_ativa_id: A }, AGORA), /ATENDIMENTO_SEM_ACESSO/);

    // A rota com a sessão de cada perfil (a sessão vem da autenticação, nunca do pedido).
    class ErroAuth extends Error { httpStatus: number; code = 'NAO_AUTENTICADO'; constructor(m: string, status: number) { super(m); this.httpStatus = status; } }
    function rota(sessao: SessaoParaTenant | null) {
      return carregarComponente('app/api/admin/atendimento/sem-fonte/route.ts', {
        'next/server': { NextResponse: { json: (b: unknown, i?: ResponseInit) => Response.json(b, i) } },
        '@/lib/clientes/services/errors': { isClienteServiceError: (e: unknown) => e instanceof ErroAuth },
        '@/lib/comercial/pacotes-admin': { PacoteAdminError: class extends Error {} },
        '@/lib/http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => { if (!sessao) throw new ErroAuth('Entre de novo.', 401); return sessao; } },
        '@/lib/whatsapp/atendimento/erros': erros,
        // Relógio fixo também pela rota (Astra r1, P3): o resultado não muda com a data em que o teste roda.
        '@/lib/whatsapp/atendimento/sem-fonte': { perguntasSemFonte: (s: SessaoParaTenant) => semFonte.perguntasSemFonte(s, AGORA) },
      }).modulo as { GET: (r: unknown) => Promise<Response> };
    }
    const pedido = { method: 'GET', headers: { get: () => null }, cookies: { get: () => undefined } };
    const chamar = async (s: SessaoParaTenant | null) => { const res = await rota(s).GET(pedido); return { status: res.status, cache: res.headers.get('cache-control'), json: await res.json() as { ok: boolean; codigo?: string; data?: { grupos: unknown[] } } }; };
    const okRep = await chamar(rep);
    assert.equal(okRep.status, 200);
    assert.equal(okRep.cache, 'no-store');
    assert.equal(okRep.json.ok, true);
    assert.deepEqual((okRep.json.data as unknown as typeof r), JSON.parse(JSON.stringify(r)));
    const negAdm = await chamar(adm);
    assert.deepEqual([negAdm.status, negAdm.json.ok, negAdm.json.codigo], [403, false, 'ATENDIMENTO_ACESSO_NEGADO']);
    const negOutra = await chamar({ ...outra, empresa_ativa_id: A });
    assert.deepEqual([negOutra.status, negOutra.json.ok], [403, false]);
    assert.ok(!JSON.stringify(negOutra.json).includes('fraldário'));
    const semSessao = await chamar(null);
    assert.deepEqual([semSessao.status, semSessao.json.ok], [401, false]);

    // Onda 2: a pergunta nova com marcador ou dado pessoal é recusada no servidor; a já salva continua valendo.
    const salvar = (perguntas: { id: string; pergunta: string; resposta: string }[]) => servico.salvarConfiguracao(rep, { ativo: false, nome: 'Empresa sintética', perguntas });
    const estac = { id: 'faq_estac', pergunta: 'Tem estacionamento coberto?', resposta: 'Sim, para 20 carros.' };
    await assert.rejects(salvar([estac, { id: 'faq_wifi', pergunta: 'Tem wi-fi? me chama no [telefone omitido]', resposta: 'Sim.' }]), /ATENDIMENTO_PERGUNTA_DADO_PESSOAL/);
    await assert.rejects(salvar([estac, { id: 'faq_wifi', pergunta: 'Tem wi-fi? me chama no 11987654321', resposta: 'Sim.' }]), /ATENDIMENTO_PERGUNTA_DADO_PESSOAL/);
    for (const pergunta of ['Meu filho tem diabetes, tem wifi?', 'Tem cadeira para pressão  alta?', 'Tem cardápio sem\nglúten?', core.REGISTRO_SENSIVEL, core.ENTRADA_SENSIVEL_OMITIDA, 'me chamo ana silva, tem wifi?', 'O pai se chama pedro silva, tem fraldário?']) {
      await assert.rejects(salvar([estac, { id: 'faq_wifi', pergunta, resposta: 'Sim.' }]), /ATENDIMENTO_PERGUNTA_DADO_PESSOAL/, pergunta);
    }
    // Exceção das perguntas antigas (Astra r1, P2): só a MESMA pergunta (mesmo id e texto), uma vez.
    const legada = { id: 'faq_legada', pergunta: 'Tem wi-fi? me liga 11987654321', resposta: 'Sim.' };
    await c.query(`INSERT INTO whatsapp_atendimento_config(empresa_id, ambiente, configuracao) VALUES ($1, 'staging', $2::jsonb) ON CONFLICT (empresa_id, ambiente) DO UPDATE SET configuracao = EXCLUDED.configuracao`,
      [A, JSON.stringify({ ativo: false, nome: 'Empresa sintética', perguntas: [estac, legada] })]);
    await salvar([estac, legada]);
    await assert.rejects(salvar([estac, legada, { ...legada, id: 'faq_copia' }]), /ATENDIMENTO_PERGUNTA_DADO_PESSOAL/, 'cópia com outro id');
    await assert.rejects(salvar([{ ...estac, pergunta: legada.pergunta }, legada]), /ATENDIMENTO_PERGUNTA_DADO_PESSOAL/, 'outra FAQ trocada para o texto antigo');
    // Id repetido já é recusado antes, pelo schema (Identificadores repetidos).
    await assert.rejects(salvar([estac, legada, { ...legada }]), /Identificadores repetidos/, 'mesmo id repetido');
    await salvar([estac, { id: 'faq_wifi', pergunta: 'Tem wi-fi no salão?', resposta: 'Sim, a senha fica na recepção.' }]);
    const depois = await semFonte.perguntasSemFonte(rep, AGORA);
    assert.equal(depois.publicadas, 2);
    assert.equal(erros.respostaDeErroAtendimento(new Error('ATENDIMENTO_PERGUNTA_DADO_PESSOAL')).status, 400);
    // O limite de 30 respostas aprovadas continua no servidor.
    const trinta = Array.from({ length: 31 }, (_, i) => ({ id: `faq_${i}`, pergunta: `Pergunta geral número ${i}?`, resposta: 'Resposta da empresa.' }));
    await assert.rejects(salvar(trinta));
    await salvar(trinta.slice(0, 30));
    assert.equal((await semFonte.perguntasSemFonte(rep, AGORA)).publicadas, 30);
  } finally {
    await c.end();
  }
});
