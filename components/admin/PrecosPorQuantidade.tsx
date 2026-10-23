'use client';

import { useState, type KeyboardEvent } from 'react';
import { centavosPorPontos, ModeloPrecoError, normalizarValorInformado, validarPontos, type PontoPreco } from '@/lib/comercial/modelo-preco';
import styles from './precos-quantidade.module.css';
import ws from './workspace.module.css';

/** Linha da tela: texto como digitado; o servidor valida de novo (validarPontos). */
export type PontoForm = { convidados: string; valor: string };

const reais = (centavos: number) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const numero = (texto: string) => Number(texto.trim());
const centavos = (texto: string) => {
  const valor = Number(normalizarValorInformado(texto));
  return Number.isFinite(valor) && texto.trim() ? Math.round(valor * 100) : null;
};
export const valorDigitado = (valor: string) => Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function pontosDaTela(pontos: PontoForm[]): PontoPreco[] {
  return pontos
    .filter((ponto) => ponto.convidados.trim() || ponto.valor.trim())
    .map((ponto) => ({ convidados: numero(ponto.convidados), valor: normalizarValorInformado(ponto.valor) }));
}

/** Mesma regra do servidor: primeira = mínimo, última = máximo, preço igual ou maior que o anterior. */
export function erroDosPontos(pontos: PontoForm[], minimo: number, maximo: number): string | null {
  const prontos = pontosDaTela(pontos);
  if (prontos.length === 0) return null;
  try {
    validarPontos(prontos, { minimo, maximo });
    return null;
  } catch (error) {
    return error instanceof ModeloPrecoError ? error.message : 'Confira as quantidades e os preços.';
  }
}

const paraTexto = (centavosValor: number) => (centavosValor / 100).toFixed(2).replace('.', ',');

/**
 * Acréscimo sugerido para "Completar os preços": o ritmo das duas últimas quantidades com preço (diferença por
 * convidado), levado ao intervalo da tela. Sem duas quantidades com preço, ou com preço caindo, não há sugestão.
 */
export function acrescimoSugerido(pontos: PontoForm[], intervalo: number): number | null {
  const comPreco = pontos
    .map((p) => ({ q: numero(p.convidados), c: centavos(p.valor) }))
    .filter((p): p is { q: number; c: number } => Number.isInteger(p.q) && p.c != null)
    .sort((a, b) => a.q - b.q);
  if (comPreco.length < 2 || !(intervalo > 0)) return null;
  const [a, b] = comPreco.slice(-2);
  if (b.q <= a.q || b.c < a.c) return null;
  return Math.round(((b.c - a.c) / (b.q - a.q)) * intervalo);
}

/**
 * Preenche SÓ os preços vazios: cada um parte do último preço DIGITADO acima dele (na ordem de convidados) e soma
 * `acrescimo` a cada `intervalo` convidados. Preço digitado nunca muda; texto inválido ("abc") também não — fica para
 * o operador corrigir (parecer do Astra, 23/10, P2). A âncora é sempre o digitado, nunca um valor já preenchido, para o
 * arredondamento não se acumular linha a linha (P3). Quantidade sem preço digitado acima dela fica vazia.
 */
export function completarPrecos(pontos: PontoForm[], acrescimo: number, intervalo: number): PontoForm[] {
  if (!(acrescimo >= 0) || !(intervalo > 0)) return pontos;
  const porConvidado = acrescimo / intervalo;
  const ordem = pontos.map((ponto, indice) => ({ ponto, indice })).sort((x, y) => numero(x.ponto.convidados) - numero(y.ponto.convidados));
  const novos = [...pontos];
  let ancora: { q: number; c: number } | null = null;
  for (const { ponto, indice } of ordem) {
    const q = numero(ponto.convidados);
    if (!Number.isInteger(q)) continue;
    if (ponto.valor.trim()) {
      const c = centavos(ponto.valor);
      if (c != null) ancora = { q, c };
      continue;
    }
    if (!ancora) continue;
    novos[indice] = { ...ponto, valor: paraTexto(Math.round(ancora.c + (q - ancora.q) * porConvidado)) };
  }
  return novos;
}

export function PrecosPorQuantidade({ pontos, onChange, minimo, maximo }: {
  pontos: PontoForm[];
  onChange: (pontos: PontoForm[]) => void;
  minimo: number;
  maximo: number;
}) {
  const [passo, setPasso] = useState('10');
  const [simular, setSimular] = useState('');
  /** null = o operador não mexeu: vale a sugestão pelo ritmo dos preços digitados. */
  const [acrescimo, setAcrescimo] = useState<string | null>(null);
  const limitesOk = Number.isInteger(minimo) && Number.isInteger(maximo) && minimo >= 1 && maximo >= minimo;
  const intervaloTela = Math.max(1, Math.round(numero(passo) || 10));
  const sugestao = acrescimoSugerido(pontos, intervaloTela);
  const acrescimoTexto = acrescimo ?? (sugestao != null ? paraTexto(sugestao) : '');
  const acrescimoCentavos = centavos(acrescimoTexto);
  const vazios = pontos.filter((p) => p.convidados.trim() && !p.valor.trim()).length;
  const completados = acrescimoCentavos != null && acrescimoCentavos >= 0 ? completarPrecos(pontos, acrescimoCentavos, intervaloTela) : pontos;
  const aCompletar = completados.filter((p, i) => p.valor !== pontos[i].valor).length;

  function completar() {
    if (aCompletar > 0) onChange(completados);
  }

  function criarQuantidades() {
    if (!limitesOk) return;
    const intervalo = Math.max(1, Math.round(numero(passo) || 10));
    const anteriores = new Map(pontos.map((ponto) => [numero(ponto.convidados), ponto.valor]));
    const novos: PontoForm[] = [];
    for (let q = minimo; q < maximo && novos.length < 39; q += intervalo) novos.push({ convidados: String(q), valor: anteriores.get(q) ?? '' });
    novos.push({ convidados: String(maximo), valor: anteriores.get(maximo) ?? '' });
    onChange(novos);
  }

  function adicionar() {
    const ultimo = pontos[pontos.length - 1];
    const intervalo = Math.max(1, Math.round(numero(passo) || 10));
    const base = ultimo && ultimo.convidados.trim() ? numero(ultimo.convidados) : minimo - intervalo;
    onChange([...pontos, { convidados: String(Math.min(maximo, base + intervalo)), valor: ultimo?.valor ?? '' }]);
  }

  function alterar(indice: number, campo: keyof PontoForm, valor: string) {
    onChange(pontos.map((ponto, i) => i === indice ? { ...ponto, [campo]: valor } : ponto));
  }

  function enterNoPreco(evento: KeyboardEvent<HTMLInputElement>, indice: number) {
    if (evento.key !== 'Enter') return;
    evento.preventDefault();
    if (indice === pontos.length - 1) adicionar();
  }

  const ordem = pontos.map((ponto, indice) => ({ ponto, indice })).sort((a, b) => numero(a.ponto.convidados) - numero(b.ponto.convidados));
  const prontos = pontosDaTela(pontos).filter((p) => Number.isInteger(p.convidados) && centavos(p.valor) != null);
  const primeiro = prontos.length ? Math.min(...prontos.map((p) => p.convidados)) : null;
  const ultimo = prontos.length ? Math.max(...prontos.map((p) => p.convidados)) : null;
  const cobre = primeiro === minimo && ultimo === maximo;
  const n = Math.round(numero(simular));
  const calculo = simular.trim() && prontos.length ? centavosPorPontos(prontos, n) : null;

  return <div data-precos-quantidade>
    <p className={ws.intro}>Informe o preço só nas quantidades cheias. Para quantidades quebradas, o sistema calcula o valor de cada convidado pela diferença até a próxima quantidade.</p>
    <div className={styles.gerador}>
      <strong>Criar as quantidades</strong>
      <p>De <b>{limitesOk ? minimo : '—'}</b> a <b>{limitesOk ? maximo : '—'}</b> convidados, de
        <input className={styles.inline} inputMode="numeric" aria-label="Intervalo entre as quantidades" value={passo} onChange={(e) => setPasso(e.target.value)} />
        em convidados.</p>
      <button type="button" onClick={criarQuantidades} disabled={!limitesOk}>Criar quantidades</button>
      {!limitesOk && <p className={styles.fraco}>Informe o mínimo e o máximo de convidados na seção 1.</p>}
    </div>
    {pontos.length > 0 && <div className={styles.lista} role="table" aria-label="Preço por quantidade de convidados">
      <div className={`${styles.linha} ${styles.cabecalho}`} role="row"><span role="columnheader">Convidados</span><span role="columnheader">Preço</span><span role="columnheader">Cada convidado a mais até a próxima</span><span /></div>
      {ordem.map(({ ponto, indice }, posicao) => {
        const proximo = ordem[posicao + 1]?.ponto;
        const anterior = ordem[posicao - 1]?.ponto;
        const atual = centavos(ponto.valor);
        const antes = anterior ? centavos(anterior.valor) : null;
        const menor = atual != null && antes != null && atual < antes;
        const depois = proximo ? centavos(proximo.valor) : null;
        const passos = proximo ? numero(proximo.convidados) - numero(ponto.convidados) : 0;
        const porConvidado = atual != null && depois != null && passos > 0 ? Math.round((depois - atual) / passos) : null;
        return <div key={indice} role="rowgroup">
          <div className={styles.linha} role="row">
            <label><span className={ws.srOnly}>Convidados</span><input inputMode="numeric" value={ponto.convidados} onChange={(e) => alterar(indice, 'convidados', e.target.value)} /></label>
            <label><span className={ws.srOnly}>Preço de {ponto.convidados || 'esta quantidade'} convidados</span><input inputMode="decimal" placeholder="0,00" className={menor ? styles.invalido : undefined} aria-invalid={menor || undefined} value={ponto.valor} onChange={(e) => alterar(indice, 'valor', e.target.value)} onKeyDown={(e) => enterNoPreco(e, indice)} /></label>
            <span>{proximo
              ? porConvidado != null && porConvidado >= 0 ? <><span className={styles.porConvidado}>{reais(porConvidado)}</span> <span className={styles.fraco}>({numero(ponto.convidados) + 1} a {numero(proximo.convidados) - 1})</span></> : <span className={styles.fraco}>—</span>
              : <span className={styles.fraco}>máximo do pacote</span>}</span>
            <button type="button" aria-label={`Excluir a quantidade ${ponto.convidados}`} onClick={() => onChange(pontos.filter((_, i) => i !== indice))}>×</button>
          </div>
          {menor && anterior && antes != null && <p className={styles.erroLinha} role="alert">Este preço precisa ser igual ou maior que o de {anterior.convidados} convidados ({reais(antes)}).</p>}
        </div>;
      })}
    </div>}
    {vazios > 0 && <div className={styles.completar} data-completar-precos>
      <strong>Completar os preços</strong>
      <p>Somar R$
        <input className={styles.inline} inputMode="decimal" aria-label="Valor a somar a cada intervalo de convidados" placeholder="0,00" value={acrescimoTexto}
          onChange={(e) => setAcrescimo(e.target.value)} />
        a cada <b>{intervaloTela}</b> convidados, a partir do último preço digitado.</p>
      <p className={styles.fraco}>Só os preços vazios são preenchidos; os que você já digitou não mudam.</p>
      <button type="button" onClick={completar} disabled={aCompletar === 0}>
        {aCompletar > 0 ? `Completar ${aCompletar} ${aCompletar === 1 ? 'preço' : 'preços'}` : 'Completar preços'}
      </button>
      {aCompletar === 0 && <p className={styles.fraco}>{prontos.length === 0
        ? `Digite o preço de ${minimo} convidados para começar.`
        : acrescimoCentavos == null ? 'Informe quanto somar.' : `Digite o preço de ${minimo} convidados para completar o resto.`}</p>}
    </div>}
    <div className={styles.acoes}>
      <button type="button" onClick={adicionar} disabled={!limitesOk}>+ Adicionar quantidade</button>
      {prontos.length > 0 && limitesOk && <span className={`${styles.selo} ${cobre && vazios === 0 ? '' : styles.seloAviso}`}>{vazios > 0
        ? `Faltam ${vazios} ${vazios === 1 ? 'preço' : 'preços'}`
        : cobre ? `Cobre ${minimo} a ${maximo} convidados` : `A primeira deve ser ${minimo} e a última ${maximo}`}</span>}
    </div>
    {prontos.length > 0 && <div className={styles.simulador}>
      <label htmlFor="simular-convidados" style={{ margin: 0 }}>Simular para</label>
      <input id="simular-convidados" inputMode="numeric" placeholder="53" value={simular} onChange={(e) => setSimular(e.target.value)} />
      <span className={styles.fraco}>convidados</span>
      <output htmlFor="simular-convidados">{calculo ? reais(calculo.centavos) : simular.trim() ? 'fora do pacote' : ''}</output>
      {calculo && calculo.inferior.convidados !== n && <p className={styles.conta}>
        {reais(centavos(calculo.inferior.valor) ?? 0)} ({calculo.inferior.convidados} convidados) + {n - calculo.inferior.convidados} × {reais(((centavos(calculo.superior.valor) ?? 0) - (centavos(calculo.inferior.valor) ?? 0)) / (calculo.superior.convidados - calculo.inferior.convidados))}, a diferença até {calculo.superior.convidados} dividida por {calculo.superior.convidados - calculo.inferior.convidados}.
      </p>}
    </div>}
  </div>;
}
