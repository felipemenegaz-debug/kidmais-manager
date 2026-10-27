import type { ContratoOficialRenderizado } from "../documento/oficial/models.ts";
import { salaoDoSnapshot, type ContratoSnapshot } from "../repositories/models.ts";
import { camposUsados, preencher } from "./campos.ts";
import { textosDoConteudo, type ConteudoModelo } from "./conteudo.ts";

/**
 * Contrato no padrão da empresa: o texto aprovado do modelo com os {{campos}} preenchidos pelo snapshot congelado
 * da versão. Mesma forma do Contrato Oficial (mesmo gerador de PDF, mesmo hash do snapshot nas linhas de
 * integridade). Determinístico: mesmo modelo + mesmo snapshot = mesmo documento.
 */
export function renderizarModeloEmpresa(
  modelo: { id: string; versao: number; conteudo: ConteudoModelo },
  input: { snapshot: ContratoSnapshot; numeroVersao: number; snapshotHash: string; geradoEm?: string | null },
): ContratoOficialRenderizado {
  const s = input.snapshot;
  const c = modelo.conteudo;
  const dataContrato = (input.geradoEm ?? new Date().toISOString()).slice(0, 10);
  const p = (texto: string) => preencher(texto, s, { dataContrato });
  const contratada = [
    `CONTRATADA: ${c.contratada.nome}${c.contratada.documento ? `, inscrita sob o nº ${c.contratada.documento}` : ""}${c.contratada.endereco ? `, com sede em ${c.contratada.endereco}` : ""}.`,
    ...(c.contratada.representante ? [`Representada por ${c.contratada.representante}.`] : []),
  ];
  const contratante = [p("CONTRATANTE: {{contratante.nome}}, CPF {{contratante.cpf}}, RG {{contratante.rg}}, telefone {{contratante.telefone}}, e-mail {{contratante.email}}, endereço {{contratante.endereco}}.")];
  if (s.responsavelAdicional) contratante.push(`Responsável adicional: ${s.responsavelAdicional.nome}.`);
  contratante.push(p("Aniversariante: {{aniversariante.nome}}, {{aniversariante.idade}}. Tema: {{aniversariante.tema}}."));
  // S-E (plano S-E/S-D rev. 4.1, R-E5): salão fixado (V3) e texto publicado sem {{festa.salao}} → bloco fixo do sistema
  // depois da identificação e antes das cláusulas. Com o campo no texto, nada a mais; sem salão, como antes.
  const salao = salaoDoSnapshot(s);
  if (salao && !textosDoConteudo(c).some((t) => camposUsados(t).includes("festa.salao"))) contratante.push(`Local da festa: ${salao.nome}.`);
  return {
    templateVersao: modelo.versao,
    modeloCodigo: `EMPRESA_${modelo.id.replaceAll("-", "").slice(0, 12).toUpperCase()}_V${modelo.versao}`,
    pacoteCodigo: s.evento.pacote.codigo,
    pacoteNome: s.evento.pacote.nome,
    homologadoParaProducao: true,
    titulo: p(c.titulo),
    subtitulo: `${s.evento.pacote.nome} · Versão ${input.numeroVersao}`,
    avisoHomologacao: null,
    contratada,
    contratante,
    preambulo: c.preambulo.map(p),
    clausulas: c.clausulas.map((cl, i) => ({ numero: i + 1, texto: cl.titulo ? `${p(cl.titulo)}. ${p(cl.texto)}` : p(cl.texto) })),
    observacoes: c.observacoes.map(p),
    integridade: [
      `Versão contratual: ${input.numeroVersao}.`,
      `Modelo de contrato da empresa, versão ${modelo.versao}.`,
      `Snapshot SHA-256: ${input.snapshotHash}`,
    ],
    assinatura: [
      `${c.cidadeAssinatura}, ${p("{{contrato.data}}")}.`,
      `CONTRATADA: ${c.contratada.nome}`,
      p("CONTRATANTE: {{contratante.nome}}"),
    ],
  };
}
