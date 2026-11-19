/* eslint-disable @typescript-eslint/no-require-imports */
// Prova local sem banco: iniciar Next em 127.0.0.1:3186 com as fontes simuladas do projeto.
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require(process.env.KIDMAIS_PLAYWRIGHT_MODULE || "playwright");
const { aplicarOferta } = require("../lib/comercial/oferta-intervalo.ts");
const base = "http://127.0.0.1:3186";
const id = "11111111-1111-4111-8111-111111111111";
const disponivel = { dia: 4, horario:"noite", configuracaoId:id, estado:"DISPONIVEL", vigenciaInicio:"2026-01-01", vigenciaFim:null };
const ofertas = [
  {codigo:"POCKET",nome:"Pocket",convidadosMinimos:20,convidadosMaximos:50,disponibilidade:[disponivel]},
  {codigo:"PIZZA_PARTY",nome:"Pizza Party",convidadosMinimos:1,convidadosMaximos:50,disponibilidade:[]}
];
const dias = ["2026-11-28","2026-12-03"].map(data=>({data,periodos:[{configuracaoId:id,codigo:"TURNO_2",nome:"Noite",horarioInicioPadrao:"17:00",horarioFimPadrao:"21:00",status:"DISPONIVEL",horarios:[{inicio:"17:00",fim:"21:00",ajusteMinutos:0,status:"DISPONIVEL"}]}]}));
// Mesmo sábado com o almoço vendável: a noite continua explicável e tem saída própria.
const almoco = { ...dias[0].periodos[0], configuracaoId: "22222222-2222-4222-8222-222222222222", codigo: "TURNO_1", nome: "Almoço" };
async function verificarMinimo(page, endereco, modo = "kidmais") {
  await page.goto(base + endereco + "?convidados=15");
  await page.getByRole("button", {name:/28.*Sem pacote/}).click();
  await page.getByRole("status").getByRole("button",{name:/dezembro/i}).click();
  await page.getByText("Para 15 convidados, a cobrança começa em 20 convidados.").waitFor();
  const periodo = page.getByRole("button",{name:/Noite.*Para 15 convidados/});
  assert.ok(await periodo.isEnabled());
  if (process.env.KIDMAIS_EVIDENCIA_DIR) await periodo.screenshot({path:path.join(process.env.KIDMAIS_EVIDENCIA_DIR, "minimo-15-"+modo+"-"+page.viewportSize().width+".png")});
  await periodo.click();
  await page.getByRole("button",{name:/Horário padrão Escolher/}).click();
  await page.getByRole("button",{name:/Continuar para escolher/}).click();
  const pacote = page.getByRole("button",{name:/Pocket/i}).first();
  await pacote.click();
  await page.getByText("20 pagantes", {exact:true}).first().waitFor();
}
async function main(){
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
  try {
    for(const width of [1280,390]){
      const page=await browser.newPage({viewport:{width,height:900},reducedMotion:"reduce"});
      await page.clock.setFixedTime(new Date("2026-11-19T14:00:00Z"));
      let diaParcial = false;
      await page.route("**/api/**",async route=>{
        const u=new URL(route.request().url());
        if(u.pathname==="/api/disponibilidade"){
          const data=u.searchParams.get("data");
          const filtrados=dias.map(d=>aplicarOferta(d,ofertas,true,Number(u.searchParams.get("convidados"))));
          if (diaParcial) filtrados[0].periodos.unshift(almoco);
          return route.fulfill({json:{ok:true,data:data?filtrados.find(d=>d.data===data):filtrados,comercial:{}}});
        }
        if(u.pathname==="/api/fechamentos/pacotes") return route.fulfill({json:{pacotes:ofertas,pagamento:null}});
        return route.fulfill({status:404,json:{}});
      });
      await page.goto(base+"/disponibilidade?convidados=30",{timeout:120000});
      await page.getByRole("button",{name:/28.*Sem pacote/}).click();
      const msg=page.getByRole("status").filter({hasText:/Para 30 convidados, temos disponibilidade.*dezembro.*Noite/});
      await msg.waitFor();
      if(process.env.KIDMAIS_EVIDENCIA_DIR) await page.screenshot({path:path.join(process.env.KIDMAIS_EVIDENCIA_DIR,"fase1-calendario-"+width+".png")});
      const link=new URL(await msg.getByRole("link").getAttribute("href"));
      assert.match(link.searchParams.get("text"),/28.*30 convidados/);
      await msg.getByRole("button",{name:/dezembro/i}).click();
      await page.getByRole("button",{name:/Noite.*Disponível/}).click();
      await page.getByRole("button",{name:/Horário padrão Escolher/}).click();
      await page.getByRole("button",{name:/Continuar para escolher/}).click();
      await page.getByRole("button",{name:"Ver outros pacotes"}).click();
      await page.getByRole("button",{name:/Pizza Party.*Sob consulta/i}).click();
      const campo=page.getByRole("spinbutton",{name:/Convidados para consultar/});
      assert.equal(await campo.getAttribute("min"),"1");
      assert.equal(await campo.getAttribute("max"),"50");
      await page.getByText("Pizza Party: mínimo de 1 e máximo de 50 convidados.").waitFor();
      await campo.fill("75");
      await page.getByRole("alert").filter({hasText:/1 a 50/}).waitFor();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      if(process.env.KIDMAIS_EVIDENCIA_DIR) await page.screenshot({path:path.join(process.env.KIDMAIS_EVIDENCIA_DIR,"fase1-pizza-"+width+".png")});
      await page.getByRole("link",{name:/Alterar data ou horário/}).first().click();
      await page.getByText("30 convidados pagantes",{exact:true}).waitFor();
      await verificarMinimo(page, "/disponibilidade");
      diaParcial = true;
      await page.goto(base+"/disponibilidade?convidados=30");
      await page.getByRole("button",{name:/28.*[Pp]arcial/}).click();
      await page.getByRole("status").filter({hasText:/Sem pacote para 30 convidados em Noite/}).waitFor();
      assert.ok(await page.getByRole("button",{name:/Almoço.*Disponível/}).isEnabled());
      console.log(width+"px: sábado sem oferta, saída por WhatsApp e data seguinte, cartão, faixa, rejeição e retorno OK");
      if (process.env.KIDMAIS_PROVA_EMPRESA === "1") {
        for (const comSalao of [false, true]) {
          await page.route("**/api/disponibilidade?**", async route => {
            const url = new URL(route.request().url());
            assert.equal(url.searchParams.get("empresa"), "buffet-teste");
            const filtrados = dias.map(d => aplicarOferta(d, ofertas, false, Number(url.searchParams.get("convidados"))));
            if (comSalao) filtrados[1].periodos[0] = { ...filtrados[1].periodos[0], capacidade: { opcoes: 1, motivo: null } };
            const data = url.searchParams.get("data");
            await route.fulfill({ json: { ok: true, data: data ? filtrados.find(d => d.data === data) : filtrados, comercial: {} } });
          });
          await page.goto(base+"/b/buffet-teste/disponibilidade?convidados=30");
          await page.getByRole("button",{name:/28.*Sem pacote/}).click();
          await page.getByRole("status").getByRole("button",{name:/dezembro/i}).click();
          await page.getByRole("button",{name:comSalao ? /Noite.*1 opção de salão/ : /Noite.*Disponível/}).click();
          await verificarMinimo(page, "/b/buffet-teste/disponibilidade", comSalao ? "com-salao" : "sem-salao");
          console.log(width+"px: endereço do buffet, sábado bloqueado e alternativa vendável (com salão="+comSalao+")");
        }
      }
      await page.close();
    }
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
