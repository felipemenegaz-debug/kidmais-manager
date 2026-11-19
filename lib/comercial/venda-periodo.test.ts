import type { DisponibilidadeDataPublica } from "../disponibilidade/services/models.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { carregarModulo } from "../acessos/teste-carregador.ts";
import { motivoPacoteNoPeriodo, type OfertaPeriodo } from "./venda-periodo.ts";
import { erroConvidadosPizzaParty, limitesPizzaParty } from "./pacotes-v1.ts";
import { aplicarOferta } from "./oferta-intervalo.ts";
import { estadoDoDia } from "../../components/disponibilidade/convidados-tela.ts";

const noite = "11111111-1111-4111-8111-111111111111";
const sabado = "2026-11-28";
const oferta: OfertaPeriodo = { codigo: "POCKET", convidadosMinimos: 20, convidadosMaximos: 50, disponibilidade: [
  { dia: 6, horario: "noite", configuracaoId: noite, estado: "DISPONIVEL", vigenciaInicio: "2026-11-01", vigenciaFim: "2026-11-30" }
] };
test("venda exige capacidade, dia, horário e vigência; sob consulta não vende", () => {
  for (const [n, data, id] of [[51,sabado,noite], [30,"2026-11-27",noite], [30,"2026-12-05",noite], [30,sabado,"outro"]] as const)
    assert.ok(motivoPacoteNoPeriodo(oferta,true,n,data,id));
  assert.equal(motivoPacoteNoPeriodo(oferta,true,30,sabado,noite),null);
  assert.equal(motivoPacoteNoPeriodo(oferta,true,15,sabado,noite),null);
  assert.ok(motivoPacoteNoPeriodo({...oferta,disponibilidade:[]},true,30,sabado,noite));
  assert.equal(motivoPacoteNoPeriodo({...oferta,codigo:"PIZZA_PARTY"},true,30,sabado,noite),"Sob consulta");
  assert.equal(motivoPacoteNoPeriodo({...oferta,disponibilidade:[{...oferta.disponibilidade[0],estado:"SOB_CONSULTA"}]},false,30,sabado,noite),"Sob consulta");
});
test("Pizza aplica faixa publicada e reserva por extremo ausente",()=>{
  assert.deepEqual(limitesPizzaParty(),{minimo:20,maximo:100});
  assert.deepEqual(limitesPizzaParty({minimo:null,maximo:50}),{minimo:20,maximo:50});
  assert.ok(erroConvidadosPizzaParty("PIZZA_PARTY",75,{minimo:1,maximo:50}));
});
for (const empresa of [undefined,"buffet-a"]) {
  test("rota de dois meses: só uma leitura comercial, motivo sem pacote e horário bloqueado: "+(empresa??"Kidmais"),async()=>{
    const periodo = {configuracaoId:noite, codigo:"TURNO_2",status:"DISPONIVEL",horarios:[{status:"DISPONIVEL"}]};
    const dias = [sabado,"2026-11-30"].map(data=>({data,periodos:[periodo]}));
    let consultas=0;
    const sqlComercial={query:async(sql:string,params:unknown[])=>{
      if (!sql.includes("LEFT JOIN regras_disponibilidade_pacote")) return {rows:[]};
      consultas++;
      assert.match(sql,/p\.empresa_id = \$1/);
      assert.deepEqual(params.slice(0,3),["tenant","2026-11-01","2026-12-31"]);
      assert.equal(params[3]===null,Boolean(empresa));
      return {rows:[{datas_com_preco:["2026-11-30"],saloes:[],pacote:"POCKET",minimo:20,maximo:50,configuracao_id:noite,codigo:"TURNO_2",dia_semana:1,estado:"DISPONIVEL",vigencia_inicio:"2026-01-01",vigencia_fim:null}]};
    }};
    const {GET}=carregarModulo("app/api/disponibilidade/route.ts",{
      "next/server":{NextResponse:{json:(body:unknown)=>body}},
      "lib/db/postgres":{db:()=>sqlComercial}, "lib/http/limite-publico":{limitarPublico:async()=>null},
      "lib/agenda/combinados-publicos":{combinadosPublicos:async()=>false},
      "lib/disponibilidade/escopo":{escopoPublico:async()=>({empresaId:"tenant"})},
      "lib/comercial/cotacao-publica":{codigoEmpresaDoPedido:()=>empresa??null,escopoCotacaoPublica:async()=>({empresaId:"tenant"})},
      "lib/comercial/descontos-dia-publico":{descontosPublicosDaEmpresa:async()=>null},
      "lib/disponibilidade/services":{duracaoAceita:()=>null,consultarDisponibilidadePeriodo:async()=>dias,isAvailabilityServiceError:()=>false},
    },new Map()) as { GET: (req: { url: string; nextUrl: URL }) => Promise<{ data: DisponibilidadeDataPublica[] }> };
    const url=new URL("http://localhost/api/disponibilidade?inicio=2026-11-01&fim=2026-12-31");
    await GET({url:url.href,nextUrl:url});
    assert.equal(consultas,0);
    url.searchParams.set("convidados","30");
    const r=await GET({url:url.href,nextUrl:url});
    assert.equal(consultas,1);
    assert.equal(estadoDoDia(r.data[0]),"SEM_PACOTE");
    assert.equal(r.data[0].periodos[0].horarios[0].status,"INDISPONIVEL");
    assert.equal(estadoDoDia(r.data[1]),"DISPONIVEL");
  });
}

test("sem regras a venda explica o motivo; um horário fisicamente ocupado continua bloqueado", () => {
  const dia = { data: sabado, periodos: [{ configuracaoId: noite, codigo: "TURNO_2", nome: "Noite", horarioInicioPadrao: "17:00", horarioFimPadrao: "21:00", status: "DISPONIVEL" as const, horarios: [{ inicio: "17:00", fim: "21:00", ajusteMinutos: 0, status: "DISPONIVEL" as const }] }] };
  const fechado = aplicarOferta(dia,[{...oferta,disponibilidade:[]}],false,30);
  assert.match(fechado.periodos[0].motivoComercial!,/venda online configurada/);
  const ocupado = { ...dia, periodos: [{ ...dia.periodos[0], status:"INDISPONIVEL" as const, capacidade:{opcoes:0,motivo:"CAPACIDADE" as const}, horarios:[] }], motivoDia:{opcoes:0,motivo:"CAPACIDADE" as const} };
  assert.equal(estadoDoDia(aplicarOferta(ocupado,[oferta],false,30)), "SEM_SALAO");
});

test("cada horário exige preço aplicável e interseção com um salão livre que comporta N", () => {
  const h = {inicio:"17:00",fim:"21:00",ajusteMinutos:0,status:"DISPONIVEL" as const};
  const outro = {...h,inicio:"17:30",fim:"21:30",ajusteMinutos:30};
  const dia = {data:sabado,periodos:[{configuracaoId:noite,codigo:"TURNO_2",nome:"Noite",horarioInicioPadrao:"17:00",horarioFimPadrao:"21:00",status:"DISPONIVEL" as const,horarios:[h,outro]}]};
  const pacote = {...oferta,saloesPermitidos:["A"],precosAplicaveis:new Set([sabado + "/" + noite])};
  const livres = new Map([[h,["B"]],[outro,["A"]]]);
  const [periodo] = aplicarOferta(dia,[pacote],false,15,livres).periodos;
  assert.equal(periodo.status,"DISPONIVEL");
  assert.match(periodo.avisoMinimoFaturavel ?? "", /15 convidados.*20 convidados/);
  assert.deepEqual(periodo.horarios.map(h => h.pacotesVendaveis), [[],["POCKET"]]);
  assert.equal(aplicarOferta(dia,[{...pacote,precosAplicaveis:new Set()}],false,30,livres).periodos[0].status,"INDISPONIVEL");
  assert.equal(aplicarOferta(dia,[{...pacote,saloesPermitidos:["C"]}],false,30,livres).periodos[0].status,"INDISPONIVEL");
});
