import { validarData, validarValor } from './validadores.ts';

/** Informação explícita no documento; continua sujeita à conferência final do operador. */
export type RecebimentoDocumento = {
  valorCentavos: number; data: string; forma: 'PIX' | 'TRANSFERENCIA' | 'DINHEIRO' | 'CARTAO_CREDITO' | 'CARTAO_DEBITO';
  pagina: number; trecho: string;
};
export type LeituraRecebimentos = { recebimentos: RecebimentoDocumento[]; pendencias: string[] };

const formas: Record<string, RecebimentoDocumento['forma']> = {
  pix: 'PIX', transferencia: 'TRANSFERENCIA', dinheiro: 'DINHEIRO',
  'cartao de credito': 'CARTAO_CREDITO', 'cartao de debito': 'CARTAO_DEBITO',
};
const normalizar = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Leitura conservadora do texto original, independente da resposta do modelo. Uma linha precisa dizer
 * recebido/pago + valor + data com ano + forma. Condições, promessas, exemplos e negações não são recebimentos.
 * Linhas repetidas são ambíguas: não somar nem descartar silenciosamente. Nunca escreve no Financeiro.
 */
export function lerRecebimentos(paginas: readonly string[]): LeituraRecebimentos {
  const recebimentos: RecebimentoDocumento[] = [], pendencias: string[] = [];
  const vistos = new Set<string>();
  for (const [pagina, texto] of paginas.entries()) for (const bruta of texto.split(/\r?\n/)) {
    const trecho = bruta.trim();
    if (!/^(?:recebido|pago|pagamento recebido|pagamento realizado)\b/i.test(trecho)) continue;
    const m = /^(?:recebido|pago|pagamento recebido|pagamento realizado)\s*:?\s*(R\$\s*[\d.,]+)\s+(?:em|no dia)\s+(\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{4}-\d{2}-\d{2})\s+(?:por|via|com)\s+(PIX|transferência|transferencia|dinheiro|cartão de crédito|cartao de credito|cartão de débito|cartao de debito)\.?$/i.exec(trecho);
    if (!m) { pendencias.push('Página ' + (pagina + 1) + ': confira a informação de recebimento.'); continue; }
    const valor = validarValor(m[1]), data = validarData(m[2]), forma = formas[normalizar(m[3])];
    if (!valor.ok || valor.valor <= 0 || valor.valor > 9999999999 || !data.ok || !forma || trecho.length > 300) {
      pendencias.push('Página ' + (pagina + 1) + ': valor, data ou forma do recebimento precisa de revisão.'); continue;
    }
    const chave = valor.valor + '|' + data.valor + '|' + forma;
    if (vistos.has(chave)) { pendencias.push('Recebimento repetido no documento: confira se são pagamentos distintos.'); continue; }
    vistos.add(chave);
    if (recebimentos.length === 60) { pendencias.push('Há mais de 60 recebimentos: confira o documento.'); continue; }
    recebimentos.push({ valorCentavos: valor.valor, data: data.valor, forma, pagina: pagina + 1, trecho });
  }
  return { recebimentos, pendencias: [...new Set(pendencias)] };
}

/** Revalida metadados guardados: o trecho deve produzir exatamente os mesmos fatos. Legado não tem sugestões. */
export function leituraRecebimentosGuardada(bruto: unknown): LeituraRecebimentos {
  const vazio = () => ({ recebimentos: [], pendencias: [] });
  if (!bruto || typeof bruto !== 'object') return vazio();
  const b = bruto as Partial<LeituraRecebimentos>;
  if (!Array.isArray(b.recebimentos) || b.recebimentos.length > 60 || !Array.isArray(b.pendencias) || b.pendencias.some(x => typeof x !== 'string')) return vazio();
  const vistos = new Set<string>();
  for (const r of b.recebimentos) {
    if (!r || typeof r.trecho !== 'string' || !Number.isInteger(r.pagina) || r.pagina < 1 || r.pagina > 200) return vazio();
    const lida = lerRecebimentos([r.trecho]);
    const item = lida.recebimentos[0];
    if (lida.pendencias.length || !item || item.valorCentavos !== r.valorCentavos || item.data !== r.data || item.forma !== r.forma) return vazio();
    const chave = r.valorCentavos + '|' + r.data + '|' + r.forma;
    if (vistos.has(chave)) return vazio();
    vistos.add(chave);
  }
  return { recebimentos: b.recebimentos, pendencias: b.pendencias };
}

/** Só pagamento integral, sem ambiguidades e sem data futura, permite preencher todos os recebimentos. */
export function recebimentosIntegrais(lida: LeituraRecebimentos, total: number | null, hoje: string): RecebimentoDocumento[] | null {
  const segura = leituraRecebimentosGuardada(lida);
  if (!total || !segura.recebimentos.length || segura.pendencias.length || segura.recebimentos.some(r => r.data > hoje)) return null;
  return segura.recebimentos.reduce((s, r) => s + r.valorCentavos, 0) === total ? segura.recebimentos : null;
}
