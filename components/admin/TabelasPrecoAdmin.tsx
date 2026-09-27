'use client';

import { useState, type FormEvent } from 'react';
import { adminFetch } from '@/lib/http/admin-fetch';
import styles from './admin.module.css';

type Pacote = { id: string; codigo: string; nome: string };
type Tabela = { id: string; codigo: string; nome: string; vigencia_inicio: string; vigencia_fim: string | null; publicada: boolean };
type Faixa = { convidados_min: number; convidados_max: number | null };
type Combinacao = {
  id: string;
  pacote_id: string;
  pacote_codigo: string;
  pacote_nome: string;
  categoria_horario: string;
  cobertura_continua: boolean;
  limite_convidados_min: number | null;
  limite_convidados_max: number | null;
  faixas: Faixa[];
};
type Preco = {
  pacote_codigo: string;
  categoria_horario: string;
  convidados_min: number;
  convidados_max: number | null;
  tipo_calculo: string;
  valor: string;
  ativo: boolean;
};
type Lacuna = { codigo: string; detalhe: string };
type Quadro = {
  tabelas: Tabela[];
  pacotes: Pacote[];
  quadro: null | {
    tabela: Tabela | null;
    combinacoes: Combinacao[];
    precos: Preco[];
    lacunas: Lacuna[];
    completo: boolean;
  };
};

const categorias = ['GERAL', 'PADRAO', 'NOBRE'] as const;

function faixaTexto(min: number, max: number | null) {
  return max == null ? `${min} em diante` : `${min}–${max}`;
}

export default function TabelasPrecoAdmin() {
  const [empresaId, setEmpresaId] = useState('');
  const [tabelaId, setTabelaId] = useState('');
  const [pacoteId, setPacoteId] = useState('');
  const [dataFesta, setDataFesta] = useState('2026-10-10');
  const [convidados, setConvidados] = useState('40');
  const [valor, setValor] = useState('');
  const [sobConsulta, setSobConsulta] = useState(false);
  const [categoria, setCategoria] = useState<(typeof categorias)[number]>('PADRAO');
  const [continua, setContinua] = useState(false);
  const [limiteMin, setLimiteMin] = useState('');
  const [limiteMax, setLimiteMax] = useState('');
  const [faixaMin, setFaixaMin] = useState('');
  const [faixaMax, setFaixaMax] = useState('');
  const [quadro, setQuadro] = useState<Quadro | null>(null);
  const [resultado, setResultado] = useState('');
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(false);

  async function enviar(event: FormEvent, corpo: Record<string, unknown>) {
    event.preventDefault();
    setCarregando(true);
    setErro('');
    setResultado('');
    let ok = false;
    try {
      const response = await adminFetch('/api/admin/configuracoes/tabelas-preco', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      const body = await response.json();
      if (!response.ok || body.ok === false) throw new Error(body.erro || 'Não foi possível concluir.');
      if (body.data?.tipo) setResultado(body.data.tipo === 'PRECO' ? `${body.data.centavos} centavos` : body.data.tipo);
      else setResultado(body.data ? `Tabela ${body.data}` : 'Publicação registrada. Fechamentos antigos não foram recalculados.');
      if (typeof body.data === 'string') setTabelaId(body.data);
      ok = true;
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao salvar.');
    } finally {
      setCarregando(false);
    }
    return ok;
  }

  async function carregar(event?: FormEvent, id = tabelaId) {
    event?.preventDefault();
    setCarregando(true);
    setErro('');
    try {
      const consulta = new URLSearchParams({ empresaId });
      if (id) consulta.set('tabelaId', id);
      const response = await adminFetch(`/api/admin/configuracoes/tabelas-preco?${consulta.toString()}`);
      const body = await response.json();
      if (!response.ok || body.ok === false) throw new Error(body.erro || 'Não foi possível ler a tabela.');
      setQuadro(body.data as Quadro);
      setResultado('');
    } catch (error) {
      setErro(error instanceof Error ? error.message : 'Falha ao ler.');
    } finally {
      setCarregando(false);
    }
  }

  const atual = quadro?.quadro;
  const pacotes = quadro?.pacotes ?? [];
  const tabelas = quadro?.tabelas ?? [];

  function gravarEscopo(event: FormEvent) {
    const faixa = {
      convidadosMin: Number(faixaMin),
      convidadosMax: faixaMax.trim() === '' ? null : Number(faixaMax),
    };
    const existente = (atual?.combinacoes ?? []).find((item) => item.pacote_id === pacoteId && item.categoria_horario === categoria);
    const combinacao = {
      pacoteId,
      categoriaHorario: categoria,
      coberturaContinua: continua,
      limiteConvidadosMin: limiteMin.trim() === '' ? null : Number(limiteMin),
      limiteConvidadosMax: limiteMax.trim() === '' ? null : Number(limiteMax),
      faixas: [
        ...(existente?.faixas ?? []).map((itemFaixa) => ({ convidadosMin: itemFaixa.convidados_min, convidadosMax: itemFaixa.convidados_max })),
        faixa,
      ],
    };
    const anteriores = (atual?.combinacoes ?? [])
      .filter((item) => !(item.pacote_id === pacoteId && item.categoria_horario === categoria))
      .map((item) => ({
        pacoteId: item.pacote_id,
        categoriaHorario: item.categoria_horario,
        coberturaContinua: item.cobertura_continua,
        limiteConvidadosMin: item.limite_convidados_min,
        limiteConvidadosMax: item.limite_convidados_max,
        faixas: item.faixas.map((itemFaixa) => ({ convidadosMin: itemFaixa.convidados_min, convidadosMax: itemFaixa.convidados_max })),
      }));
    void enviar(event, { acao: 'escopo', empresaId, tabelaId, combinacoes: [...anteriores, combinacao] }).then((ok) => {
      if (ok) void carregar(undefined, tabelaId);
    });
  }

  return (
    <main className={styles.page}>
      <h1>Tabelas de preços</h1>
      <p>Uma tabela nova guarda o preço futuro. Publicar só ocorre quando o escopo declarado dessa tabela está completo. O PDF de pacotes continua separado e não bloqueia esta publicação.</p>
      <p role="alert">{erro}</p>
      <p role="status">{resultado}</p>

      <form onSubmit={(event) => void carregar(event)}>
        <label htmlFor="empresa">Empresa<input id="empresa" value={empresaId} onChange={(event) => setEmpresaId(event.target.value)} required /></label>
        <label htmlFor="tabela">Tabela<input id="tabela" value={tabelaId} onChange={(event) => setTabelaId(event.target.value)} /></label>
        <button type="submit" disabled={carregando || !empresaId}>Ler escopo</button>
      </form>

      {tabelas.length > 0 && (
        <section className={styles.card}>
          <h2>Tabelas desta empresa</h2>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>Código</th><th>Vigência</th><th>Publicação</th></tr></thead>
              <tbody>
                {tabelas.map((tabela) => (
                  <tr key={tabela.id}>
                    <td><button type="button" onClick={() => { setTabelaId(tabela.id); void carregar(undefined, tabela.id); }}>{tabela.codigo}</button></td>
                    <td>{tabela.vigencia_inicio}{tabela.vigencia_fim ? ` até ${tabela.vigencia_fim}` : ''}</td>
                    <td>{tabela.publicada ? 'Publicada' : 'Rascunho'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {atual && (
        <section className={styles.card}>
          <h2>Escopo de {atual.tabela?.codigo}</h2>
          <p>{atual.completo ? 'Completo para publicar.' : 'Incompleto. A publicação está fechada.'}</p>
          <h3>Pacotes e categorias incluídos</h3>
          {atual.combinacoes.length === 0 ? <p>Nenhum pacote declarado.</p> : (
            <div className={styles.tableWrap}>
              <table>
                <thead><tr><th>Pacote</th><th>Categoria</th><th>Faixas</th><th>Cobertura</th><th>Limites</th></tr></thead>
                <tbody>
                  {atual.combinacoes.map((combinacao) => (
                    <tr key={combinacao.id}>
                      <td>{combinacao.pacote_codigo} · {combinacao.pacote_nome}</td>
                      <td>{combinacao.categoria_horario}</td>
                      <td>{combinacao.faixas.map((faixa) => faixaTexto(faixa.convidados_min, faixa.convidados_max)).join(', ') || 'Sem faixa'}</td>
                      <td>{combinacao.cobertura_continua ? 'Contínua' : 'Faixas declaradas'}</td>
                      <td>{combinacao.limite_convidados_min ?? '—'} / {combinacao.limite_convidados_max ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>Preços</h3>
          {atual.precos.length === 0 ? <p>Nenhum preço nesta tabela.</p> : (
            <div className={styles.tableWrap}>
              <table>
                <thead><tr><th>Pacote</th><th>Categoria</th><th>Faixa</th><th>Cálculo</th><th>Valor</th><th>Ativo</th></tr></thead>
                <tbody>
                  {atual.precos.map((preco) => (
                    <tr key={`${preco.pacote_codigo}-${preco.categoria_horario}-${preco.convidados_min}`}>
                      <td>{preco.pacote_codigo}</td>
                      <td>{preco.categoria_horario}</td>
                      <td>{faixaTexto(preco.convidados_min, preco.convidados_max)}</td>
                      <td>{preco.tipo_calculo}</td>
                      <td>{preco.valor}</td>
                      <td>{preco.ativo ? 'Sim' : 'Não'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>Lacunas que bloqueiam a publicação</h3>
          {atual.lacunas.length === 0 ? <p>Nenhuma lacuna.</p> : (
            <ul>
              {atual.lacunas.map((lacuna) => <li key={`${lacuna.codigo}-${lacuna.detalhe}`}>{lacuna.codigo}: {lacuna.detalhe}</li>)}
            </ul>
          )}
        </section>
      )}

      <form onSubmit={gravarEscopo}>
        <h2>Declarar pacote e categoria</h2>
        <p>A declaração é o que esta tabela vende. Pacote ou categoria de fora não entra sozinho, e uma faixa não declarada não é inventada.</p>
        <label htmlFor="pacote-escopo">Pacote
          <select id="pacote-escopo" value={pacoteId} onChange={(event) => setPacoteId(event.target.value)} required>
            <option value="">Escolha</option>
            {pacotes.map((pacote) => <option key={pacote.id} value={pacote.id}>{pacote.codigo} · {pacote.nome}</option>)}
          </select>
        </label>
        <label htmlFor="categoria">Categoria
          <select id="categoria" value={categoria} onChange={(event) => setCategoria(event.target.value as (typeof categorias)[number])}>
            {categorias.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label htmlFor="continua"><input id="continua" type="checkbox" checked={continua} onChange={(event) => setContinua(event.target.checked)} />Cobertura contínua</label>
        <label htmlFor="limite-min">Limite mínimo de convidados<input id="limite-min" inputMode="numeric" value={limiteMin} onChange={(event) => setLimiteMin(event.target.value)} /></label>
        <label htmlFor="limite-max">Limite máximo de convidados<input id="limite-max" inputMode="numeric" value={limiteMax} onChange={(event) => setLimiteMax(event.target.value)} /></label>
        <label htmlFor="faixa-min">Faixa de<input id="faixa-min" inputMode="numeric" value={faixaMin} onChange={(event) => setFaixaMin(event.target.value)} required /></label>
        <label htmlFor="faixa-max">Faixa até<input id="faixa-max" inputMode="numeric" value={faixaMax} onChange={(event) => setFaixaMax(event.target.value)} /></label>
        <button type="submit" disabled={carregando || !empresaId || !tabelaId || !pacoteId}>Gravar escopo</button>
      </form>

      <form onSubmit={(event) => void enviar(event, {
        acao: 'simular_festa', empresaId, data: dataFesta, pacoteId, convidados: Number(convidados), categoriaHorario: 'PADRAO', sobConsulta,
      })}>
        <label htmlFor="festa">Data da festa<input id="festa" type="date" value={dataFesta} onChange={(event) => setDataFesta(event.target.value)} required /></label>
        <label htmlFor="convidados">Convidados<input id="convidados" inputMode="numeric" value={convidados} onChange={(event) => setConvidados(event.target.value)} required /></label>
        <button type="submit" disabled={carregando || !empresaId || !pacoteId}>Simular tabela publicada</button>
      </form>
      <form onSubmit={(event) => void enviar(event, { acao: 'simular', valor: valor.trim() ? valor.trim() : null, sobConsulta })}>
        <label htmlFor="valor">Valor em reais<input id="valor" value={valor} onChange={(event) => setValor(event.target.value)} placeholder="10.50" /></label>
        <label htmlFor="consulta"><input id="consulta" type="checkbox" checked={sobConsulta} onChange={(event) => setSobConsulta(event.target.checked)} />Sob consulta</label>
        <button type="submit" disabled={carregando}>Simular</button>
      </form>
      <form onSubmit={(event) => void enviar(event, {
        acao: 'criar', empresaId, codigo: 'TABELA_NOVA', nome: 'Tabela nova', vigenciaInicio: '2026-10-01', vigenciaFim: null,
      })}>
        <button type="submit" disabled={carregando || !empresaId}>Criar vigência</button>
      </form>
      <form onSubmit={(event) => void enviar(event, {
        acao: 'preco', empresaId, tabelaId, pacoteId, convidadosMin: Number(faixaMin), convidadosMax: faixaMax.trim() === '' ? null : Number(faixaMax), tipoCalculo: 'FIXO', valor, categoriaHorario: categoria,
      })}>
        <button type="submit" disabled={carregando || !empresaId || !tabelaId || !pacoteId || !valor}>Incluir preço da faixa</button>
      </form>
      <form onSubmit={(event) => { if (window.confirm('Publicar esta tabela? Fechamentos já gravados não serão recalculados.')) void enviar(event, { acao: 'publicar', empresaId, tabelaId }); else event.preventDefault(); }}>
        <button type="submit" disabled={carregando || atual?.completo === false}>Publicar</button>
      </form>
    </main>
  );
}
