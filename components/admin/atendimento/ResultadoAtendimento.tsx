'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import type { ResultadoAtendimento as DadosResultado } from '@/lib/whatsapp/atendimento/resultado';
import styles from './atendimento.module.css';

const numeros = new Intl.NumberFormat('pt-BR');
const meses = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const dias = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short' });
const falha = 'Não foi possível carregar o resultado do atendimento.';

/**
 * 3b (D-LAN-3, r2): mensagens do número pela Cloud API neste mês (estimativa do iA.Fest, 135). Duas coisas separadas
 * (Astra r1, P1): a franquia da Meta (fixa, 1.000 respostas sem tarifa) e o limite do Wall-e (configurável).
 */
export function textoTeto({ usadas, franquiaMeta, limite, aviso, estado, acimaDaFranquia }: NonNullable<DadosResultado['teto']>) {
  const n = (v: number) => numeros.format(v);
  // Astra r2/r3 (P2): é contagem de RESERVAS (inclui saídas que depois falharam ou foram canceladas, e a virada do mês
  // pode deslocar uma saída); nunca afirma que houve ou haverá cobrança (Astra r4, P2): os dois ramos dizem para onde ela vai
  // "se houver" e mandam conferir a contagem oficial na Meta.
  const uso = `Cerca de ${n(usadas)} mensagens do número neste mês (equipe e Wall-e), em reservas estimadas pelo iA.Fest; inclui envios que falharam ou foram cancelados.`;
  const walle = estado === 'ATINGIDO' ? `O Wall-e parou ao chegar a ${n(limite)} e volta no mês que vem; as conversas novas vão para a equipe.`
    : estado === 'AVISO' ? `Atingiu ${n(aviso)}: ao chegar a ${n(limite)}, o Wall-e para de responder até o mês que vem.`
    : `O Wall-e para de responder ao chegar a ${n(limite)} no mês.`;
  const conferir = 'Se houver cobrança, ela vai para o cartão da conta do WhatsApp do buffet. Confira na Meta a contagem oficial e se houve cobrança.';
  const meta = acimaDaFranquia
    ? `A estimativa passou das ${n(franquiaMeta)} respostas do mês que a Meta não cobra. ${conferir}`
    : `A Meta não cobra as primeiras ${n(franquiaMeta)} respostas do mês por número. ${conferir}`;
  return `${uso} ${walle} ${meta}`;
}

/** Custo em micros com 2 a 4 casas (arredondado). Acima de zero e abaixo de 0,0001 mostra "< 0,0001" para não parecer zero. */
function formatarCusto(moeda: string, micros: string) {
  const valor = BigInt(micros);
  if (valor > 0n && valor < 100n) return `${moeda} < 0,0001`;
  const decimilesimos = (valor + 50n) / 100n;
  const inteiro = numeros.format(decimilesimos / 10000n);
  const fracao = (decimilesimos % 10000n).toString().padStart(4, '0').replace(/0{1,2}$/, '');
  return `${moeda} ${inteiro},${fracao}`;
}

export default function ResultadoAtendimento() {
  const [dados, setDados] = useState<DadosResultado | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    const controle = new AbortController();
    async function carregar() {
      try {
        const resposta = await adminFetch('/api/admin/atendimento/resultado', { signal: controle.signal });
        const json = await resposta.json();
        if (controle.signal.aborted) return;
        if (!resposta.ok || !json.ok) setErro(json.erro || falha);
        else setDados(json.data);
      } catch {
        if (!controle.signal.aborted) setErro(falha);
      }
    }
    void carregar();
    return () => controle.abort();
  }, []);

  return <main className={styles.pagina}>
    <header className={`${styles.topo} ${styles.topoResultado}`}>
      <div>
        <h1>Resultado</h1>
        <p>Medidas internas de uso do atendimento. A fatura da Meta é separada.</p>
      </div>
      <div className={styles.acoes}><Link href="/admin/atendimento">Voltar ao atendimento</Link></div>
    </header>
    {erro && <p className={styles.erro} role="alert">{erro}</p>}
    {!dados && !erro && <p role="status">Carregando resultado…</p>}
    {dados && <>
      <p className={styles.aviso}>
        {dados.primeiraMensagemEm
          ? <>Mensagem mais antiga ainda guardada em <time dateTime={dados.primeiraMensagemEm}>{dias.format(new Date(dados.primeiraMensagemEm))}</time>. Números de mensagens anteriores a essa data não aparecem. A retenção e a exclusão apagam mensagens.</>
          : 'Nenhuma mensagem guardada neste ambiente para a empresa ativa. A retenção e a exclusão apagam mensagens.'}
      </p>
      {dados.teto && (() => { const calmo = dados.teto.estado === 'NORMAL' && !dados.teto.acimaDaFranquia;
        return <p className={calmo ? styles.aviso : styles.erro} role={calmo ? undefined : 'alert'} data-teto={dados.teto.estado}>{textoTeto(dados.teto)}</p>; })()}
      <div className={styles.mesesResultado}>
        {dados.meses.map(({ mes, sessoes, entradas, saidas, ia }) => <section className={styles.painel} key={mes} aria-labelledby={`resultado-${mes}`}>
          <h2 id={`resultado-${mes}`}><time dateTime={mes}>{meses.format(new Date(`${mes}-01T00:00:00Z`))}</time></h2>
          {entradas === 0 && saidas.every(saida => saida.equipe === 0 && saida.automatica === 0) && <p>Nenhuma mensagem guardada neste mês.</p>}
          <dl className={styles.totaisResultado}>
            <div><dt>{'Sessões de atendimento de 24 h'}</dt><dd>{numeros.format(sessoes)}</dd></div>
            <div><dt>Mensagens de entrada</dt><dd>{numeros.format(entradas)}</dd></div>
          </dl>
          <table className={styles.saidasResultado}>
            <caption>Mensagens de saída</caption>
            <thead><tr><th scope="col">Estado</th><th scope="col">Equipe</th><th scope="col">Wall-e / automática</th></tr></thead>
            <tbody>{saidas.map(({ estado, equipe, automatica }) => <tr key={estado} data-confirmada={estado === 'ENTREGUE'}>
              <th scope="row">{estado}{estado === 'ENTREGUE' && <small>Entrega confirmada</small>}</th>
              <td>{numeros.format(equipe)}</td><td>{numeros.format(automatica)}</td>
            </tr>)}</tbody>
          </table>
          <h3>Custo estimado de IA</h3>
          <p>{numeros.format(ia.chamadas)} {ia.chamadas === 1 ? 'chamada' : 'chamadas'} · {numeros.format(ia.semPreco)} com preço ausente</p>
          {ia.custos.length > 0
            ? <ul>{ia.custos.map(({ moeda, custoEstimadoMicros }) => <li key={moeda}>{formatarCusto(moeda, custoEstimadoMicros)}</li>)}</ul>
            : <p>{ia.chamadas === 0 ? 'Nenhuma chamada de IA registrada neste mês.' : 'Nenhuma chamada com preço conhecido neste mês.'}</p>}
        </section>)}
      </div>
    </>}
  </main>;
}
