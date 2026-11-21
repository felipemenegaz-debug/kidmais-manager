import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as aguardar } from 'node:timers/promises';
import type { Client } from 'pg';
import { NextRequest } from 'next/server.js';
import {
  ambienteAssinatura, carregar, catalogoNativo, cenario, completarCliente, congelarEAssinarKidmais, cpfValido, dia, id, poolNaTransacao,
  representante,
} from '../../scripts/integracao-importados-test-support.ts';
import { travarConfiguracaoAgenda } from '../agenda/trava-configuracao.ts';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { apiPublica } from '../fechamentos/rota-publica.ts';
import { carregarComBanco, cliente, comercial, executor, fechamento, porTransacao } from '../marketing/harness-postgres.ts';
import type { SessaoMeuPedido } from './acesso-pedido.ts';

const ORIGEM = 'https://familia.example.test';
const PIX_ANTIGO = 'primeiro@example.test';
const PIX_NOVO = 'novo@example.test';
const PEPPER = 'pepper-sintetico-meu-pedido';
const BASE = '/api/meu-pedido';

function sessao(empresaId: string, clienteId: string): SessaoMeuPedido {
  return { empresaId, clienteId, expiraEm: Date.now() + 900_000 };
}

async function ligarPiloto(a: Client, empresa: string, gestor: string) {
  await a.query(`INSERT INTO pre_reserva_configuracoes(empresa_id,habilitada,sinal_centavos,atualizado_por)
    VALUES($1,true,10000,$2)`, [empresa, gestor]);
  await a.query(`INSERT INTO empresa_pix_recebimento(empresa_id,tipo_chave,chave,nome_recebedor,cidade_recebedor,atualizado_por)
    VALUES($1,'EMAIL',$2,'Buffet Teste','Sao Paulo',$3)`, [empresa, PIX_ANTIGO, gestor]);
}

async function corrida<T, U>(a: Client, b: Client, primeiro: () => Promise<T>, segundo: () => Promise<U>) {
  const pid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await a.query('BEGIN');
  let espera: Promise<U> | undefined;
  try {
    const inicial = await primeiro();
    espera = porTransacao(b)(segundo);
    void espera.catch(() => {});
    const ate = Date.now() + 10_000;
    while (!(await a.query<{ bloqueada: boolean }>('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS bloqueada', [pid])).rows[0].bloqueada) {
      assert.ok(Date.now() < ate, 'A segunda conexão deve esperar a primeira.');
      await aguardar(10);
    }
    await a.query('COMMIT');
    return [inicial, await espera] as const;
  } finally {
    await a.query('ROLLBACK');
    await espera?.catch(() => {});
  }
}

const aud = async (a: Client, pedido: string, acao: string) => (await a.query(
  `SELECT ator_tipo, cliente_id, dados_depois FROM auditoria WHERE entidade_id=$1 AND acao=$2 ORDER BY criado_em`,
  [pedido, acao])).rows;

function corpoAceite(oferta: { disponivel: true; termos: { versao: string }; versaoOferta: string }) {
  return { termosVersao: oferta.termos.versao, versaoOferta: oferta.versaoOferta };
}

test('Meu pedido: CPF e código, escopo, oferta, Pix, desistência, auditoria e schema ausente', async t => {
  const a = await conectarDescartavel();
  const b = await conectarDescartavel({ travar: false });
  try {
    const tx = executor(a);
    const servico = carregarComBanco('lib/pre-reserva/meu-pedido.ts', a, () => null) as typeof import('./meu-pedido.ts');
    const gestao = carregarComBanco('lib/pre-reserva/confirmacao.ts', a, () => null) as typeof import('./confirmacao.ts');
    const { empresa, externo, titular, semPedido, outro, cpf, cpfSemPedido, pedido, pedidoOutro, pedidoExterno, gestor, base } =
      await porTransacao(a)(async () => {
        const c = await cenario(a, 0);
        const e = await cenario(a, 0);
        const gestor = await representante(a, c);
        await ligarPiloto(a, c.empresa, gestor.usuarioId);
        const titular = await cliente(a, c.empresa, 'Titular', null);
        const semPedido = await cliente(a, c.empresa, 'Sem pedido', null);
        const outro = await cliente(a, c.empresa, 'Outro titular', null);
        const cpf = await completarCliente(a, titular);
        const cpfSemPedido = await completarCliente(a, semPedido);
        await travarConfiguracaoAgenda(tx, c.empresa, { modo: 'COMPARTILHADA', linha: 'KEY_SHARE' });
        const base = await comercial(a, c.empresa);
        const pedido = await fechamento(a, c.empresa, base, titular, { data: dia(90), status: 'AGUARDANDO_CONTRATO' });
        const pedidoOutro = await fechamento(a, c.empresa, base, outro, { data: dia(91), status: 'AGUARDANDO_CONTRATO' });
        const titularExterno = await cliente(a, e.empresa, 'Fora da empresa', null);
        await travarConfiguracaoAgenda(tx, e.empresa, { modo: 'COMPARTILHADA', linha: 'KEY_SHARE' });
        const pedidoExterno = await fechamento(a, e.empresa, await comercial(a, e.empresa), titularExterno,
          { data: dia(92), status: 'AGUARDANDO_CONTRATO' });
        return { empresa: c.empresa, externo: e.empresa, titular, semPedido, outro, cpf, cpfSemPedido, pedido, pedidoOutro,
          pedidoExterno, gestor, base };
      });

    const sess = sessao(empresa, titular);
    const listar = (acesso = sess) => porTransacao(a)(db => servico.listarMeuPedido(db, empresa, acesso, PEPPER));
    const oferta = async () => {
      const atual = (await listar())[0].oferta;
      assert.ok(atual.disponivel);
      return atual;
    };
    const aceitar = (dados: ReturnType<typeof corpoAceite>, acesso = sess, p = pedido) =>
      porTransacao(a)(db => servico.aceitarOfertaMeuPedido(db, empresa, acesso, p, dados, PEPPER));
    const pix = (p = pedido) => porTransacao(a)(db => servico.pixMeuPedido(db, empresa, sess, p));
    const desistir = () => porTransacao(a)(db => servico.desistirMeuPedido(db, empresa, sess, pedido));

    const entregues: string[] = [];
    const cache = new Map();
    const carregarRota = (arquivo: string) => carregarComBanco(arquivo, a, () => null, {
      'db/postgres': { db: () => tx, withTransaction: porTransacao(a) },
      'identidade/delivery/index': { enviarOtpComAmbiente: async ({ codigo }: { codigo: string }) => { entregues.push(codigo); } },
    }, cache);
    const rotaInicio = carregarRota('app/api/meu-pedido/entrada/iniciar/route.ts') as typeof import('../../app/api/meu-pedido/entrada/iniciar/route.ts');
    const rotaConfirmacao = carregarRota('app/api/meu-pedido/entrada/confirmar/route.ts') as typeof import('../../app/api/meu-pedido/entrada/confirmar/route.ts');
    const rotaLeitura = carregarRota('app/api/meu-pedido/route.ts') as typeof import('../../app/api/meu-pedido/route.ts');
    const rotaDesistencia = carregarRota('app/api/meu-pedido/[pedidoId]/desistencia/route.ts') as typeof import('../../app/api/meu-pedido/[pedidoId]/desistencia/route.ts');
    const acesso = carregarComBanco('lib/pre-reserva/acesso-pedido.ts', a, () => null) as typeof import('./acesso-pedido.ts');
    const requisicao = (path: string, corpo?: unknown, cookie?: string) => new NextRequest(ORIGEM + path, {
      method: corpo === undefined ? 'GET' : 'POST',
      headers: { origin: ORIGEM, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const ambiente = { AGENDA_PUBLICA_EMPRESA_ID: empresa, AGENDA_PUBLICA_UNIDADE_ID: '', AREA_FAMILIA_PUBLIC_ORIGIN: ORIGEM,
      IDENTIDADE_OTP_PEPPER: PEPPER, COTACAO_PUBLICA_POR_EMPRESA: 'true', KIDMAIS_DEPLOY_ENV: 'local' };
    for (const [nome, valor] of Object.entries(ambiente)) {
      const anterior = process.env[nome];
      process.env[nome] = valor;
      t.after(() => { if (anterior === undefined) delete process.env[nome]; else process.env[nome] = anterior; });
    }

    await t.test('entrada tem a mesma resposta com pedido, sem pedido e sem cadastro', async () => {
      const respostas: Array<{ desafio: string; expiraEm: string }> = [];
      for (const doc of [cpf, cpfSemPedido, cpfValido()]) {
        const r = await rotaInicio.POST(requisicao(BASE + '/entrada/iniciar', { cpf: doc }));
        assert.equal(r.status, 202);
        assert.equal(r.headers.get('cache-control'), 'no-store');
        const resposta = await r.json();
        assert.deepEqual(Object.keys(resposta.data).sort(), ['desafio', 'expiraEm']);
        assert.doesNotMatch(resposta.data.desafio, /[.]/);
        respostas.push(resposta.data);
      }
      assert.equal(entregues.length, 2);
      assert.equal(respostas[0].desafio.length, respostas[2].desafio.length);
      const empresaExterna = (await a.query<{ codigo: string }>('SELECT codigo FROM empresas WHERE id=$1', [externo])).rows[0].codigo;
      const confirmar = (i: number, codigo: string, empresa?: string) => rotaConfirmacao.POST(requisicao(
        apiPublica(BASE + '/entrada/confirmar', empresa), { desafio: respostas[i].desafio, codigo }));
      assert.equal((await confirmar(0, entregues[0], empresaExterna)).status, 401);
      for (const [i, esperado] of [titular, semPedido].entries()) {
        const r = await confirmar(i, entregues[i]);
        assert.equal(r.status, 200);
        assert.deepEqual(await r.json(), { ok: true });
        const cookie = r.headers.get('set-cookie')!;
        for (const atributo of ['HttpOnly', 'Secure', 'SameSite=lax', 'Path=/api/meu-pedido', 'Max-Age=900'])
          assert.ok(cookie.toLowerCase().includes(atributo.toLowerCase()), atributo);
        const token = cookie.split(';')[0].split('=')[1];
        assert.equal(acesso.lerSessaoMeuPedido(empresa, token, PEPPER)?.clienteId, esperado);
        const leitura = await rotaLeitura.GET(requisicao(BASE, undefined, cookie.split(';')[0]));
        assert.equal(leitura.status, 200);
        assert.deepEqual((await leitura.json()).data.pedidos.map((p: { id: string }) => p.id), i === 0 ? [pedido] : []);
        assert.equal((await confirmar(i, entregues[i])).status, 401);
      }
      assert.equal((await confirmar(2, '000000')).status, 401);
    });

    await t.test('a sessão expira e identificadores de outro titular/empresa recebem a mesma recusa', async () => {
      const expirado = acesso.emitirSessaoMeuPedido(empresa, titular, PEPPER, Date.now() - 901_000);
      assert.equal(acesso.lerSessaoMeuPedido(empresa, expirado, PEPPER), null);
      const cookie = acesso.nomeCookiePedido(empresa) + '=' + expirado;
      assert.equal((await rotaLeitura.GET(requisicao(BASE, undefined, cookie))).status, 401);
      assert.deepEqual((await listar()).map(p => p.id), [pedido]);
      assert.deepEqual((await listar(sessao(empresa, outro))).map(p => p.id), [pedidoOutro]);
      await assert.rejects(listar(sessao(externo, titular)), { code: 'SESSAO_ENCERRADA' });
      const dados = corpoAceite(await oferta());
      for (const p of [pedidoOutro, pedidoExterno, randomUUID()]) {
        await assert.rejects(aceitar(dados, sess, p), { code: 'PEDIDO_INDISPONIVEL' });
        await assert.rejects(pix(p), { code: 'PEDIDO_INDISPONIVEL' });
        await assert.rejects(porTransacao(a)(db => servico.desistirMeuPedido(db, empresa, sess, p)), { code: 'PEDIDO_INDISPONIVEL' });
      }
      await assert.rejects(pix(), { code: 'ACEITE_NECESSARIO' });
    });

    await t.test('aceite concorrente grava uma linha; versão, preço e recebedor precisam bater com a oferta', async () => {
      const dados = corpoAceite(await oferta());
      await assert.rejects(aceitar({ ...dados, termosVersao: 'antiga' }), { code: 'TERMOS_DESATUALIZADOS' });
      await assert.rejects(porTransacao(a)(async db => {
        await servico.aceitarOfertaMeuPedido(db, empresa, sess, pedido, dados, PEPPER);
        assert.equal((await aud(a, pedido, 'PRE_RESERVA_ACEITE')).length, 1);
        throw new Error('rollback do aceite');
      }), /rollback do aceite/);
      assert.deepEqual(await aud(a, pedido, 'PRE_RESERVA_ACEITE'), []);
      await assert.rejects(pix(), { code: 'ACEITE_NECESSARIO' });

      const [um, dois] = await corrida(a, b, () => servico.aceitarOfertaMeuPedido(tx, empresa, sess, pedido, dados, PEPPER),
        () => servico.aceitarOfertaMeuPedido(executor(b), empresa, sess, pedido, dados, PEPPER));
      assert.deepEqual(um, dois);
      assert.equal(um.sequencia, 1);
      assert.equal((await aud(a, pedido, 'PRE_RESERVA_ACEITE')).length, 1);
      assert.equal((await a.query(`SELECT 1 FROM fechamentos f
        CROSS JOIN LATERAL kidmais094_ocupacoes(f.data_evento,f.data_evento) o WHERE f.id=$1 AND o.fechamento_id=f.id`, [pedido])).rowCount, 0);
      assert.equal((await listar())[0].preReserva.aguardandoConferencia, true);
      const original = await pix();
      assert.match(original.copiaECola, /primeiro@example\.test/);

      await a.query('UPDATE pre_reserva_configuracoes SET sinal_centavos=12000 WHERE empresa_id=$1', [empresa]);
      await assert.rejects(aceitar(dados), { code: 'OFERTA_DESATUALIZADA' });
      const novoValor = corpoAceite(await oferta());
      await a.query('UPDATE empresa_pix_recebimento SET chave=$2 WHERE empresa_id=$1', [empresa, PIX_NOVO]);
      await assert.rejects(aceitar(novoValor), { code: 'OFERTA_DESATUALIZADA' });
      assert.deepEqual(await pix(), original);
      assert.equal((await aceitar(corpoAceite(await oferta()))).sequencia, 2);
      assert.match((await pix()).copiaECola, /novo@example\.test/);
      const [evento] = await aud(a, pedido, 'PRE_RESERVA_ACEITE');
      assert.equal(evento.ator_tipo, 'CLIENTE');
      assert.equal(evento.cliente_id, titular);
      const instante = evento.dados_depois.instante;
      assert.ok(Number.isFinite(Date.parse(instante)));
      assert.deepEqual(evento.dados_depois, { empresaId: empresa, fechamentoId: pedido, movimento: '1', instante });
    });

    await t.test('piloto desligado preserva leitura, Pix pendente e desistência; garantia existente impede aceite', async () => {
      const dados = corpoAceite(await oferta());
      await a.query('UPDATE pre_reserva_configuracoes SET habilitada=false WHERE empresa_id=$1', [empresa]);
      assert.deepEqual((await listar())[0].oferta, { disponivel: false, motivo: 'PILOTO_DESLIGADO' });
      await assert.rejects(aceitar(dados), { code: 'PILOTO_DESLIGADO' });
      assert.equal((await pix()).aceiteSequencia, 2);

      const referencia = 'E1234567820261120123400011223344';
      await porTransacao(a)(async db => {
        await a.query('SELECT 1 FROM empresas WHERE id=$1 FOR UPDATE', [empresa]);
        const r = await gestao.confirmarSinal(db, gestor, pedido, { referencia, valorCentavos: 12000, aceiteSequencia: 2 });
        assert.ok(r.garantiaAte);
      });
      await assert.rejects(aceitar(dados), { code: 'GARANTIA_EXISTENTE' });
      await assert.rejects(pix(), { code: 'PIX_NAO_PENDENTE' });
      const ctx = { params: Promise.resolve({ pedidoId: pedido }) };
      const cookie = acesso.nomeCookiePedido(empresa) + '=' + acesso.emitirSessaoMeuPedido(empresa, titular, PEPPER);
      const r = await rotaDesistencia.POST(requisicao(BASE + '/' + pedido + '/desistencia', { confirmarLiberacao: false }, cookie), ctx);
      assert.equal((await r.json()).codigo, 'CONFIRMACAO_NECESSARIA');
      assert.equal((await listar())[0].preReserva.garantia?.situacao, 'ATIVA');
      await assert.rejects(porTransacao(a)(async db => {
        await servico.desistirMeuPedido(db, empresa, sess, pedido);
        assert.equal((await aud(a, pedido, 'PRE_RESERVA_DESISTENCIA')).length, 1);
        throw new Error('rollback da desistência');
      }), /rollback da desistência/);
      assert.deepEqual(await aud(a, pedido, 'PRE_RESERVA_DESISTENCIA'), []);
      const atual = await desistir();
      assert.deepEqual(await desistir(), atual);
      assert.equal(atual.preReserva.garantia?.situacao, 'DESISTENCIA');
      assert.equal(atual.preReserva.dinheiro[0].situacao, 'A_DEVOLVER');
      assert.doesNotMatch(JSON.stringify(atual), new RegExp(referencia + '|novo@example'));
      const eventos = await aud(a, pedido, 'PRE_RESERVA_DESISTENCIA');
      assert.equal(eventos.length, 1);
      assert.deepEqual(eventos[0].dados_depois, {
        empresaId: empresa, fechamentoId: pedido, movimento: 'DESISTENCIA', instante: eventos[0].dados_depois.instante,
      });
    });

    await t.test('schema incompleto ou ausente dá 503 em todas as rotas antes de efeitos', async () => {
      const aceite = carregarRota('app/api/meu-pedido/[pedidoId]/aceite/route.ts') as typeof import('../../app/api/meu-pedido/[pedidoId]/aceite/route.ts');
      const pixApi = carregarRota('app/api/meu-pedido/[pedidoId]/pix/route.ts') as typeof import('../../app/api/meu-pedido/[pedidoId]/pix/route.ts');
      const ctx = { params: Promise.resolve({ pedidoId: pedido }) };
      const confere = async () => {
        const respostas = await Promise.all([
          rotaInicio.POST(requisicao(BASE + '/entrada/iniciar', { cpf })),
          rotaConfirmacao.POST(requisicao(BASE + '/entrada/confirmar', {})),
          rotaLeitura.GET(requisicao(BASE)), aceite.POST(requisicao(BASE + '/aceite', {}), ctx),
          pixApi.GET(requisicao(BASE + '/pix'), ctx), rotaDesistencia.POST(requisicao(BASE + '/desistencia', {}), ctx),
        ]);
        for (const r of respostas) {
          assert.equal(r.status, 503);
          assert.equal((await r.json()).codigo, 'PRE_RESERVA_INDISPONIVEL');
        }
      };
      await a.query('BEGIN');
      try {
        await a.query('ALTER TABLE pre_reserva_aceites DISABLE TRIGGER a131_config_antes_do_aceite');
        await confere();
        await a.query('ALTER VIEW pre_reserva_situacoes RENAME TO teste_pre_reserva_situacoes_ausente');
        await confere();
        assert.equal(entregues.length, 2);
        await travarConfiguracaoAgenda(tx, empresa, { modo: 'COMPARTILHADA', linha: 'KEY_SHARE' });
        const comum = await fechamento(a, empresa, base, titular, { data: dia(93), status: 'AGUARDANDO_CONTRATO' });
        assert.equal((await a.query('SELECT status FROM fechamentos WHERE id=$1', [comum])).rows[0].status, 'AGUARDANDO_CONTRATO');
      } finally {
        await a.query('ROLLBACK');
      }
    });
  } finally {
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(a);
  }
});

test('formalização em papel e desistência serializam nas duas ordens, com um destino para o sinal', async () => {
  const a = await conectarDescartavel();
  const b = await conectarDescartavel({ travar: false });
  const restaurarAmbiente = ambienteAssinatura();
  const servico = carregarComBanco('lib/pre-reserva/meu-pedido.ts', a, () => null) as typeof import('./meu-pedido.ts');
  const papel = carregar<typeof import('../contratos/services/assinatura-papel-cliente.service.ts')>('lib/contratos/services/assinatura-papel-cliente.service.ts');
  const contratos = carregar<typeof import('../contratos/services/contrato.service.ts')>('lib/contratos/services/contrato.service.ts');
  const admin = carregar<typeof import('../contratos/services/administrativo.service.ts')>('lib/contratos/services/administrativo.service.ts');
  const gestao = carregarComBanco('lib/pre-reserva/confirmacao.ts', a, () => null) as typeof import('./confirmacao.ts');
  try {
    for (const desistiuPrimeiro of [false, true]) {
      const { empresa, papelGestor, versao, pedido, acesso } = await porTransacao(a)(async tx => {
        const c = await cenario(a, 0);
        const nativo = await catalogoNativo(a, c);
        const gestor = nativo.representante;
        await ligarPiloto(a, c.empresa, gestor.usuarioId);
        await a.query(`INSERT INTO modelos_contrato_empresa(empresa_id,versao,conteudo,conteudo_sha256,aprovado_por)
          VALUES($1,1,$2,$3,$4)`, [c.empresa, JSON.stringify({
          titulo: 'Contrato', contratada: { nome: 'Buffet', documento: '12.345.678/0001-90', endereco: 'Rua Teste, 2', representante: 'Pessoa Teste' },
          preambulo: [], observacoes: [], cidadeAssinatura: 'Cidade Teste',
          clausulas: [{ titulo: 'Objeto', texto: 'Festa em {{festa.data}} para {{contratante.nome}}.' }],
        }), 'a'.repeat(64), c.usuario]);
        const titular = await cliente(a, c.empresa, 'Cliente sintético', null);
        await completarCliente(a, titular);
        const aniversariante = await id(a, `INSERT INTO aniversariantes(cliente_id,nome) VALUES($1,'Aniversariante') RETURNING id`, [titular]);
        await travarConfiguracaoAgenda(tx, c.empresa, { modo: 'COMPARTILHADA', linha: 'KEY_SHARE' });
        const p = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id,
          empresa_id, pacote_id, tabela_preco_id, preco_pacote_id, categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados,
          valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status)
          SELECT $1::date, '10:00','22:00',$2,$3,p.id,pp.tabela_preco_id,pp.id,'PADRAO','PADRAO',30,30,100,100,100,
          'ATENDIMENTO_KIDMAIS',$5,$6,'AGUARDANDO_CONTRATO'
          FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id=p.id WHERE p.id=$4 LIMIT 1 RETURNING fechamentos.id`,
        [dia(130), nativo.turno, c.empresa, c.pacote, titular, aniversariante]);
        const acesso = sessao(c.empresa, titular);
        const configurarPool = poolNaTransacao(a);
        let versao: string;
        try {
          const gerado = await contratos.gerarContrato({ fechamentoId: p },
            { usuarioId: c.usuario, origem: 'SISTEMA', executor: tx });
          versao = gerado.versao.id;
          await congelarEAssinarKidmais(a, admin.operarContrato as unknown as Parameters<typeof congelarEAssinarKidmais>[1],
            versao, c.empresa, c.token, nativo.tokenRepresentante);
        } finally {
          configurarPool();
        }
        const { oferta } = (await servico.listarMeuPedido(tx, c.empresa, acesso, PEPPER))[0];
        assert.ok(oferta.disponivel);
        const aceite = await servico.aceitarOfertaMeuPedido(tx, c.empresa, acesso, p, corpoAceite(oferta), PEPPER);
        await a.query('SELECT 1 FROM empresas WHERE id=$1 FOR UPDATE', [c.empresa]);
        const ref = 'E123456782026112012340000000000' + (desistiuPrimeiro ? '1' : '2');
        const garantia = await gestao.confirmarSinal(tx, gestor, p, {
          referencia: ref, valorCentavos: aceite.sinalCentavos, aceiteSequencia: aceite.sequencia,
        });
        assert.ok(garantia.garantiaAte);
        return { empresa: c.empresa, papelGestor: nativo.tokenRepresentante, versao, pedido: p, acesso };
      });
      const desistir = (c: Client) => servico.desistirMeuPedido(executor(c), empresa, acesso, pedido);
      const formalizar = async (c: Client) => {
        const restaurarPool = poolNaTransacao(c);
        try {
          const hoje = (await c.query<{ d: string }>(`SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date::text AS d`)).rows[0].d;
          return await papel.registrarAssinaturaPapelCliente(versao, { dataDeclarada: hoje, chaveIdempotencia: randomUUID() },
            null, papelGestor, { requestId: randomUUID(), ip: null, userAgent: 'pg-meu-pedido' }, empresa);
        } finally {
          restaurarPool();
        }
      };
      if (desistiuPrimeiro) {
        const [r] = await corrida(a, b, () => desistir(a), () => formalizar(b));
        assert.equal(r.preReserva.garantia?.situacao, 'DESISTENCIA');
      } else {
        const [, r] = await corrida(a, b, () => formalizar(a), () => desistir(b));
        assert.equal(r.preReserva.dinheiro[0].situacao, 'CREDITO_CONTRATO');
      }
      const r = await porTransacao(a)(() => desistir(a));
      assert.deepEqual(r.preReserva.dinheiro.map(d => d.situacao), [desistiuPrimeiro ? 'A_DEVOLVER' : 'CREDITO_CONTRATO']);
      assert.equal((await aud(a, pedido, 'PRE_RESERVA_DESISTENCIA')).length, desistiuPrimeiro ? 1 : 0);
    }
  } finally {
    restaurarAmbiente();
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(a);
  }
});
