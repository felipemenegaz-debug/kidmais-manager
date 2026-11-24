import type { DbExecutor } from '../db/contracts.ts';
import { recursoIncluido } from '../assinatura/recursos-plano.ts';
import { lerEstadoComercial } from '../assinatura/estado.ts';
import { registrarSeAusente } from './atribuicao.ts';
import { lerCampanha } from './campanhas.ts';

export const SITE_KIDMAIS = 'https://kidmaisfestas.com';
export const ID_CAMPANHA = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function empresaDoSiteKidmais() {
  return process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID?.trim().toLowerCase() || null;
}

export async function marketingDoSiteDisponivel(tx: DbExecutor, empresa: string) {
  if (empresa !== empresaDoSiteKidmais() || !await recursoIncluido(tx, empresa, 'MARKETING')) return false;
  return (await lerEstadoComercial(tx, empresa)).acesso.nivel !== 'BLOQUEADO';
}

export async function registrarCliqueSiteKidmais(tx: DbExecutor, empresa: string, campanha: string, tipo: 'CLIQUE_LINK_CAMPANHA' | 'CLIQUE_WHATSAPP') {
  if (!await marketingDoSiteDisponivel(tx, empresa)) return;
  await tx.query(`INSERT INTO marketing_eventos (empresa_id, campanha_id, tipo)
    SELECT c.empresa_id, c.id, $3 FROM marketing_campanhas c
    JOIN empresas e ON e.id=c.empresa_id AND e.status='ATIVA'
    WHERE c.empresa_id=$1 AND c.id=$2 AND c.status <> 'ARQUIVADA'`, [empresa, campanha, tipo]);
}

/** A referência no texto recebido é editável. A origem e o nome vêm do cadastro da empresa. */
export async function atribuirContatoDoSite(tx: DbExecutor, empresa: string, contatoId: string, campanhaId: string) {
  if (!ID_CAMPANHA.test(campanhaId) || !await marketingDoSiteDisponivel(tx, empresa)) return;
  const campanha = await lerCampanha(tx, empresa, campanhaId);
  if (!campanha || campanha.status === 'ARQUIVADA') return;
  await registrarSeAusente(tx, empresa, {
    alvoTipo: 'CONTATO', alvoId: contatoId, contatoId, campanhaId: campanha.id,
    origemCodigo: campanha.origemCodigo, canalAtendimento: 'WHATSAPP', metodo: 'INFORMADO',
  });
}
