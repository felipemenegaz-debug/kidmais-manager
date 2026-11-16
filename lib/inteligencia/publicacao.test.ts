import assert from "node:assert/strict";
import test from "node:test";
import { estadoWhatsappIaParaPublicacao } from "./publicacao.ts";

const ORCAMENTO = JSON.stringify({ moeda: "USD", porEmpresa: { custoMensal: 30 }, porCapacidade: { whatsapp_atendimento: { tokensDiario: 200000, tokensMensal: 4000000 } } });
const BOM = { AI_PROVIDER_PRIMARY: "OPENAI", AI_BUDGET_JSON: ORCAMENTO };

test("D-OF-1: OpenAI como único provedor do atendimento e os dois tetos configurados", () => {
  assert.deepEqual(estadoWhatsappIaParaPublicacao(BOM), { provedorOpenAi: true, tetoEmpresa: true, tetoCapacidade: true });
  assert.equal(estadoWhatsappIaParaPublicacao({ ...BOM, AI_PROVIDER_ECONOMY: "OPENAI" }).provedorOpenAi, true);
});

test("D-OF-1: outro provedor possível no atendimento reprova o provedor", () => {
  assert.equal(estadoWhatsappIaParaPublicacao({ ...BOM, AI_PROVIDER_PRIMARY: undefined }).provedorOpenAi, false, "sem provedor");
  assert.equal(estadoWhatsappIaParaPublicacao({ ...BOM, AI_PROVIDER_ECONOMY: "DEEPSEEK" }).provedorOpenAi, false, "econômico DeepSeek (Wall-e e FAQ são ECONOMY)");
  assert.equal(estadoWhatsappIaParaPublicacao({ ...BOM, AI_FALLBACK_ENABLED: "true" }).provedorOpenAi, false, "fallback inclui o DeepSeek");
  assert.equal(estadoWhatsappIaParaPublicacao({ ...BOM, AI_PROVIDER_ECONOMY: "OPENAI", AI_PROVIDER_PRIMARY: "DEEPSEEK", AI_WORKLOAD_TIERS: JSON.stringify({ FAQ: "STANDARD" }) }).provedorOpenAi, false, "FAQ fora do ECONOMY vai ao primário");
});

test("D-OF-1: orçamento ausente, inválido ou sem algum dos tetos reprova o teto correspondente", () => {
  assert.deepEqual(estadoWhatsappIaParaPublicacao({ ...BOM, AI_BUDGET_JSON: undefined }), { provedorOpenAi: true, tetoEmpresa: false, tetoCapacidade: false });
  assert.deepEqual(estadoWhatsappIaParaPublicacao({ ...BOM, AI_BUDGET_JSON: "{" }), { provedorOpenAi: true, tetoEmpresa: false, tetoCapacidade: false });
  const semCapacidade = JSON.stringify({ porEmpresa: { tokensMensal: 1000 }, porCapacidade: { extrair_documento: { tokensDiario: 10 } } });
  assert.deepEqual(estadoWhatsappIaParaPublicacao({ ...BOM, AI_BUDGET_JSON: semCapacidade }), { provedorOpenAi: true, tetoEmpresa: true, tetoCapacidade: false });
  const semEmpresa = JSON.stringify({ porEmpresa: {}, porCapacidade: { whatsapp_atendimento: { custoMensal: 10 } } });
  assert.deepEqual(estadoWhatsappIaParaPublicacao({ ...BOM, AI_BUDGET_JSON: semEmpresa }), { provedorOpenAi: true, tetoEmpresa: false, tetoCapacidade: true });
  // Astra r3 (P2-3): os Termos prometem teto MENSAL; limite só diário (ou mensal zero) não conta, em nenhum dos dois escopos.
  const soDiario = JSON.stringify({ porEmpresa: { custoDiario: 1, tokensDiario: 1000 }, porCapacidade: { whatsapp_atendimento: { custoDiario: 5, tokensDiario: 200000 } } });
  assert.deepEqual(estadoWhatsappIaParaPublicacao({ ...BOM, AI_BUDGET_JSON: soDiario }), { provedorOpenAi: true, tetoEmpresa: false, tetoCapacidade: false });
  const mensalZero = JSON.stringify({ porEmpresa: { custoDiario: 1, custoMensal: 0 }, porCapacidade: { whatsapp_atendimento: { tokensDiario: 10, tokensMensal: 0 } } });
  assert.deepEqual(estadoWhatsappIaParaPublicacao({ ...BOM, AI_BUDGET_JSON: mensalZero }), { provedorOpenAi: true, tetoEmpresa: false, tetoCapacidade: false });
  const mensalSoEmpresa = JSON.stringify({ porEmpresa: { tokensMensal: 1000 }, porCapacidade: { whatsapp_atendimento: { custoDiario: 5 } } });
  assert.deepEqual(estadoWhatsappIaParaPublicacao({ ...BOM, AI_BUDGET_JSON: mensalSoEmpresa }), { provedorOpenAi: true, tetoEmpresa: true, tetoCapacidade: false });
});

test("D-OF-2: o AI_BUDGET_JSON aprovado por Felipe em 15/11 passa nos dois tetos", () => {
  const D_OF_2 = JSON.stringify({ moeda: "USD", porEmpresa: { tokensDiario: 2000000, tokensMensal: 30000000, custoDiario: 0.6, custoMensal: 6 }, porCapacidade: { whatsapp_atendimento: { custoDiario: 5, custoMensal: 60 } } });
  assert.deepEqual(estadoWhatsappIaParaPublicacao({ AI_PROVIDER_PRIMARY: "OPENAI", AI_BUDGET_JSON: D_OF_2 }), { provedorOpenAi: true, tetoEmpresa: true, tetoCapacidade: true });
});
