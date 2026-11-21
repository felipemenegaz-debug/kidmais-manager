import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as aguardar } from 'node:timers/promises';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarComBanco, cliente, comercial, executor, fechamento, porTransacao } from '../marketing/harness-postgres.ts';
import { cenario, representante } from '../../scripts/integracao-importados-test-support.ts';
import { travarConfiguracaoAgenda } from '../agenda/trava-configuracao.ts';

test('4a: Gestão, dois autores, instantes da baixa e auditoria transacional', async () => {
  const a = await conectarDescartavel();
  const b = await conectarDescartavel({ travar: false });
  try {
    const dev = carregarComBanco('lib/pre-reserva/devolucao.ts', a, () => ({})) as typeof import('./devolucao.ts');
    const { executarNoTenant } = carregarComBanco('lib/saas/provar-tenant.ts', a, () => ({})) as typeof import('../saas/provar-tenant.ts');
    const ref = 'E12345678202611201234Ab123456789';
    const { empresa, gestor, segundo, externo, equipe, pedido } = await porTransacao(a)(async tx => {
      const c = await cenario(a, 0);
      const gestor = await representante(a, c);
      const segundo = await representante(a, c);
      const externo = await representante(a, await cenario(a, 0));
      const titular = await cliente(a, c.empresa, 'Titular sintético', null);
      const base = await comercial(a, c.empresa);
      await travarConfiguracaoAgenda(tx, c.empresa, { modo: 'COMPARTILHADA', linha: 'KEY_SHARE' });
      const pedido = await fechamento(a, c.empresa, base, titular, { data: '2028-08-10', status: 'AGUARDANDO_CONTRATO' });
      await a.query(`INSERT INTO pre_reserva_aceites(empresa_id,fechamento_id,cliente_id,inicio_evento,fim_evento,
        preco_aceito_centavos,sinal_centavos,recebedor,chave_pix,termos_versao,termos_aceitos)
        VALUES($1,$2,$3,'2028-08-10 18:00Z','2028-08-10 21:00Z',25000,10000,'Teste','pix@example.test','1','Teste')`,
        [c.empresa,pedido,titular]);
      await a.query(`INSERT INTO pre_reserva_recebimentos(empresa_id,fechamento_id,end_to_end_id,valor_centavos,confirmado_por,motivo_sem_garantia)
        VALUES($1,$2,$3,9900,$4,'VALOR_DIVERGENTE')`, [c.empresa,pedido,ref,gestor.usuarioId]);
      return { empresa: c.empresa, gestor, segundo, externo, equipe: c.tenant, pedido };
    });

    const como = (usuarioId: string, work: Parameters<typeof executarNoTenant<void>>[3]) =>
      porTransacao(a)(tx => executarNoTenant(tx, { usuario_id: usuarioId, papel: 'ADMINISTRATIVO' }, null, work));
    const aud = async () => (await a.query(`SELECT acao,usuario_id,dados_depois FROM auditoria
      WHERE entidade_id=$1 AND origem='PRE_RESERVA' ORDER BY criado_em`, [pedido])).rows;
    const dados = { referencia: 'SAIDA-SINTETICA', valorCentavos: 9900, extratoConferido: true };
    const baixa = (devolvidoEm: string) => ({ ...dados, devolvidoEm });
    const erros = { indisponivel: { code: 'BAIXA_INDISPONIVEL' }, papel: { code: 'PAPEL_NAO_AUTORIZADO' } };
    const lista = () => porTransacao(a)(tx => dev.filaDevolucao(tx, gestor));
    const assumir = () => como(gestor.usuarioId, (tx, tenant) => dev.assumirDevolucao(tx, tenant, ref));

    await como(externo.usuarioId, async (tx, tenant) => {
      assert.deepEqual(await dev.filaDevolucao(tx, tenant), []);
      await assert.rejects(dev.assumirDevolucao(tx, tenant, ref), { code: 'DEVOLUCAO_INDISPONIVEL' });
      await assert.rejects(dev.confirmarDevolucao(tx, tenant, ref, baixa('2020-01-01T12:00:00-03:00')), erros.indisponivel);
    });
    await como(equipe.usuarioId, async (tx, tenant) => {
      await assert.rejects(dev.filaDevolucao(tx, tenant), erros.papel);
      await assert.rejects(dev.assumirDevolucao(tx, tenant, ref), erros.papel);
      await assert.rejects(dev.confirmarDevolucao(tx, tenant, ref, baixa('2020-01-01T12:00:00-03:00')), erros.papel);
    });
    assert.equal((await lista())[0].motivo, 'VALOR_DIVERGENTE');
    await assert.rejects(como(gestor.usuarioId, async (tx, tenant) => {
      await dev.assumirDevolucao(tx, tenant, ref);
      assert.equal((await aud()).length, 1);
      throw new Error('rollback sintético após auditoria');
    }), /rollback sintético/);
    assert.deepEqual(await aud(), []);
    assert.equal((await lista())[0].situacao, 'A_DEVOLVER');
    await assumir();
    await assumir();

    const limite = (await lista())[0].devolucao_assumida_em;
    assert.ok(limite);
    assert.match(limite, /\.\d{6}Z$/);
    const formato = 'YYYY-MM-DD"T"HH24:MI:SS.US"-03:00"';
    const { limiteExato, antes, futuro } = (await a.query(`SELECT
      devolucao_assumida_em=$4::timestamptz AS "limiteExato",
      to_char((devolucao_assumida_em-interval '1 microsecond') AT TIME ZONE 'America/Sao_Paulo',$3) AS antes,
      to_char((clock_timestamp()+interval '1 hour') AT TIME ZONE 'America/Sao_Paulo',$3) AS futuro
      FROM pre_reserva_recebimentos WHERE empresa_id=$1 AND end_to_end_id=$2`, [empresa,ref,formato,limite])).rows[0];
    assert.equal(limiteExato, true);
    const antesQueArredonda = antes.replace('-03:00', '9-03:00');
    for (const invalida of [limite.slice(0,10), limite.slice(0,-1), antesQueArredonda]) {
      await assert.rejects(porTransacao(a)(tx => dev.confirmarDevolucao(tx, segundo, ref, baixa(invalida))), { code: 'BAIXA_INVALIDA' });
    }
    for (const fora of [antes, futuro]) {
      await assert.rejects(porTransacao(a)(tx => dev.confirmarDevolucao(tx, segundo, ref, baixa(fora))), erros.indisponivel);
    }
    await assert.rejects(porTransacao(a)(tx => dev.confirmarDevolucao(tx, segundo, ref, { ...baixa(limite), valorCentavos: 9800 })), erros.indisponivel);

    await a.query('BEGIN');
    let perdedora: Promise<void> | undefined;
    try {
      await dev.confirmarDevolucao(executor(a), segundo, ref, baixa(limite));
      const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      perdedora = assert.rejects(porTransacao(b)(tx => dev.confirmarDevolucao(tx, gestor, ref, {
        ...baixa(limite), referencia: 'OUTRA-SAIDA',
      })), erros.indisponivel);
      void perdedora.catch(() => {});
      const ate = Date.now() + 10000;
      while (!(await a.query('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS espera', [pid])).rows[0].espera) {
        assert.ok(Date.now() < ate, 'a segunda baixa deve esperar a primeira');
        await aguardar(10);
      }
      await a.query('COMMIT');
      await perdedora;
    } finally {
      await a.query('ROLLBACK');
      await perdedora?.catch(() => {});
    }
    await como(segundo.usuarioId, (tx, tenant) => dev.confirmarDevolucao(tx, tenant, ref, baixa(limite)));
    assert.deepEqual(await lista(), []);
    assert.deepEqual((await a.query(`SELECT r.devolucao_assumida_por,s.devolvido_por,s.dinheiro
      FROM pre_reserva_situacoes s JOIN pre_reserva_recebimentos r USING(empresa_id,end_to_end_id)
      WHERE s.fechamento_id=$1`, [pedido])).rows, [{
      devolucao_assumida_por: gestor.usuarioId, devolvido_por: segundo.usuarioId, dinheiro: 'DEVOLVIDO',
    }]);
    await assert.rejects(a.query('UPDATE pre_reserva_recebimentos SET devolvido_por=$2 WHERE fechamento_id=$1', [pedido,gestor.usuarioId]), { code: '23514' });
    const eventos = await aud();
    assert.deepEqual(eventos.map(e => [e.acao,e.usuario_id]), [
      ['PRE_RESERVA_DEVOLUCAO_ASSUMIDA',gestor.usuarioId], ['PRE_RESERVA_DEVOLUCAO_CONFIRMADA',segundo.usuarioId],
    ]);
    for (const { dados_depois: d } of eventos) {
      assert.deepEqual(d, { empresaId: empresa, fechamentoId: pedido, movimento: ref, instante: d.instante });
      assert.ok(Number.isFinite(Date.parse(d.instante)));
    }

    const outraRef = 'E12345678202611201234Ab123456790';
    await porTransacao(a)(async tx => {
      await travarConfiguracaoAgenda(tx, empresa, { modo: 'COMPARTILHADA', linha: 'KEY_SHARE' });
      await tx.query(`INSERT INTO pre_reserva_recebimentos(empresa_id,fechamento_id,end_to_end_id,valor_centavos,confirmado_por,motivo_sem_garantia)
        VALUES($1,$2,$3,9900,$4,'VALOR_DIVERGENTE')`, [empresa,pedido,outraRef,gestor.usuarioId]);
      await dev.assumirDevolucao(tx, gestor, outraRef);
    });
    const filaAntesDoConflito = await lista();
    assert.equal(filaAntesDoConflito.length, 1);
    const [outra] = filaAntesDoConflito;
    assert.equal(outra.end_to_end_id, outraRef);
    assert.equal(outra.situacao, 'EM_DEVOLUCAO');
    assert.ok(outra.devolucao_assumida_em);
    const eventosAntesDoConflito = await aud();
    const baixaDuplicada = baixa(outra.devolucao_assumida_em);
    await assert.rejects(como(segundo.usuarioId, (tx, tenant) => dev.confirmarDevolucao(tx, tenant, outraRef, baixaDuplicada)), {
      code: 'REFERENCIA_DEVOLUCAO_EM_USO', httpStatus: 409,
    });
    assert.deepEqual(await lista(), filaAntesDoConflito);
    assert.deepEqual(await aud(), eventosAntesDoConflito);
  } finally {
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(a);
  }
});
