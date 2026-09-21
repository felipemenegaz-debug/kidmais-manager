// Registro oficial aprovado pela Kidmais. Somente o servidor escolhe o perfil
// a partir do código do pacote congelado no snapshot da contratação.
export const MODELOS_OFICIAIS = Object.freeze({
  POCKET: Object.freeze({ modeloCodigo: 'KIDMAIS_POCKET_V2', pacoteNome: 'Kidmais Pocket', excedenteCentavos: 19000, templateVersao: 2 as const }),
  MINI_FESTA: Object.freeze({ modeloCodigo: 'MINI_FESTA_KIDMAIS_V2', pacoteNome: 'Mini Festa Kidmais', excedenteCentavos: 17000, templateVersao: 2 as const }),
  COMPACTA: Object.freeze({ modeloCodigo: 'FESTA_COMPACTA_V2', pacoteNome: 'Festa Compacta', excedenteCentavos: null, templateVersao: 2 as const }),
  ESSENCIAL: Object.freeze({ modeloCodigo: 'FESTA_ESSENCIAL_V2', pacoteNome: 'Festa Essencial', excedenteCentavos: 11000, templateVersao: 2 as const }),
  COMPLETA: Object.freeze({ modeloCodigo: 'FESTA_COMPLETA_V2', pacoteNome: 'Festa Completa', excedenteCentavos: 13000, templateVersao: 2 as const }),
  PREMIUM: Object.freeze({ modeloCodigo: 'FESTA_PREMIUM_V2', pacoteNome: 'Festa Premium', excedenteCentavos: 15000, templateVersao: 2 as const }),
  PIZZA_PARTY: Object.freeze({ modeloCodigo: 'PIZZA_PARTY_V2', pacoteNome: 'Pizza Party', excedenteCentavos: null, templateVersao: 2 as const }),
});

export function configuracaoModeloOficial(codigo: string) {
  return Object.hasOwn(MODELOS_OFICIAIS, codigo)
    ? MODELOS_OFICIAIS[codigo as keyof typeof MODELOS_OFICIAIS]
    : null;
}
