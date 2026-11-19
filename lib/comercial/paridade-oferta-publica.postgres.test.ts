import { AvailabilityServiceError } from "../disponibilidade/services/errors.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { DbExecutor } from "../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";
import { calcularResumoComercial } from "./services/pricing.service.ts";
import { PricingServiceError } from "./services/errors.ts";
import { consultarDisponibilidadePeriodo, revalidarHorarioSelecionado } from "../disponibilidade/services/availability.service.ts";
import type { HorarioCandidatoPublico } from "../disponibilidade/services/models.ts";
import { aplicarOferta, ofertasDoIntervalo } from "./oferta-intervalo.ts";

test("cada período comercial corresponde a ao menos uma cotação aceita na amostra", async () => {
  const cliente = await conectarDescartavel();
  try {
    await cliente.query("BEGIN");
    const tx: DbExecutor = { async query<Row extends object>(sql: string, params?: readonly unknown[]) {
      const r = await cliente.query<Row>(sql, params ? [...params] : []);
      return { rows: r.rows, rowCount: r.rowCount };
    } };
    const codigo = "f1" + randomUUID().slice(0, 8);
    const empresaId = (await cliente.query("INSERT INTO empresas (codigo,nome,status) VALUES ($1,'Buffet da prova','PROVISIONAMENTO') RETURNING id", [codigo])).rows[0].id;
    const escopo = { empresaId, estabelecimentoId: null };
    const p = (await cliente.query("INSERT INTO pacotes (empresa_id,codigo,nome,ordem_exibicao,ativo,vigente,convidados_minimos,convidados_maximos) VALUES ($1,'POCKET','Festa',1,true,true,20,50) RETURNING id", [empresaId])).rows[0].id;
    const inicio = "2030-03-01", fim = "2030-03-03";
    await cliente.query(`INSERT INTO regras_disponibilidade_pacote (pacote_id,dia_semana,configuracao_agenda_id,estado,vigencia_inicio)
      SELECT $1, dia, c.id, 'DISPONIVEL', $2 FROM configuracao_agenda c CROSS JOIN generate_series(1,7) dia
       WHERE c.codigo IN ('TURNO_1','TURNO_2') AND c.ativo AND c.empresa_id IS NULL`, [p,inicio]);
    const tabela = (await cliente.query(`INSERT INTO tabelas_preco (empresa_id,codigo,nome,vigencia_inicio,vigencia_fim,ativa)
      VALUES ($1,'F1','Prova comercial',$2,$2,false) RETURNING id`, [empresaId,inicio])).rows[0].id;
    await cliente.query(`INSERT INTO precos_pacote (tabela_preco_id,pacote_id,convidados_min,convidados_max,tipo_calculo,valor,categoria_horario)
      VALUES ($1,$2,20,50,'FIXO',1500,'GERAL')`,[tabela,p]);
    const cobertura = (await cliente.query("INSERT INTO tabela_preco_escopos (tabela_preco_id,pacote_id,categoria_horario,cobertura_continua) VALUES ($1,$2,'GERAL',false) RETURNING id",[tabela,p])).rows[0].id;
    await cliente.query("INSERT INTO tabela_preco_escopo_faixas (escopo_id,convidados_min,convidados_max) VALUES ($1,20,50)",[cobertura]);
    await cliente.query("UPDATE tabelas_preco SET publicada_em = clock_timestamp() WHERE id=$1", [tabela]);
    let comparacoes = 0;
    for (const porSalao of [false,true]) {
      if (porSalao) {
        const usuario = (await cliente.query("INSERT INTO usuarios_administrativos (email,nome,senha_hash,papel,ativo) VALUES ($1,'Prova',$2,'ADMINISTRATIVO',true) RETURNING id", [codigo+"@example.test","scrypt$v=1$N=131072$r=8$p=1$"+"A".repeat(22)+"==$"+"B".repeat(86)+"=="])).rows[0].id;
        await cliente.query("INSERT INTO agenda_escopo_config (empresa_id,modo,capacidade_tipo,intervalo_minimo_minutos,configurado_por) VALUES ($1,'FIXO','POR_SALAO',0,$2)",[empresaId,usuario]);
        const pequeno = (await cliente.query("INSERT INTO agenda_saloes (empresa_id,nome,ordem,capacidade_convidados) VALUES ($1,'Pequeno',1,20) RETURNING id",[empresaId])).rows[0].id;
        await cliente.query("INSERT INTO agenda_saloes (empresa_id,nome,ordem,capacidade_convidados) VALUES ($1,'Grande',2,80)",[empresaId]);
        await cliente.query("INSERT INTO pacote_saloes (pacote_id,salao_id) VALUES ($1,$2)",[p,pequeno]);
      }
      let aceitos = 0, recusados = 0;
      for (const convidados of [15,30,51]) {
        const saloesLivres = new Map<HorarioCandidatoPublico,string[]>();
        const dias = await consultarDisponibilidadePeriodo(inicio,fim,tx,undefined,escopo,{ convidados, saloesLivres });
        const ofertas = await ofertasDoIntervalo(tx,empresaId,false,inicio,fim,convidados,saloesLivres.size > 0);
        for (const dia of dias) {
          const calendario = aplicarOferta(dia,ofertas,false,convidados,saloesLivres);
          for (const periodo of calendario.periodos) {
            let aceita = false;
            for (const h of periodo.horarios) {
              try {
                await revalidarHorarioSelecionado({ data:dia.data,configuracaoId:periodo.configuracaoId,pacoteCodigo:"POCKET",convidados,...h },tx,escopo);
                const resumo = await calcularResumoComercial({data:dia.data,configuracaoAgendaId:periodo.configuracaoId,pacoteId:p,empresaEsperada:empresaId,convidados,adicionais:[]},tx);
                assert.equal(resumo.pacote.convidadosFaturados, Math.max(convidados,20));
                aceita = true;
                break;
              } catch (erro) {
                if (erro instanceof AvailabilityServiceError && ["SEM_SALAO_PARA_CONVIDADOS","HORARIO_NAO_DISPONIVEL"].includes(erro.code)) continue;
                if (!(erro instanceof PricingServiceError) || !["DADOS_INVALIDOS","TABELA_PRECO_NAO_CONFIGURADA","CATEGORIA_HORARIO_NAO_CONFIGURADA"].includes(erro.code)) throw erro;
              }
            }
            assert.equal(periodo.status === "DISPONIVEL", aceita, [dia.data,periodo.nome,convidados].join(" / "));
            comparacoes++;
            if (dia.data === inicio && convidados === 30) assert.equal(aceita, !porSalao);
            if (aceita) aceitos++; else recusados++;
          }
        }
      }
      assert.ok(aceitos && recusados, "a amostra deve exercer venda e recusa");
    }
    assert.equal(comparacoes,36);
  } finally {
    await encerrarDescartavel(cliente);
  }
});
