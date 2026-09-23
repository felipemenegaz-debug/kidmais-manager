import { centavosComerciais } from "../comercial/condicao-pagamento";

export const PACOTE_CODIGO_BANCO = {
  pocket: "POCKET",
  mini: "MINI_FESTA",
  compacta: "COMPACTA",
  essencial: "ESSENCIAL",
  completa: "COMPLETA",
  premium: "PREMIUM",
  pizza_party_scienza: "PIZZA_PARTY",
} as const;

export const FORMA_PAGAMENTO_BANCO = {
  pix_avista: "PIX_AVISTA",
  pix_parcelado: "PIX_PARCELADO",
  cartao_cielo: "CARTAO_CIELO",
} as const;

export const ADICIONAL_CODIGO_BANCO: Record<string, string> = {
  penne: "PENNE",
  "salada-premium": "SALADA_PREMIUM",
  "crepe-1": "CREPE_1_SABOR",
  "crepe-2": "CREPE_2_SABORES",
  pastelzinho: "PASTELZINHO",
  sorvete: "SORVETE",
  empratado: "EMPRATADO_PREMIUM",

  "mesa-cafe-p": "MESA_CAFE",
  "mesa-cafe-m": "MESA_CAFE",
  "mesa-cafe-g": "MESA_CAFE",

  "mesa-frios-p": "MESA_FRIOS",
  "mesa-frios-m": "MESA_FRIOS",
  "mesa-frios-g": "MESA_FRIOS",

  "mesa-frutas-p": "MESA_FRUTAS",
  "mesa-frutas-m": "MESA_FRUTAS",
  "mesa-frutas-g": "MESA_FRUTAS",

  "arco-simples": "ARCO_BALAO_SIMPLES",
  "arco-medio": "ARCO_BALAO_MEDIO",
  "arco-grande": "ARCO_BALAO_GRANDE",
  "segundo-tema": "SEGUNDO_TEMA",
  "painel-redondo": "PAINEL_REDONDO",
  "painel-retangular": "PAINEL_RETANGULAR_GRANDE",
  "chao-vidro": "CHAO_VIDRO",
  personalizados: "MONTAGEM_PERSONALIZADOS",

  "doces-extra": "DOCES_TRADICIONAIS_EXTRAS",
  bombom: "BOMBOM",
  "lembrancinha-copo": "LEMBRANCINHA_COPO",
  "lembrancinha-bola": "LEMBRANCINHA_BOLA",
  "combo-adultos": "COMBO_ADULTOS",
  "combo-lanchinhos": "COMBO_LANCHINHOS",
  "combo-mesa-bonita-simples": "COMBO_MESA_BONITA_SIMPLES",
  "combo-mesa-bonita-medio": "COMBO_MESA_BONITA_MEDIO",
  "combo-mesa-bonita-premium": "COMBO_MESA_BONITA_PREMIUM",
  "visual-premium": "VISUAL_PREMIUM",
  "visual-premium-personalizados": "VISUAL_PREMIUM_PERSONALIZADOS",
  "visual-premium-completo": "VISUAL_PREMIUM_COMPLETO",
  rolha: "BEBIDA_ALCOOLICA",
};

export function moedaParaNumeroServidor(valor: string): number | null {
  const normalizado = valor.trim().replace(/\s/g, "").replace(/^R\$/i, "");
  if (!normalizado) return null;

  if (normalizado.includes(",") && !/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(normalizado)) return null;
  const decimal = normalizado.includes(",") ? normalizado.replace(/\./g, "").replace(",", ".") : normalizado;
  try { return centavosComerciais(decimal) / 100; } catch { return null; }
}

export function traduzirAdicionais(ids: string[], quantidades: Record<string, number> = {}) {
  const codigos: string[] = [];
  const itens: { codigo: string; quantidade: number }[] = [];
  const vistos = new Set<string>();

  for (const id of ids) {
    if (id === "lembrancinha-extra") {
      return {
        ok: false as const,
        erro: "A lembrancinha extra simples precisa ser confirmada pela equipe Kidmais antes de continuar.",
        codigo: "ADICIONAL_SOB_CONSULTA",
      };
    }

    const codigo = ADICIONAL_CODIGO_BANCO[id];
    if (!codigo) {
      return {
        ok: false as const,
        erro: "Um dos adicionais selecionados não possui configuração comercial válida.",
        codigo: "ADICIONAL_NAO_MAPEADO",
      };
    }

    if (vistos.has(codigo)) {
      return {
        ok: false as const,
        erro: "Há mais de uma opção equivalente do mesmo adicional selecionada. Revise os adicionais antes de continuar.",
        codigo: "ADICIONAL_DUPLICADO",
      };
    }

    vistos.add(codigo);
    codigos.push(codigo);
    const quantidade = quantidades[id] ?? 1;
    if (!Number.isSafeInteger(quantidade) || quantidade < 1) {
      return { ok: false as const, erro: "Informe uma quantidade inteira maior que zero para cada adicional selecionado.", codigo: "QUANTIDADE_ADICIONAL_INVALIDA" };
    }
    itens.push({ codigo, quantidade });
  }

  return { ok: true as const, codigos, itens };
}
