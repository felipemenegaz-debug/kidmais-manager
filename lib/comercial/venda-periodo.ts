import { regraDaEmpresa, type RegraPacoteEmpresa } from "../agenda/disponibilidade.ts";
import { pacoteComporta } from "../fechamentos/convidados-consulta.ts";
import { limitesPizzaParty } from "./pacotes-v1.ts";

export type OfertaPeriodo = {
  codigo: string;
  convidadosMinimos: number | null;
  convidadosMaximos: number | null;
  disponibilidade: RegraPacoteEmpresa[];
  precosAplicaveis?: ReadonlySet<string>;
  saloesPermitidos?: readonly string[];
};

export function motivoPacoteNoPeriodo(p: OfertaPeriodo, kidmais: boolean, n: number, data: string, periodo: string) {
  const pizza = kidmais && p.codigo === "PIZZA_PARTY";
  const faixa = pizza ? limitesPizzaParty({ minimo: p.convidadosMinimos, maximo: p.convidadosMaximos }) : null;
  const limites = faixa ? { convidadosMinimos: faixa.minimo, convidadosMaximos: faixa.maximo } : p;
  if (!pacoteComporta(pizza ? limites : { ...limites, convidadosMinimos: null }, n)) return `Este pacote não comporta ${n} convidados.`;
  if (pizza) return "Sob consulta";
  const estado = regraDaEmpresa(p.disponibilidade, data, "", periodo);
  if (estado === "consulta") return "Sob consulta";
  if (estado !== "disponivel") return "Pacote indisponível nesta data e período.";
  if (p.precosAplicaveis && !p.precosAplicaveis.has(data + "/" + periodo)) return "Sem preço publicado para esta quantidade, data e período.";
  return null;
}
