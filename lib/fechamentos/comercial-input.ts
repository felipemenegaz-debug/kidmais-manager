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
  rolha: "BEBIDA_ALCOOLICA",
};

export function moedaParaNumeroServidor(valor: string): number | null {
  const normalizado = valor.trim().replace(/\s/g, "").replace(/^R\$/i, "");
  if (!normalizado) return null;

  if (normalizado.includes(",") && !/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(normalizado)) return null;
  const decimal = normalizado.includes(",") ? normalizado.replace(/\./g, "").replace(",", ".") : normalizado;
  try { return centavosComerciais(decimal) / 100; } catch { return null; }
}

export function traduzirAdicionais(ids: string[]) {
  const codigos: string[] = [];
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
  }

  return { ok: true as const, codigos };
}
