import type { ReactNode } from 'react';
import type { ContratadaEfetiva, ValoresContratada } from '@/lib/contratos/modelo-empresa/contratada';
import type { DiagnosticoObrigatorio } from '@/lib/contratos/modelo-empresa/conteudo';
import type { ClausulaTela, ValorFixo } from '@/lib/contratos/modelo-empresa/valores-fixos';
import { AJUDA_LIMITE } from './protegerSaida';
import mc from '../modelo-contrato.module.css';

/**
 * Partes de apresentação da revisão do modelo de contrato (plano v3, fase 2), alimentadas só por propriedades: o
 * ModeloContrato carrega os dados e decide; aqui só se desenha (testável com renderToStaticMarkup). Estados sempre
 * em texto e ícone, nunca só por cor.
 */
type Rotulos = Record<string, string>;

export function ContadorPublicar({ incluidos, total, outrosProblemas, contratadaErro, semPerfil }: {
  incluidos: number; total: number; outrosProblemas: number; contratadaErro: boolean; semPerfil: boolean;
}) {
  const completo = incluidos === total;
  const pronto = completo && !outrosProblemas && !contratadaErro && !semPerfil;
  return <div className={mc.contador} role="status" aria-live="polite">
    <strong>{completo ? '✓' : '!'} {incluidos} de {total} dados da festa e do valor</strong>
    <span>{pronto ? '✓ Pronto para publicar.'
      : contratadaErro ? '✕ Não é possível publicar: os dados da empresa não puderam ser lidos.'
      : outrosProblemas ? `! Há ${outrosProblemas} ${outrosProblemas === 1 ? 'outro problema' : 'outros problemas'} no texto.`
      : semPerfil ? '! Só quem gere a empresa pode publicar.'
      : `! Faltam ${total - incluidos} para publicar.`}</span>
  </div>;
}

const ORIGEM_TEXTO = (c: ContratadaEfetiva) => c.estado === 'ERRO' ? `✕ Erro: ${c.erro}`
  : c.estado === 'PERFIL' ? `✓ Dados do Perfil da empresa (versão ${c.perfilVersao}).`
  : c.estado === 'MODELO_INCOMPLETO' ? `! Do modelo: o perfil está incompleto (falta ${c.faltando.join(', ')}).`
  : '! Do modelo: a empresa ainda não tem Perfil.';

export function BlocoIdentificacao({ contratada, modelo, rotulos, identificacao, bloqueado, onCampo, onAtualizar }: {
  contratada: ContratadaEfetiva | null;
  modelo: ValoresContratada;
  rotulos: Rotulos;
  identificacao: readonly string[];
  bloqueado: boolean;
  onCampo?: (campo: keyof ValoresContratada, valor: string) => void;
  onAtualizar?: () => void;
}) {
  const doPerfil = contratada?.estado === 'PERFIL';
  const editaveis: Array<[keyof ValoresContratada, string]> = doPerfil ? [['representante', 'Representante (do modelo)']]
    : [['nome', 'Contratada (nome ou razão social)'], ['documento', 'CNPJ ou CPF'], ['endereco', 'Endereço da contratada'], ['representante', 'Representante']];
  return <section className={mc.secao} aria-labelledby="identificacao-titulo">
    <h2 id="identificacao-titulo">1. Identificação (automática)</h2>
    <h3>Contratada</h3>
    <p className={contratada?.estado === 'ERRO' ? mc.erroTexto : undefined}>
      {contratada ? ORIGEM_TEXTO(contratada) : '! Prévia sem os dados do perfil: só quem gere a empresa vê os dados do Perfil.'}
    </p>
    {doPerfil && contratada.valores && <dl className={mc.dados}>
      <dt>Razão social</dt><dd>{contratada.valores.nome}</dd>
      <dt>CNPJ</dt><dd>{contratada.valores.documento}</dd>
      <dt>Endereço (sede)</dt><dd>{contratada.valores.endereco}</dd>
    </dl>}
    {contratada?.estado !== 'ERRO' && editaveis.map(([campo, rotulo]) => <label key={campo}>{rotulo}
      <input value={modelo[campo]} disabled={bloqueado} onChange={(e) => onCampo?.(campo, e.target.value)} />
    </label>)}
    <div className={mc.acoesLinha}>
      <a href="/admin/configuracoes/perfil-empresa" target="_blank" rel="noopener">Completar no perfil (nova aba)</a>
      {contratada && <button type="button" disabled={bloqueado} onClick={() => onAtualizar?.()}>Atualizar dados da empresa</button>}
    </div>
    <h3>Contratante e aniversariante</h3>
    <div className={mc.etiquetas}>{identificacao.map((c) => <span key={c} className={mc.etiqueta} aria-label={`Campo: ${rotulos[c] ?? c}`}>{rotulos[c] ?? c}</span>)}</div>
    <p className={mc.ajuda}>O sistema imprime estes dados em todo contrato. Idade, tema e RG vazios saem como “não informado”.</p>
  </section>;
}

export function PainelObrigatorios({ itens, sugestoes, bloqueado, onTrocar, onInserir }: {
  itens: DiagnosticoObrigatorio[];
  sugestoes: ValorFixo[];
  bloqueado: boolean;
  onTrocar?: (s: ValorFixo) => void;
  onInserir?: (chave: string) => void;
}) {
  return <section className={mc.secao} aria-labelledby="obrigatorios-titulo">
    <h2 id="obrigatorios-titulo">2. Dados da festa e do valor</h2>
    <ul className={mc.obrigatorios}>
      {itens.map((i) => {
        const sugestao = i.clausulas.length ? undefined : sugestoes.find((s) => s.sugerir && s.campos.includes(i.chave));
        return <li key={i.chave} data-estado={i.clausulas.length ? 'ok' : 'falta'}>
          <span>{i.clausulas.length ? '✓' : '!'} <strong>{i.rotulo}</strong>
            {' — '}{i.clausulas.length ? `Incluído na Cláusula ${i.clausulas.join(', ')}` : 'Falta'}</span>
          {!i.clausulas.length && <span className={mc.acoesLinha}>
            {sugestao && <button type="button" disabled={bloqueado} onClick={() => onTrocar?.(sugestao)}>Trocar {sugestao.trecho} (Cláusula {sugestao.numero})</button>}
            <button type="button" disabled={bloqueado} aria-label={`Inserir ${i.rotulo}`} onClick={() => onInserir?.(i.chave)}>Inserir</button>
          </span>}
        </li>;
      })}
    </ul>
  </section>;
}

/** Texto da cláusula em leitura: campos como etiquetas e valores fixos tracejados. */
export function ClausulaLeitura({ clausula, valoresFixos, rotulos }: { clausula: ClausulaTela; valoresFixos: ValorFixo[]; rotulos: Rotulos }) {
  type Pedaco = { inicio: number; fim: number; tipo: 'campo' | 'fixo'; chave?: string; fixo?: ValorFixo };
  const pedacos: Pedaco[] = [];
  for (const m of clausula.texto.matchAll(/\{\{\s*([a-z_]+(?:\.[a-z_]+)*)\s*\}\}/g)) pedacos.push({ inicio: m.index!, fim: m.index! + m[0].length, tipo: 'campo', chave: m[1] });
  for (const f of valoresFixos.filter((v) => v.idClausula === clausula.id)) pedacos.push({ inicio: f.inicio, fim: f.fim, tipo: 'fixo', fixo: f });
  pedacos.sort((a, b) => a.inicio - b.inicio);
  const partes: ReactNode[] = [];
  let pos = 0;
  pedacos.forEach((p, k) => {
    if (p.inicio < pos) return;
    if (p.inicio > pos) partes.push(clausula.texto.slice(pos, p.inicio));
    if (p.tipo === 'campo') {
      const rotulo = rotulos[p.chave!] ?? p.chave!;
      partes.push(<span key={k} className={mc.etiqueta} aria-label={`Campo: ${rotulo}`}>{rotulo}</span>);
    } else {
      const f = p.fixo!;
      partes.push(<span key={k} className={mc.tracejado} aria-label={`Valor fixo: ${f.trecho}, ${f.sugerir ? `sugestão: ${f.rotulo}` : 'sem sugestão'}`}>{f.trecho}</span>);
    }
    pos = p.fim;
  });
  if (pos < clausula.texto.length) partes.push(clausula.texto.slice(pos));
  return <p className={mc.leitura}>{partes}</p>;
}

/** Todos os valores fixos que continuam nas cláusulas (com ou sem sugestão); não impedem publicar. */
export function ListaValoresFixos({ valoresFixos }: { valoresFixos: ValorFixo[] }) {
  if (!valoresFixos.length) return null;
  return <section className={mc.secao} aria-labelledby="fixos-titulo">
    <h2 id="fixos-titulo">Valores fixos nas cláusulas</h2>
    <p className={mc.ajuda}>Não impedem publicar. Confira se algum deveria mudar a cada festa.</p>
    <ul className={mc.obrigatorios}>{valoresFixos.map((f) => <li key={`${f.idClausula}-${f.inicio}`}>
      <span>Cláusula {f.numero}: <span className={mc.tracejado}>{f.trecho}</span>{f.sugerir ? ` (parece ser: ${f.rotulo})` : ''}</span>
    </li>)}</ul>
  </section>;
}

export function EstadoSalvamento({ alterado, enviando, incerto, naoConfirmado, falhaConferir, salvoEm, onConferir }: {
  alterado: boolean; enviando: boolean; incerto: boolean; naoConfirmado: boolean; falhaConferir: boolean; salvoEm: string | null; onConferir?: () => void;
}) {
  return <div className={mc.estado} role="status" aria-live="polite">
    {enviando ? <span>⟳ Salvando…</span>
      : falhaConferir ? <span>! Não foi possível conferir o salvamento. <button type="button" onClick={() => onConferir?.()}>Tentar de novo</button></span>
      : naoConfirmado ? <span>! O salvamento ainda não foi confirmado no servidor. <button type="button" onClick={() => onConferir?.()}>Conferir</button></span>
      : incerto ? <span>! O salvamento não foi confirmado. Ele pode ou não ter sido gravado, e ainda pode ser concluído. <button type="button" onClick={() => onConferir?.()}>Conferir</button></span>
      : alterado ? <span>● Alterações não salvas</span>
      : <span>✓ {salvoEm ? `Salvo às ${salvoEm}` : 'Rascunho salvo.'}</span>}
    {(alterado || incerto || naoConfirmado) && !enviando && <small className={mc.ajuda}>{AJUDA_LIMITE}</small>}
  </div>;
}
