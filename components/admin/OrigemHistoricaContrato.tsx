'use client';
import type { OrigemHistoricaContrato as Origem } from '@/lib/contratos/importados';
import styles from './contratos-ux.module.css';

/**
 * Contrato do Core que nasceu de importação histórica: assinado em papel e conferido por operador (sem assinatura
 * digital, OTP ou comprovante). Mostra o original protegido, as correções de leitura e complementos (nunca
 * apresentados como se estivessem no documento) e a pendência de pagamentos, quando houver.
 */
const instante = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const PAPEL: Record<string, string> = { ADMINISTRATIVO: 'Administrativo', REPRESENTANTE_AUTORIZADO: 'Representante autorizado' };

export default function OrigemHistoricaContrato({ origem }: { origem: Origem }) {
  const original = `/api/admin/contratos/importados/${origem.importacaoId}/original`;
  return <section className={styles.card} aria-labelledby="origem-historica" data-testid="origem-historica">
    <h2 id="origem-historica">Contrato histórico — assinado em papel</h2>
    <p className={styles.origemImportado}>
      Integrado a partir de importação. Conferido por {origem.conferidoPor ?? 'operador'} ({PAPEL[origem.conferidoPapel] ?? origem.conferidoPapel}) em {instante(origem.conferidoEm)}.
      Não há assinatura digital, OTP nem comprovante eletrônico: a prova é o documento original.
    </p>
    {origem.unidade && <p>Unidade: {origem.unidade}</p>}
    {origem.documento && (origem.podeVerOriginal
      ? <div className={styles.actions}><a href={original} target="_blank" rel="noreferrer">Ver documento original</a><a href={`${original}?baixar=1`}>Baixar original</a></div>
      : <p className={styles.notice}>A visualização do original é restrita aos papéis Administrativo e Representante autorizado desta empresa.</p>)}
    {origem.campos.length > 0 && <>
      <h3>Diferenças em relação ao documento</h3>
      <ul>{origem.campos.map((c) => <li key={c.campo}>
        <strong>{c.rotulo}:</strong> {c.efetivo} — {c.origem === 'CORRECAO_LEITURA' ? `correção de leitura (documento: ${c.documento ?? 'não informado'})${c.motivo ? `. Motivo: ${c.motivo}` : ''}` : 'complemento operacional (não consta no documento)'}
      </li>)}</ul>
    </>}
    {origem.financeiroPendente && origem.caminhoFinanceiro === 'CONFERIR_HISTORICO'
      ? <p className={styles.notice} data-pendencia="pagamentos"><strong>Pendência: conferir pagamentos.</strong> Os pagamentos deste contrato ainda não foram conferidos. Nada entrou em Contas a receber nem no Fluxo de caixa. <a href="#financeiro">Conferir pagamentos</a></p>
      : origem.financeiroPendente && origem.caminhoFinanceiro === 'PLANO_NA_VERSAO_VIGENTE'
      ? <p className={styles.notice} data-pendencia="pagamentos"><strong>Pendência: registrar pagamentos.</strong> O contrato foi revisado depois da integração. Crie o plano na versão vigente e registre os recebimentos com a data real. <a href="#financeiro">Abrir Financeiro</a></p>
      : origem.financeiroPendente
      ? <p className={styles.notice} data-pendencia="pagamentos"><strong>Pendência: registrar pagamentos.</strong> Conclua ou cancele a revisão em andamento antes de registrar os pagamentos.</p>
      : origem.financeiro && <p className={styles.discreto}>Pagamentos conferidos na integração: {reais(origem.financeiro.recebidoCentavos)} recebidos e {reais(origem.financeiro.saldoCentavos)} a receber na época.</p>}
    <p className={styles.discreto}>Mudanças na festa ou nas condições contratadas seguem as revisões do contrato (nova versão, com motivo e assinatura do cliente). O registro histórico não é sobrescrito.</p>
  </section>;
}
