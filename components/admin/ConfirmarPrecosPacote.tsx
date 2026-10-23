'use client';

import { useState } from 'react';
import { centavosPorPontos, normalizarValorInformado, type FaixaFixa, type PontoPreco } from '@/lib/comercial/modelo-preco';
import { AdminPrimaryButton } from './AdminPrimaryButton';
import { erroDosPontos, pontosDaTela, valorDigitado, type PontoForm } from './PrecosPorQuantidade';
import styles from './precos-quantidade.module.css';
import ws from './workspace.module.css';

const reais = (centavos: number) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const centavosDe = (valor: string) => Math.round(Number(normalizarValorInformado(valor)) * 100);

function precoAntigo(faixas: FaixaFixa[], convidados: number) {
  const faixa = faixas.find((f) => f.convidadosMin <= convidados && (f.convidadosMax == null || f.convidadosMax >= convidados));
  return faixa ? centavosDe(faixa.valor) : null;
}

/**
 * Conversão das faixas antigas para quantidades cheias (decisão de Felipe em 22/10/2026): o sistema propõe, o buffet
 * revisa e só então confirma. Até confirmar, o pacote continua cobrando pelas faixas.
 */
export function ConfirmarPrecosPacote({ nome, faixas, proposta, minimo, maximo, posicao, carregando, onVoltar, onConfirmar }: {
  nome: string;
  faixas: FaixaFixa[];
  proposta: PontoPreco[];
  minimo: number;
  maximo: number;
  posicao?: string;
  carregando: boolean;
  onVoltar: () => void;
  onConfirmar: (pontos: PontoPreco[]) => void;
}) {
  const [pontos, setPontos] = useState<PontoForm[]>(() => proposta.map((p) => ({ convidados: String(p.convidados), valor: valorDigitado(p.valor) })));
  const [consulta, setConsulta] = useState(String(Math.min(maximo, minimo + 3)));
  const prontos = pontosDaTela(pontos);
  // Navegador de 22/10 (P3): pacote sem mínimo/máximo de convidados não gera proposta — explicar e bloquear.
  const semLimites = !(minimo > 0) || !(maximo >= minimo);
  const bloqueio = semLimites
    ? 'Defina os convidados mínimo e máximo deste pacote (seção 1) e salve antes de confirmar os preços.'
    : pontosDaTela(pontos).length === 0 ? 'Informe ao menos os preços do mínimo e do máximo de convidados.' : null;
  const erro = bloqueio ?? erroDosPontos(pontos, minimo, maximo);
  const ordenados = [...prontos].sort((a, b) => a.convidados - b.convidados);
  const cheias = new Set(ordenados.map((p) => p.convidados));

  const grupos: Array<{ de: number; ate: number; antes: number; menor: number; maior: number; difMenor: number; difMaior: number }> = [];
  let mudam = 0;
  let maiorAumento = 0;
  let maiorEm = 0;
  if (!erro) {
    for (const faixa of [...faixas].sort((a, b) => a.convidadosMin - b.convidadosMin)) {
      const antes = centavosDe(faixa.valor);
      let grupo: (typeof grupos)[number] | null = null;
      for (let n = Math.max(faixa.convidadosMin, minimo); n <= Math.min(faixa.convidadosMax ?? maximo, maximo); n += 1) {
        if (cheias.has(n)) continue;
        const depois = centavosPorPontos(ordenados, n)?.centavos;
        if (depois == null || depois === antes) continue;
        const dif = depois - antes;
        mudam += 1;
        if (dif > maiorAumento) { maiorAumento = dif; maiorEm = n; }
        if (!grupo) { grupo = { de: n, ate: n, antes, menor: depois, maior: depois, difMenor: dif, difMaior: dif }; grupos.push(grupo); }
        grupo.ate = n;
        grupo.menor = Math.min(grupo.menor, depois);
        grupo.maior = Math.max(grupo.maior, depois);
        grupo.difMenor = Math.min(grupo.difMenor, dif);
        grupo.difMaior = Math.max(grupo.difMaior, dif);
      }
    }
  }
  const iguais = ordenados.slice(1).filter((p, i) => {
    const anterior = ordenados[i];
    return anterior && p.convidados - anterior.convidados > 1 && centavosDe(p.valor) === centavosDe(anterior.valor);
  });
  const n = Math.round(Number(consulta));
  const antesConsulta = precoAntigo(faixas, n);
  const depoisConsulta = erro ? null : centavosPorPontos(ordenados, n);

  function alterar(indice: number, valor: string) {
    setPontos(pontos.map((p, i) => i === indice ? { ...p, valor } : p));
  }

  return <section data-confirmar-precos aria-labelledby="confirmar-precos-titulo">
    <div className={styles.acoes} style={{ marginTop: 0 }}>
      <button type="button" className={ws.textButton} onClick={onVoltar}>← Voltar aos pacotes</button>
      {posicao && <span className={`${styles.selo} ${styles.seloAviso}`} style={{ marginLeft: 'auto' }}>{posicao}</span>}
    </div>
    <h2 id="confirmar-precos-titulo" style={{ fontSize: 21, color: 'var(--main-text)', margin: '12px 0 4px' }}>Confirmar novos preços · {nome}</h2>
    <p className={ws.intro}>Agora o preço é informado só nas quantidades cheias. Para quantidades quebradas, cada convidado custa a diferença até a próxima quantidade. Até você confirmar, este pacote continua cobrando pelas faixas antigas.</p>

    <div className={styles.metricas}>
      <div className={styles.metrica}><span>Quantidades cheias</span><strong>{ordenados.length}</strong><span className={styles.fraco}>preço não muda</span></div>
      <div className={styles.metrica}><span>Ficam mais caras</span><strong className={styles.mais}>{mudam}</strong><span className={styles.fraco}>quantidades quebradas</span></div>
      <div className={styles.metrica}><span>Maior aumento</span><strong className={styles.mais}>{reais(maiorAumento)}</strong><span className={styles.fraco}>{maiorEm ? `em ${maiorEm} convidados` : ''}</span></div>
    </div>

    <div className={styles.lado}>
      <div className={ws.card}>
        <h2>Antes · faixas atuais</h2>
        <div className={styles.lista}>
          <div className={`${styles.comparacao} ${styles.cabecalho}`} style={{ gridTemplateColumns: '1fr auto' }}><span>Convidados</span><span>Preço</span></div>
          {faixas.map((f) => <div key={f.convidadosMin} className={styles.comparacao} style={{ gridTemplateColumns: '1fr auto' }}>
            <span>{f.convidadosMax == null ? `a partir de ${f.convidadosMin}` : `${f.convidadosMin} a ${f.convidadosMax}`}</span><span>{reais(centavosDe(f.valor))}</span>
          </div>)}
        </div>
        <p className={styles.fraco} style={{ marginTop: 10 }}>O preço é o mesmo dentro de cada faixa.</p>
      </div>
      <div className={ws.card}>
        <h2>Depois · quantidades cheias (pode ajustar)</h2>
        <div className={styles.lista}>
          <div className={`${styles.linha} ${styles.cabecalho}`} style={{ gridTemplateColumns: '80px minmax(0,1fr) minmax(0,1fr)' }}><span>Convidados</span><span>Preço</span><span>Cada convidado a mais</span></div>
          {pontos.map((p, i) => {
            const proximo = pontos[i + 1];
            const anterior = pontos[i - 1];
            const atual = centavosDe(p.valor);
            const menor = anterior != null && atual < centavosDe(anterior.valor);
            const passos = proximo ? Number(proximo.convidados) - Number(p.convidados) : 0;
            const por = proximo && passos > 0 ? Math.round((centavosDe(proximo.valor) - atual) / passos) : null;
            return <div key={p.convidados}>
              <div className={styles.linha} style={{ gridTemplateColumns: '80px minmax(0,1fr) minmax(0,1fr)' }}>
                <strong>{p.convidados}</strong>
                <label><span className={ws.srOnly}>Preço de {p.convidados} convidados</span><input inputMode="decimal" className={menor ? styles.invalido : undefined} aria-invalid={menor || undefined} value={p.valor} onChange={(e) => alterar(i, e.target.value)} /></label>
                <span>{por == null ? <span className={styles.fraco}>máximo</span> : por < 0 ? <span className={`${styles.selo} ${styles.seloAviso}`}>negativo</span> : <span className={styles.porConvidado}>{reais(por)}</span>}</span>
              </div>
              {menor && anterior && <p className={styles.erroLinha} role="alert">Este preço precisa ser igual ou maior que o de {anterior.convidados} convidados ({reais(centavosDe(anterior.valor))}).</p>}
            </div>;
          })}
        </div>
        {iguais.map((p) => <div key={p.convidados} className={styles.alerta} style={{ marginTop: 10 }}>
          <p><strong>Duas quantidades seguidas com o mesmo preço, a última sendo {p.convidados} convidados.</strong> Os convidados entre elas ficam sem custo a mais. Revise o preço de {p.convidados} se quiser cobrar por eles.</p>
        </div>)}
        {erro && <p className={styles.erroLinha} role="alert" style={{ padding: '10px 0 0' }}>{erro}</p>}
      </div>
    </div>

    <div className={ws.card}>
      <div className={styles.acoes} style={{ marginTop: 0, marginBottom: 12 }}>
        <h2 style={{ margin: 0, flex: 1 }}>O que muda nas quantidades quebradas</h2>
        <label htmlFor="consulta-convidados" style={{ margin: 0 }}>Consultar</label>
        <input id="consulta-convidados" inputMode="numeric" style={{ width: 80, margin: 0 }} value={consulta} onChange={(e) => setConsulta(e.target.value)} />
        <span className={styles.fraco}>convidados</span>
      </div>
      <div className={styles.simulador} style={{ marginTop: 0, marginBottom: 12 }}>
        {antesConsulta != null && depoisConsulta
          ? <span>{n} convidados: antes <span className={styles.fraco}>{reais(antesConsulta)}</span> → depois <strong className={styles.porConvidado}>{reais(depoisConsulta.centavos)}</strong>{depoisConsulta.centavos !== antesConsulta ? <span className={styles.mais}> (+{reais(depoisConsulta.centavos - antesConsulta)})</span> : <span className={styles.selo} style={{ marginLeft: 8 }}>sem mudança</span>}</span>
          : <span className={styles.fraco}>{semLimites ? 'Este pacote ainda não tem mínimo e máximo de convidados.' : `Este pacote vai de ${minimo} a ${maximo} convidados.`}</span>}
      </div>
      <div className={styles.lista}>
        <div className={`${styles.comparacao} ${styles.cabecalho}`}><span>Convidados</span><span>Antes</span><span>Depois</span><span>Diferença</span></div>
        {grupos.length === 0 && <div className={styles.comparacao}><span className={styles.fraco}>{erro ? 'Corrija os preços para ver a comparação.' : 'Nenhuma quantidade muda de preço.'}</span></div>}
        {grupos.map((g) => <div key={g.de} className={styles.comparacao}>
          <span>{g.de === g.ate ? g.de : `${g.de} a ${g.ate}`}</span>
          <span className={styles.fraco}>{reais(g.antes)}</span>
          <span>{g.menor === g.maior ? reais(g.menor) : `${reais(g.menor)} a ${reais(g.maior)}`}</span>
          <span className={styles.mais}>{g.difMenor === g.difMaior ? `+${reais(g.difMenor)}` : `+${reais(g.difMenor)} a +${reais(g.difMaior)}`}</span>
        </div>)}
      </div>
      <p className={styles.fraco} style={{ marginTop: 10 }}>Festas e orçamentos já fechados mantêm o valor contratado. Os novos preços valem para orçamentos criados depois da confirmação.</p>
    </div>

    <div className={styles.acoes} style={{ justifyContent: 'space-between' }}>
      <button type="button" onClick={onVoltar}>Deixar para depois</button>
      <AdminPrimaryButton type="button" disabled={carregando || Boolean(erro)} onClick={() => onConfirmar(prontos)}>
        {erro ? 'Corrija os preços para confirmar' : 'Confirmar novos preços'}
      </AdminPrimaryButton>
    </div>
  </section>;
}
