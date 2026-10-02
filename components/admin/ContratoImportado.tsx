'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { ContratoImportadoDetalhe } from '@/lib/contratos/importados';
import { MENSAGEM_SEM_ACESSO } from './contrato-url';
import styles from './contratos-ux.module.css';

/**
 * Detalhe do contrato importado (etapa 1, somente leitura): snapshot como está no documento, cliente, original protegido
 * e pagamentos previstos. Nenhuma Festa, reserva, cobrança ou pagamento é criado a partir desta tela.
 */
const reais = (centavos: number | null | undefined) => (centavos == null ? 'Não informado' : (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const dataBr = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : 'Não informada');
const instante = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'Não informado');
const duracao = (min: number | null) => (min == null ? 'Não informada' : min % 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min / 60} ${min === 60 ? 'hora' : 'horas'}`);
const tamanho = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`);
const ou = (v: string | number | null | undefined, vazio = 'Não consta no documento') => (v === null || v === undefined || v === '' ? vazio : String(v));

export const TEXTO_EVENTO_FUTURO = 'Evento importado — ainda não integrado à agenda';

export default function ContratoImportado({ importacaoId }: { importacaoId: string }) {
  const [dados, setDados] = useState<ContratoImportadoDetalhe | null>(null);
  const [erro, setErro] = useState('');
  // Montado com `key={importacaoId}` pelo pai: trocar de contrato recria o estado, sem setState síncrono no efeito.
  useEffect(() => {
    let ativo = true;
    adminFetch(`/api/admin/contratos/painel?importacaoId=${encodeURIComponent(importacaoId)}`).then(async (r) => ({ status: r.status, corpo: await r.json() })).then(({ status, corpo }) => {
      if (!ativo) return;
      if (corpo.ok) setDados(corpo.data as ContratoImportadoDetalhe);
      else setErro(status === 404 || status === 403 ? MENSAGEM_SEM_ACESSO : corpo.erro || 'Não foi possível carregar o contrato importado.');
    }).catch(() => { if (ativo) setErro('Não foi possível carregar o contrato importado.'); });
    return () => { ativo = false; };
  }, [importacaoId]);
  if (erro) return <p role="alert">{erro}</p>;
  if (!dados) return <p role="status">Carregando contrato importado…</p>;
  const c = dados.contrato, e = c.evento, p = c.pacote, v = c.valores, pg = c.pagamentosPrevistos;
  const horario = e.horario ? `${e.horario.inicio}${e.horario.fim ? ` às ${e.horario.fim}` : ''}` : 'Não consta no documento';
  const original = `/api/admin/contratos/importados/${dados.id}/original`;
  const previstos = (pg.entrada ? 1 : 0) + pg.parcelas.length;
  return <div className={styles.contratoImportado} data-testid="contrato-importado">
    <header className={styles.overview}>
      <div className={styles.hero}>
        <div>
          <span className={styles.badge}>IMPORTADO</span>
          <h2>{dados.cliente.nome}</h2>
          <p>{dataBr(e.data)} · {ou(p.nome, 'Pacote não informado')} · {e.convidados == null ? 'convidados não informados' : `${e.convidados} convidados`}</p>
          <p className={styles.origemImportado}>Contrato histórico importado de documento em {instante(dados.importadoEm)}{dados.importadoPor ? ` por ${dados.importadoPor}` : ''}. Os dados abaixo são os do documento original; nada foi recalculado com o catálogo ou a tabela de preços atual.</p>
        </div>
        <div className={styles.total}><span>Valor contratado no documento</span><strong>{reais(v.total)}</strong></div>
      </div>
    </header>

    <section className={styles.card} aria-labelledby="importado-evento">
      <h2 id="importado-evento">Evento</h2>
      {dados.situacaoEvento === 'FUTURO' && <p className={styles.notice} data-situacao="FUTURO"><strong>{TEXTO_EVENTO_FUTURO}.</strong> Nenhuma Festa operacional, reserva de agenda, cobrança ou pagamento foi criado a partir desta importação. O evento aparece em Festas, no bloco de eventos importados a integrar, e não conta como festa confirmada.</p>}
      {dados.situacaoEvento === 'PASSADO' && <p className={styles.notice} data-situacao="PASSADO">Evento já realizado segundo o documento. Aparece no Histórico de Festas como contrato importado.</p>}
      {dados.situacaoEvento === 'SEM_DATA' && <p className={styles.notice} data-situacao="SEM_DATA">A data da festa não consta no documento importado. Sem data, o evento não aparece em Festas.</p>}
      <dl className={styles.dados}>
        <div><dt>Data</dt><dd>{dataBr(e.data)}</dd></div>
        <div><dt>Horário</dt><dd>{horario}</dd></div>
        <div><dt>Duração</dt><dd>{duracao(e.duracaoMinutos)}</dd></div>
        <div><dt>Aniversariante</dt><dd>{ou(e.aniversariante)}{e.idade != null ? ` · ${e.idade} ${e.idade === 1 ? 'ano' : 'anos'}` : ''}</dd></div>
        <div><dt>Convidados</dt><dd>{ou(e.convidados)}</dd></div>
        <div><dt>Tema</dt><dd>{ou(e.tema)}</dd></div>
      </dl>
      <div className={styles.actions}>
        {dados.situacaoEvento === 'FUTURO' && <Link href="/admin/festas?visao=proximas#importados-a-integrar">Ver eventos importados a integrar</Link>}
        {dados.situacaoEvento === 'PASSADO' && <Link href="/admin/festas">Ver Histórico de Festas</Link>}
      </div>
    </section>

    <section className={styles.card} aria-labelledby="importado-cliente">
      <h2 id="importado-cliente">Cliente</h2>
      <p>{dados.cliente.nome}</p>
      <div className={styles.actions}><Link href={`/clientes/${dados.cliente.id}`}>Abrir cliente</Link></div>
    </section>

    <section className={styles.card} aria-labelledby="importado-documento">
      <h2 id="importado-documento">Documento original</h2>
      {dados.documento
        ? <p>{dados.documento.nome} · {dados.documento.contentType === 'application/pdf' ? 'PDF' : dados.documento.contentType.replace('image/', '').toUpperCase()} · {tamanho(dados.documento.tamanhoBytes)}</p>
        : <p>O arquivo original não está disponível neste ambiente.</p>}
      {dados.documento && (dados.podeVerOriginal
        ? <div className={styles.actions}>
          <a href={original} target="_blank" rel="noreferrer">Visualizar ou imprimir</a>
          <a href={`${original}?baixar=1`}>Baixar original</a>
        </div>
        : <p className={styles.notice}>A visualização do original é restrita aos papéis Administrativo e Representante autorizado desta empresa.</p>)}
      <p className={styles.discreto}>O original é guardado de forma privada nesta empresa e nunca é reescrito.</p>
    </section>

    <section className={styles.card} aria-labelledby="importado-contrato">
      <h2 id="importado-contrato">Dados do contrato</h2>
      <p className={styles.discreto}>Pacote, itens e valores exatamente como no contrato original. Não são substituídos pelo catálogo nem recalculados pela tabela de preços atual.</p>
      <dl className={styles.dados}>
        <div><dt>Pacote original</dt><dd>{ou(p.nome)}</dd></div>
        <div><dt>Duração do pacote</dt><dd>{duracao(p.duracaoMinutos)}</dd></div>
        <div><dt>Convidados do pacote</dt><dd>{ou(p.quantidade)}</dd></div>
        <div><dt>Itens originais</dt><dd>{ou(p.itens)}</dd></div>
        <div><dt>Cardápio</dt><dd>{ou(c.buffet.itens)}</dd></div>
        <div><dt>Observações do buffet</dt><dd>{ou(c.buffet.observacoes)}</dd></div>
        <div><dt>Restrições alimentares</dt><dd>{ou(c.buffet.restricoes)}</dd></div>
        <div><dt>Valor do pacote</dt><dd>{reais(v.preco)}</dd></div>
        <div><dt>Adicionais</dt><dd>{reais(v.adicionais)}</dd></div>
        <div><dt>Valor contratado</dt><dd>{reais(v.total)}</dd></div>
        <div><dt>Observações do contrato</dt><dd>{ou(c.observacoes, 'Sem observações')}</dd></div>
      </dl>
    </section>

    <section className={styles.card} aria-labelledby="importado-pagamentos">
      <h2 id="importado-pagamentos">Pagamentos previstos</h2>
      <p className={styles.discreto}>Pagamento previsto não é pagamento recebido. Nenhum recebimento, cobrança ou plano financeiro foi criado por esta importação; recebimentos continuam sendo registrados no Financeiro.</p>
      <p>Condição de pagamento: {ou(pg.condicao)}</p>
      {previstos === 0 && <p>Nenhuma parcela prevista consta no documento.</p>}
      {previstos > 0 && <div className={styles.tableWrap}><table>
        <thead><tr><th>Parcela</th><th>Valor</th><th>Vencimento</th><th>Situação</th></tr></thead>
        <tbody>
          {pg.entrada && <tr><td>Entrada</td><td>{reais(pg.entrada.valor)}</td><td>{dataBr(pg.entrada.vencimento)}</td><td><span className={styles.seloPrevisto}>Previsto, não cobrado</span></td></tr>}
          {pg.parcelas.map((parcela) => <tr key={parcela.numero}><td>Parcela {parcela.numero}</td><td>{reais(parcela.valor)}</td><td>{dataBr(parcela.vencimento)}</td><td><span className={styles.seloPrevisto}>Previsto, não cobrado</span></td></tr>)}
        </tbody>
      </table></div>}
    </section>

    {dados.pendencias.length > 0 && <section className={styles.card} aria-labelledby="importado-pendencias">
      <h2 id="importado-pendencias">Pendências registradas na importação</h2>
      <ul>{dados.pendencias.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>}
  </div>;
}
