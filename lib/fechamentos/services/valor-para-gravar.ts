import { FechamentoServiceError } from "./errors.ts";
import { centavosComerciais } from "../../comercial/condicao-pagamento.ts";
import type { OrigemFechamento } from "../repositories";

export function valorParaGravar(origem: OrigemFechamento, tabela: number, proposto?: number, exibidoCentavos?: number) {
  if (origem !== "CLIENTE") {
    if (proposto === undefined || !Number.isFinite(proposto) || proposto <= 0) {
      throw new FechamentoServiceError("VALOR_PROPOSTO_INVALIDO", "Valor proposto inválido.");
    }
    return centavosComerciais(proposto) / 100;
  }
  const totalCentavos = centavosComerciais(tabela);
  if (exibidoCentavos !== undefined && exibidoCentavos !== totalCentavos) {
    throw new FechamentoServiceError("PRECO_MUDOU", "O preço mudou. Confira o novo total e confirme novamente.", 409, { totalCentavos });
  }
  return tabela;
}
