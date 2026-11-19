/* eslint-disable @typescript-eslint/no-require-imports */
// Prova D-FP-6 com dados sintéticos no servidor local do fluxo público.
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require(process.env.KIDMAIS_PLAYWRIGHT_MODULE || "playwright");
const { aplicarOferta } = require("../lib/comercial/oferta-intervalo.ts");
const id = "11111111-1111-4111-8111-111111111111";
const sala = "22222222-2222-4222-8222-222222222222";
const base = "http://127.0.0.1:3186";
const pacotes = [
  { codigo: "POCKET", nome: "Pocket", convidadosMinimos: 50, dia: 6, precoNoMinimo: 3210 },
  { codigo: "COMPACTA", nome: "Compacta", convidadosMinimos: 20, dia: 4, precoNoMinimo: 1700 },
].map(p => ({ ...p, convidadosMaximos: 150, precoMinimo: "999.00", saloesPermitidos: [sala],
  disponibilidade: (p.dia === 6 ? [6, 7] : [1, 2, 3, 4, 5]).map(dia =>
    ({ dia, horario: "noite", configuracaoId: id, estado: "DISPONIVEL", vigenciaInicio: "2026-01-01", vigenciaFim: null })) }));

async function provar(page, modo, n, width) {
  const empresa = modo !== "kidmais";
  const comSalao = modo === "com-salao";
  const prefixo = empresa ? "/b/buffet-teste" : "";
  let intervalos = 0;
  await page.route("**/api/**", async route => {
    const u = new URL(route.request().url());
    if (u.pathname === "/api/disponibilidade") {
      assert.equal(u.searchParams.get("empresa"), empresa ? "buffet-teste" : null);
      const data = u.searchParams.get("data");
      if (!data) intervalos++;
      const datas = data ? [data] : Array.from({ length: 42 }, (_, i) =>
        new Date(Date.UTC(2026, 10, 20 + i)).toISOString().slice(0, 10));
      const dias = datas.map(data => {
        const horario = { inicio: "17:00", fim: "21:00", ajusteMinutos: 0, status: "DISPONIVEL" };
        const periodo = { codigo: "TURNO_2", nome: "Noite", configuracaoId: id, horarioInicioPadrao: "17:00", horarioFimPadrao: "21:00",
          status: "DISPONIVEL", horarios: [horario], ...(comSalao ? { capacidade: { opcoes: 1, motivo: "OK" } } : {}) };
        return aplicarOferta({ data, periodos: [periodo] }, pacotes, !empresa, n, comSalao ? new Map([[horario, [sala]]]) : undefined);
      });
      return route.fulfill({ json: { ok: true, data: data ? dias.find(d => d.data === data) : dias, comercial: {} } });
    }
    if (u.pathname === "/api/fechamentos/pacotes") return route.fulfill({ json: {
      pacotes: pacotes.map(p => ({ ...p, precoNoMinimo: u.searchParams.get("configuracaoId") === id ? p.precoNoMinimo : undefined }))
    } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(base + prefixo + "/disponibilidade?convidados=" + n);
  const button = name => page.getByRole("button", { name });
  const sabado = button(n < 50 ? /sábado.*28.*mínimo de 50/i : /^28.*✓/);
  await sabado.waitFor();
  await button(n < 20 ? /quinta.*26.*mínimo de 20/i : /^26.*✓/).waitFor();
  if (n < 50) await page.getByText(n < 20 ? "Cobrança mínima acima de 15 convidados" : "Mínimo de 50 convidados", { exact: false }).first().waitFor();
  if (n === 30 && modo === "kidmais" && process.env.KIDMAIS_EVIDENCIA_DIR) {
    await page.locator('[class*="calendarColumn"]').screenshot({ path: path.join(process.env.KIDMAIS_EVIDENCIA_DIR, "calendario-30-" + width + ".png") });
  }
  await sabado.click();
  if (n < 50) await page.getByText("Nesta data, a cobrança começa em 50 convidados.").waitFor();
  if (n === 30) {
    const sugestoes = page.getByRole("status").filter({ hasText: "Datas próximas" });
    await sugestoes.getByRole("button", { name: /sexta.*27/i }).waitFor();
  }
  if (n === 15) await page.getByText(/Nenhuma data próxima no intervalo/).waitFor();
  assert.equal(intervalos, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await button(comSalao ? /Noite.*1 opção de salão/ : /Noite.*Disponível/).click();
  await button(/Horário padrão Escolher/).click();
  await button(/Continuar para escolher/).click();
  const card = button(/Pocket/i).first();
  await card.waitFor();
  assert.ok(await card.isEnabled());
  if (n < 50) {
    assert.match(await card.innerText(), /3\.210,00/);
    assert.match(await card.innerText(), /Preço de tabela para 50 convidados\. Descontos do dia aparecem na próxima etapa\./);
    assert.doesNotMatch(await card.getAttribute("class"), /packageFaded/);
  } else assert.doesNotMatch(await card.innerText(), /Descontos do dia aparecem na próxima etapa/);
  console.log(width, modo, n, "OK");
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  try {
    for (const width of [1280, 390]) for (const modo of ["kidmais", "sem-salao", "com-salao"]) for (const n of [15, 30, 150]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      await page.clock.setFixedTime(new Date("2026-11-19T14:00:00Z"));
      await provar(page, modo, n, width);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
