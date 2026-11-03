import type { DbExecutor } from '../db/contracts';
import { rotuloSalao, salaoDoSnapshot, type ContratoSnapshot } from '../contratos/repositories/models.ts';
import { estruturaPerfilInstalada } from '../perfil/estrutura.ts';
import { nomePublicoDaEmpresa } from '../perfil/nome-publico.ts';
import { perfilDoTenantOuNulo } from '../perfil/tenant.ts';
import type { BlocoLocal } from './domain.ts';

/** Aviso do painel quando o bloco mostra a unidade (D-LIB-5): versão sem salão numa empresa "por salão". */
export const AVISO_CONVITE_SEM_SALAO = 'O convite não mostra o salão até a revisão do contrato.';

type Endereco = { logradouro: string | null; numero: string | null; sem_numero: boolean | null; complemento: string | null;
  bairro: string | null; cidade: string | null; uf: string | null };
type LinhaUnidade = Endereco & { nome: string | null; mesmo_endereco_sede: boolean;
  sede_logradouro: string | null; sede_numero: string | null; sede_sem_numero: boolean | null; sede_complemento: string | null;
  sede_bairro: string | null; sede_cidade: string | null; sede_uf: string | null };

/** "Rua A, 10 - sala 2 - Centro, Cidade/UF"; sem logradouro ou cidade, o endereço não é utilizável (vazio). */
export function enderecoUtilizavel(e: Endereco) {
  const t = (v: string | null) => (v ?? '').trim();
  if (!t(e.logradouro) || !t(e.cidade)) return '';
  const numero = e.sem_numero ? 's/n' : t(e.numero);
  const rua = [t(e.logradouro), numero].filter(Boolean).join(', ');
  const cidade = [t(e.cidade), t(e.uf)].filter(Boolean).join('/');
  return [rua, t(e.complemento), [t(e.bairro), cidade].filter(Boolean).join(', ')].filter(Boolean).join(' - ').slice(0, 400);
}

/**
 * Unidade da festa lida do cadastro NO MOMENTO da publicação (P3 da D-LIB-5). A V1 tem uma unidade por perfil e nenhum
 * vínculo explícito com `estabelecimentos`: o cadastro só é usado quando a empresa tem um único estabelecimento e o perfil
 * uma única unidade; senão vale o nome do estabelecimento, sem endereço. Sem estabelecimento: nome comercial do perfil.
 */
async function blocoDaUnidade(tx: DbExecutor, empresaId: string, estabelecimentoId: string | null): Promise<BlocoLocal> {
  const estabelecimento = estabelecimentoId ? (await tx.query<{ nome: string; total: number }>(
    `SELECT e.nome, (SELECT count(*)::int FROM estabelecimentos x WHERE x.empresa_id = e.empresa_id AND x.status <> 'DESATIVADO') AS total
       FROM estabelecimentos e WHERE e.id = $1::uuid AND e.empresa_id = $2::uuid`, [estabelecimentoId, empresaId])).rows[0] : undefined;
  if (!estabelecimento) return { origem: 'UNIDADE', nome: ((await nomePublicoDaEmpresa(tx, empresaId)) ?? 'Buffet').slice(0, 400), endereco: '' };
  let unidade: LinhaUnidade | undefined;
  if (estabelecimento.total === 1 && await estruturaPerfilInstalada(tx)) {
    // Perfil ambíguo recusa em JavaScript (nenhuma consulta falha): segue sem o cadastro, nunca com o de outra empresa.
    const perfil = await perfilDoTenantOuNulo(tx, empresaId).catch(() => null);
    const unidades = perfil ? (await tx.query<LinhaUnidade>(
      `SELECT u.nome, u.mesmo_endereco_sede, u.logradouro, u.numero, u.sem_numero, u.complemento, u.bairro, u.cidade, u.uf,
              p.sede_logradouro, p.sede_numero, p.sede_sem_numero, p.sede_complemento, p.sede_bairro, p.sede_cidade, p.sede_uf
         FROM perfil_unidades u JOIN perfil_empresas p ON p.id = u.empresa_id WHERE u.empresa_id = $1::uuid ORDER BY u.id LIMIT 2`, [perfil])).rows : [];
    if (unidades.length === 1) unidade = unidades[0];
  }
  const nome = (unidade?.nome?.trim() || estabelecimento.nome.trim()).slice(0, 400);
  if (!unidade) return { origem: 'UNIDADE', nome, endereco: '' };
  const endereco = unidade.mesmo_endereco_sede
    ? enderecoUtilizavel({ logradouro: unidade.sede_logradouro, numero: unidade.sede_numero, sem_numero: unidade.sede_sem_numero,
      complemento: unidade.sede_complemento, bairro: unidade.sede_bairro, cidade: unidade.sede_cidade, uf: unidade.sede_uf })
    : enderecoUtilizavel(unidade);
  return { origem: 'UNIDADE', nome, endereco };
}

/**
 * D-LIB-3/5: bloco "Local" do convite vinculado. Só em escopo "por salão" (na empresa com um salão, null: o convite segue
 * como hoje). Salão = o da versão informada (snapshot V3), com o rótulo inteiro; versão V1/V2 ou V3 sem salão = unidade.
 * Nunca usa o salão operacional da festa nem o cadastro atual do salão.
 */
export async function blocoLocalDaFesta(tx: DbExecutor, f: { empresaId: string; estabelecimentoId: string | null; snapshot: unknown }): Promise<BlocoLocal | null> {
  const porSalao = (await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM agenda_escopo_config c WHERE c.empresa_id = $1::uuid
        AND c.estabelecimento_id IS NOT DISTINCT FROM $2::uuid AND c.capacidade_tipo = 'POR_SALAO') AS ok`,
    [f.empresaId, f.estabelecimentoId])).rows[0]?.ok === true;
  if (!porSalao) return null;
  const s = f.snapshot as ContratoSnapshot | null;
  const nome = s?.schemaVersao === 3 && s.evento ? salaoDoSnapshot(s)?.nome : undefined;
  if (typeof nome === 'string' && nome.trim()) return { origem: 'SALAO', nome: rotuloSalao(nome, true).slice(0, 400), endereco: '' };
  return blocoDaUnidade(tx, f.empresaId, f.estabelecimentoId);
}
