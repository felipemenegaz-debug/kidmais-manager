import type { DbExecutor } from "../../db/contracts.ts";
import { cnpjValido, normalizarCnpj } from "../../cadastro/cnpj.ts";
import { perfilDoTenantOuNulo } from "../../perfil/tenant.ts";
import type { ConteudoModelo } from "./conteudo.ts";
import { sha256Texto } from "./sha256.ts";

/**
 * Contratada efetiva (plano modelo de contrato v3, 1.2): o bloco "CONTRATADA" que será publicado. Uma composição só,
 * no servidor, usada pelo GET do rascunho, pela prévia e pela publicação. Só para quem tem Gestão comprovada (quem
 * chama confere). Lê SÓ o cadastro APLICADO de perfil_empresas (razão social, CNPJ, sede_* e versao): nunca o
 * rascunho do perfil nem o endereço de unidade/salão.
 *   PERFIL            → perfil completo: nome, documento e endereço do perfil; representante do modelo.
 *   MODELO_INCOMPLETO → perfil existe mas falta algo: o bloco INTEIRO do modelo (D4, sem misturar); faltando[] diz o quê.
 *   MODELO_SEM_PERFIL → empresa sem perfil: o bloco do modelo.
 *   ERRO              → perfil ambíguo, estrutura ausente ou falha de leitura: sem fallback; a publicação recusa.
 */
export type OrigemContratada = "PERFIL" | "MODELO_INCOMPLETO" | "MODELO_SEM_PERFIL";
export type ValoresContratada = ConteudoModelo["contratada"];
export type ContratadaEfetiva =
  | { estado: OrigemContratada; origem: OrigemContratada; perfilVersao: number | null; valores: ValoresContratada; faltando: string[]; sha256: string }
  | { estado: "ERRO"; origem: null; perfilVersao: null; valores: null; faltando: []; sha256: null; erro: string };
export type ContratadaConferida = { origem: OrigemContratada; perfilVersao: number | null; sha256: string };

export type PerfilSede = {
  versao: number;
  razao_social: string | null;
  cnpj: string | null;
  sede_cep: string | null;
  sede_logradouro: string | null;
  sede_numero: string | null;
  sede_sem_numero: boolean | null;
  sede_complemento: string | null;
  sede_bairro: string | null;
  sede_cidade: string | null;
  sede_uf: string | null;
};

const t = (v: string | null | undefined) => (v ?? "").trim();

export function formatarCnpjContratada(cnpj: string) {
  const n = normalizarCnpj(cnpj);
  return n.length === 14 ? `${n.slice(0, 2)}.${n.slice(2, 5)}.${n.slice(5, 8)}/${n.slice(8, 12)}-${n.slice(12)}` : t(cnpj);
}

/** "logradouro, número|s/n[, complemento], bairro, cidade/UF, CEP 00000-000" (sem truncar). */
export function formatarEnderecoSede(p: PerfilSede) {
  const cep = t(p.sede_cep).replace(/\D/g, "");
  const numero = p.sede_sem_numero ? "s/n" : t(p.sede_numero);
  const complemento = t(p.sede_complemento) ? `, ${t(p.sede_complemento)}` : "";
  return `${t(p.sede_logradouro)}, ${numero}${complemento}, ${t(p.sede_bairro)}, ${t(p.sede_cidade)}/${t(p.sede_uf).toUpperCase()}, CEP ${cep.slice(0, 5)}-${cep.slice(5)}`;
}

/** O que falta no perfil APLICADO para a contratada vir dele (avaliado só pela sede). */
export function faltandoNoPerfil(p: PerfilSede) {
  const faltando: string[] = [];
  if (!t(p.razao_social)) faltando.push("razão social");
  if (!cnpjValido(p.cnpj)) faltando.push("CNPJ");
  if (!t(p.sede_logradouro)) faltando.push("logradouro da sede");
  if (!p.sede_sem_numero && !t(p.sede_numero)) faltando.push("número da sede");
  if (!t(p.sede_bairro)) faltando.push("bairro da sede");
  if (!t(p.sede_cidade)) faltando.push("cidade da sede");
  if (!/^[A-Za-z]{2}$/.test(t(p.sede_uf))) faltando.push("UF da sede");
  if (!/^\d{8}$/.test(t(p.sede_cep).replace(/\D/g, ""))) faltando.push("CEP da sede");
  return faltando;
}

/**
 * Impressão da contratada que a publicação confere. O que vem do modelo (representante e, sem perfil completo, o bloco
 * todo) já está coberto pela versão do rascunho; aqui entra só o que pode mudar FORA dele: a origem, a versão e os
 * valores do perfil.
 */
function impressao(origem: OrigemContratada, perfilVersao: number | null, valores: ValoresContratada | null, faltando: string[]) {
  const doPerfil = origem === "PERFIL" && valores ? { nome: valores.nome, documento: valores.documento, endereco: valores.endereco } : null;
  return sha256Texto(JSON.stringify({ origem, perfilVersao, doPerfil, faltando }));
}

/** Composição pura (testável sem banco). perfil = null → empresa sem perfil. */
export function comporContratada(perfil: PerfilSede | null, conteudo: Pick<ConteudoModelo, "contratada">): ContratadaEfetiva {
  const modelo = { ...conteudo.contratada };
  if (!perfil) return { estado: "MODELO_SEM_PERFIL", origem: "MODELO_SEM_PERFIL", perfilVersao: null, valores: modelo, faltando: [], sha256: impressao("MODELO_SEM_PERFIL", null, null, []) };
  const versao = Number(perfil.versao);
  const faltando = faltandoNoPerfil(perfil);
  if (faltando.length) return { estado: "MODELO_INCOMPLETO", origem: "MODELO_INCOMPLETO", perfilVersao: versao, valores: modelo, faltando, sha256: impressao("MODELO_INCOMPLETO", versao, null, faltando) };
  const valores = { nome: t(perfil.razao_social), documento: formatarCnpjContratada(perfil.cnpj!), endereco: formatarEnderecoSede(perfil), representante: conteudo.contratada.representante };
  return { estado: "PERFIL", origem: "PERFIL", perfilVersao: versao, valores, faltando: [], sha256: impressao("PERFIL", versao, valores, []) };
}

export function erroContratada(erro: string): ContratadaEfetiva {
  return { estado: "ERRO", origem: null, perfilVersao: null, valores: null, faltando: [], sha256: null, erro };
}

/** Lê o perfil aplicado da empresa comprovada e compõe. Falha vira ERRO (savepoint: a transação de quem chama segue). */
export async function contratadaEfetiva(tx: DbExecutor, empresaComprovada: string, conteudo: Pick<ConteudoModelo, "contratada">): Promise<ContratadaEfetiva> {
  await tx.query("SAVEPOINT modelo_contrato_contratada");
  try {
    const perfilId = await perfilDoTenantOuNulo(tx, empresaComprovada);
    let perfil: PerfilSede | null = null;
    if (perfilId) {
      const r = await tx.query<PerfilSede>(
        `SELECT versao, razao_social, cnpj, sede_cep, sede_logradouro, sede_numero, sede_sem_numero, sede_complemento, sede_bairro, sede_cidade, sede_uf
           FROM public.perfil_empresas WHERE id = $1::uuid`,
        [perfilId],
      );
      perfil = r.rows[0] ?? null;
      if (!perfil) throw new Error("perfil resolvido e não lido");
    }
    await tx.query("RELEASE SAVEPOINT modelo_contrato_contratada");
    return comporContratada(perfil, conteudo);
  } catch {
    await tx.query("ROLLBACK TO SAVEPOINT modelo_contrato_contratada");
    return erroContratada("Não foi possível ler os dados da empresa no perfil. Tente de novo ou fale com o suporte.");
  }
}

/** Conteúdo a publicar: a contratada efetiva no lugar do bloco do modelo, com a origem congelada. */
export function aplicarContratada(conteudo: ConteudoModelo, efetiva: ContratadaEfetiva): ConteudoModelo {
  if (efetiva.estado === "ERRO") throw new Error("contratada em erro não é publicada");
  return { ...conteudo, contratada: { ...efetiva.valores }, contratadaOrigem: { origem: efetiva.origem, perfilVersao: efetiva.perfilVersao } };
}

export function conferidaDe(efetiva: ContratadaEfetiva): ContratadaConferida | null {
  return efetiva.estado === "ERRO" ? null : { origem: efetiva.origem, perfilVersao: efetiva.perfilVersao, sha256: efetiva.sha256 };
}
