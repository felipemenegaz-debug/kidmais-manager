import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

/**
 * Renderiza um componente TSX real com hooks isolados, sem DOM (mesma técnica de criacao-financeira.test.ts).
 * Componentes filhos não são expandidos: aparecem como elementos com `type` igual à função injetada.
 */
export type Elemento = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

export function texto(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(texto).join('');
  return typeof node === 'object' ? texto((node as Elemento).props?.children) : String(node);
}

export function elementos(node: unknown): Elemento[] {
  if (Array.isArray(node)) return node.flatMap(elementos);
  if (!node || typeof node !== 'object') return [];
  const e = node as Elemento;
  return [e, ...elementos(e.props?.children)];
}

/** CSS Modules viram o próprio nome da classe. */
export const cssFalso = { default: new Proxy({}, { get: (_alvo, chave) => String(chave) }) };

type Efeito = { indice: number; fn: () => void | (() => void); deps?: readonly unknown[] };

export function carregarComponente(arquivo: string, deps: Record<string, unknown>) {
  const slots: unknown[] = [];
  const depsAnteriores = new Map<number, readonly unknown[] | undefined>();
  const limpezas = new Map<number, () => void>();
  let pendentes: Efeito[] = [];
  let cursor = 0;
  const hooks = {
    useState: (inicial: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof inicial === 'function' ? (inicial as () => unknown)() : inicial;
      return [slots[i], (v: unknown) => { slots[i] = typeof v === 'function' ? (v as (a: unknown) => unknown)(slots[i]) : v; }];
    },
    useReducer: (redutor: (s: unknown, a: unknown) => unknown, inicial: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = inicial;
      return [slots[i], (acao: unknown) => { slots[i] = redutor(slots[i], acao); }];
    },
    useRef: (inicial: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: inicial };
      return slots[i];
    },
    useEffect: (fn: () => void | (() => void), dependencias?: readonly unknown[]) => { pendentes.push({ indice: cursor++, fn, deps: dependencias }); },
    useCallback: (fn: unknown) => { cursor++; return fn; },
    useMemo: (fn: () => unknown) => { cursor++; return fn(); },
    createContext: (padrao: unknown) => ({ padrao, Provider: function Provider(props: { children?: unknown }) { return props.children; } }),
    useContext: (ctx: { padrao: unknown }) => ctx.padrao,
  };
  const modulo: Record<string, unknown> = {};
  const js = ts.transpileModule(readFileSync(arquivo, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const todos: Record<string, unknown> = { react: hooks, 'react/jsx-runtime': jsx, ...deps };
  new Function('require', 'exports', js)((id: string) => { assert(id in todos, `dependência não prevista: ${id}`); return todos[id]; }, modulo);

  return {
    modulo,
    render(componente = 'default', props: object = {}) {
      cursor = 0;
      pendentes = [];
      return (modulo[componente] as (p: object) => unknown)(props);
    },
    /** Executa os efeitos do último render cujas dependências mudaram. */
    efeitos() {
      for (const efeito of pendentes) {
        const antes = depsAnteriores.get(efeito.indice);
        const mudou = !depsAnteriores.has(efeito.indice) || !efeito.deps || !antes
          || efeito.deps.length !== antes.length || efeito.deps.some((d, i) => !Object.is(d, antes[i]));
        if (!mudou) continue;
        limpezas.get(efeito.indice)?.();
        const limpeza = efeito.fn();
        if (typeof limpeza === 'function') limpezas.set(efeito.indice, limpeza); else limpezas.delete(efeito.indice);
        depsAnteriores.set(efeito.indice, efeito.deps);
      }
    },
  };
}

export function achar(arvore: unknown, tipo: unknown, rotulo?: string | RegExp) {
  const encontrado = elementos(arvore).find((e) => e.type === tipo && (rotulo === undefined
    || (typeof rotulo === 'string' ? texto(e) === rotulo || e.props['aria-label'] === rotulo : rotulo.test(texto(e)))));
  assert(encontrado, `elemento não encontrado: ${String(tipo)} ${String(rotulo ?? '')}`);
  return encontrado;
}

export function talvez(arvore: unknown, tipo: unknown, rotulo: string) {
  return elementos(arvore).find((e) => e.type === tipo && (texto(e) === rotulo || e.props['aria-label'] === rotulo));
}

export const tique = () => new Promise((resolve) => setImmediate(resolve));
