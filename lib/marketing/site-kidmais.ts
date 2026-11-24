import type { DbExecutor } from '../db/contracts.ts';
import { recursoIncluido } from '../assinatura/recursos-plano.ts';
import { lerEstadoComercial } from '../assinatura/estado.ts';
import { registrarSeAusente } from './atribuicao.ts';
import { lerCampanha, temDestinoExterno } from './campanhas.ts';

export const SITE_KIDMAIS = 'https://kidmaisfestas.com';
export const ID_CAMPANHA = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** r2 (P3): valor fora do formato UUID = integração desligada (null), nunca comparado nem enviado ao banco. */
export function empresaDoSiteKidmais() {
  const valor = process.env.MARKETING_SITE_KIDMAIS_EMPRESA_ID?.trim().toLowerCase() ?? '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(valor) ? valor : null;
}

export async function marketingDoSiteDisponivel(tx: DbExecutor, empresa: string) {
  if (empresa !== empresaDoSiteKidmais() || !await recursoIncluido(tx, empresa, 'MARKETING')) return false;
  return (await lerEstadoComercial(tx, empresa)).acesso.nivel !== 'BLOQUEADO';
}

/**
 * r2 (P2 do Astra r1): na transação de quem chama. As mudanças de acesso comercial travam a linha da empresa FOR UPDATE
 * (gatilhos 068/074a, painel comercial) ou FOR NO KEY UPDATE (ofertas). Aqui a empresa é travada FOR SHARE, que espera as
 * duas, ANTES da decisão: a mudança em curso termina primeiro e a decisão e o INSERT veem o estado confirmado.
 * A atribuição pelo Wall-e roda sob a trava FOR KEY SHARE da captura (fatia 1a), que só espera FOR UPDATE.
 */
export async function registrarCliqueSiteKidmais(tx: DbExecutor, empresa: string, campanha: string, tipo: 'CLIQUE_LINK_CAMPANHA' | 'CLIQUE_WHATSAPP') {
  if (empresa !== empresaDoSiteKidmais()) return;
  await tx.query('SELECT id FROM empresas WHERE id=$1 FOR SHARE', [empresa]);
  // 136: sem a coluna nenhuma campanha é externa e nada grava; com ela, só campanha marcada como externa.
  if (!await temDestinoExterno(tx) || !await marketingDoSiteDisponivel(tx, empresa)) return;
  await tx.query(`INSERT INTO marketing_eventos (empresa_id, campanha_id, tipo)
    SELECT c.empresa_id, c.id, $3 FROM marketing_campanhas c
    JOIN empresas e ON e.id=c.empresa_id AND e.status='ATIVA'
    WHERE c.empresa_id=$1 AND c.id=$2 AND c.status <> 'ARQUIVADA' AND c.destino_externo`, [empresa, campanha, tipo]);
}

/** A referência no texto recebido é editável. A origem e o nome vêm do cadastro da empresa. */
export async function atribuirContatoDoSite(tx: DbExecutor, empresa: string, contatoId: string, campanhaId: string) {
  if (!ID_CAMPANHA.test(campanhaId) || !await marketingDoSiteDisponivel(tx, empresa)) return;
  const campanha = await lerCampanha(tx, empresa, campanhaId);
  // 136: o UUID de uma campanha interna (site do iA.Fest ou sem destino externo) no texto não atribui nada.
  if (!campanha || campanha.status === 'ARQUIVADA' || !campanha.destinoExterno) return;
  await registrarSeAusente(tx, empresa, {
    alvoTipo: 'CONTATO', alvoId: contatoId, contatoId, campanhaId: campanha.id,
    origemCodigo: campanha.origemCodigo, canalAtendimento: 'WHATSAPP', metodo: 'INFORMADO',
  });
}
