/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Preload dos testes PG (cluster descartável), carregado por NODE_OPTIONS="--require ..." pelo runner, inclusive nos
 * subprocessos (script RECONCILIAR). Plano "liberar agenda com mais de um salão" (rev. 6–7):
 *
 *  1. Guarda dinâmica: grava em `KIDMAIS_GUARDA_SALAO_ARQUIVO` (JSONL, no momento em que chega, antes de qualquer
 *     COMMIT/ROLLBACK) todo NOTICE de escrita de salão e todo erro KD901, mesmo capturado pelo código ou desfeito.
 *  2. Fase 0 / D'': por transação explícita (BEGIN … COMMIT/ROLLBACK) de cada conexão, registra a sequência de comandos
 *     relevantes e confere a ordem "configuração da agenda antes da primeira trava de agenda, fechamento, contrato, fluxo,
 *     revisão, pagamento, bloqueio ou salão". Violação = evento ORDEM, com a origem (arquivo:linha) do primeiro comando
 *     fora de ordem; `producao` diz se essa origem é código de produção (reprova) ou do próprio teste (listada).
 *  3. Cenários: `globalThis.__kidmaisGuardaSalao` expõe os eventos em memória para a expectativa independente.
 *
 * As travas tomadas DENTRO dos gatilhos da 019 não aparecem aqui (são cobertas pela 114 e pela bateria D).
 */
const fs = require("node:fs");
const path = require("node:path");

const arquivo = process.env.KIDMAIS_GUARDA_SALAO_ARQUIVO;
if (arquivo) instalar();

function instalar() {
  const pg = require("pg");
  const { eventoDaMensagem, classificarComando } = require("./guarda-salao-harness.cjs");
  const raiz = path.resolve(__dirname, "..");
  const eventos = [];
  const transacoes = [];
  const guardarTransacoes = process.env.KIDMAIS_REGISTRO_TRANSACOES === "1";
  // Rodada 2 (C''20–22 em subprocesso): cada transação encerrada vai ao ARQUIVO com todos os comandos, na ordem, para o
  // cenário provar a sequência do filho (configuração antes das linhas; recusa antes do primeiro DML).
  const transacoesNoArquivo = process.env.KIDMAIS_REGISTRO_TRANSACOES_ARQUIVO === "1";
  globalThis.__kidmaisGuardaSalao = { eventos, transacoes, limpar() { eventos.length = 0; transacoes.length = 0; } };

  function registrar(e) {
    eventos.push(e);
    fs.appendFileSync(arquivo, `${JSON.stringify({ ...e, pid: process.pid })}\n`);
  }
  registrar({ tipo: "PRELOAD" });
  identificarModulosTranspilados();

  /**
   * Rodada 3 (P2 do Astra, proveniência): as suítes carregam o código de produção transpilado por `new Function`/`vm`; sem
   * identidade, esses quadros saem como "eval at …, <anonymous>:L:C" e eram descartados, e o primeiro quadro reconhecido
   * passava a ser o wrapper do teste (falso "ordem de teste"). Aqui cada quadro vira {arquivo, linha} ou INDETERMINADO.
   */
  // r11 (CI do GitHub, Linux): o prefixo file:// é casado explicitamente antes do caminho POSIX (/…) ou Windows (/D:/…,
  // D:\…). Antes, em `file:///home/…` o casamento mais à esquerda era "e:///home/…" (o "e:" de "file:" lido como letra de
  // unidade), o quadro virava um caminho fora da raiz e o serviço transpilado não contava como produção.
  const RE_QUADRO = /\(?((?:file:\/\/)?(?:\/?[A-Za-z]:[\\/]|\/)[^():]+):(\d+):\d+\)?\s*$/;
  const { fileURLToPath: deUrl } = require("node:url");
  function quadros(erro) {
    const q = [];
    for (const bruta of String(erro?.stack ?? "").split("\n").slice(1)) {
      const linha = bruta.trim();
      if (/\(node:|^at node:/.test(linha)) continue; // quadro interno do Node (node:internal/…) não é arquivo
      const m = RE_QUADRO.exec(linha);
      if (!m) {
        // Código avaliado sem identidade (eval/new Function/vm sem sourceURL): o emissor não é determinável.
        if (/<anonymous>:\d+:\d+\)?$|\beval at\b/.test(linha)) q.push({ indeterminado: true, texto: linha.slice(0, 160) });
        continue; // quadro nativo, ex. "at new Promise (<anonymous>)"
      }
      let f = m[1];
      if (/^file:\/\//.test(f)) {
        try { f = deUrl(f); } catch { f = f.replace(/^file:\/\/\/?/, ""); }
      } else {
        try { f = decodeURIComponent(f); } catch { /* caminho já legível */ }
      }
      const rel = path.relative(raiz, f).replace(/\\/g, "/");
      if (/node_modules|guarda-salao-preload\.cjs/.test(rel)) continue;
      q.push({ rel, linha: m[2] });
    }
    return q;
  }
  const deTeste = (origem) => /(\.test\.(ts|cjs|mjs)|test-support|test-apoio|-ui\.cjs|harness|regressao-v1|pg-descartavel)/.test(origem) || !/^(lib|app|scripts)\//.test(origem);
  const deProducao = (q) => !q.indeterminado && /^(lib|app|scripts)\//.test(q.rel) && !deTeste(q.rel);
  const textoDoQuadro = (q) => (q.indeterminado ? `<indeterminado> ${q.texto}` : `${q.rel}:${q.linha}`);
  /** Primeiro quadro fora do driver e deste preload ("arquivo:linha" relativo à raiz, ou indeterminado). */
  function origemDe(erro) {
    const q = quadros(erro)[0];
    return q ? textoDoQuadro(q) : "desconhecida";
  }
  /**
   * Emissor do comando (rodada 3): PRODUCAO se QUALQUER quadro da pilha é código de produção (o SQL foi emitido dentro de
   * uma chamada de produção, mesmo que passe por um executor/wrapper do teste); INDETERMINADO se há quadro sem identidade
   * ou nenhum quadro; TESTE só quando todos os quadros identificados são do teste. PRODUCAO e INDETERMINADO reprovam.
   *
   * APLICADOR_MIGRACAO (auditado, listado à parte, não reprova): todos os quadros de produção são o aplicador comum de
   * uma migration ANTERIOR à 114 (`scripts/migration-NNN[-NNN]-comum.cjs`, NNN < 114). O corpo dessas migrations roda
   * uma vez, na cadeia, antes de a 114 existir — o protocolo da configuração ainda não está no schema. Qualquer outro
   * quadro de produção, ou quadro indeterminado, prevalece.
   */
  const RE_APLICADOR = /^scripts\/migration-(\d{3})(?:-(\d{3}))?-comum\.cjs$/;
  const aplicadorAnterior114 = (x) => { const m = RE_APLICADOR.exec(x.rel); return !!m && Number(m[2] ?? m[1]) < 114; };
  function emissorDe(erro) {
    const q = quadros(erro);
    const producao = q.filter(deProducao);
    if (producao.some((x) => !aplicadorAnterior114(x))) return "PRODUCAO";
    if (!q.length || q.some((x) => x.indeterminado)) return "INDETERMINADO";
    if (producao.length) return "APLICADOR_MIGRACAO";
    return "TESTE";
  }
  const reprova = (emissor) => emissor === "PRODUCAO" || emissor === "INDETERMINADO";
  /** Todos os quadros de código de produção (lib/, app/, scripts/ fora de teste) da pilha: "arquivo:linha", de dentro para fora. */
  function quadrosDeProducao(erro) {
    return quadros(erro).filter(deProducao).map(textoDoQuadro);
  }
  /** A pilha relativa (até 16 quadros, sem driver/preload, com os indeterminados) acompanha cada ORDEM, para a auditoria. */
  function pilhaDe(erro) {
    return quadros(erro).slice(0, 16).map(textoDoQuadro);
  }
  const cobertura = process.env.KIDMAIS_GUARDA_COBERTURA === "1";
  // A cadeia inteira até a entrada (o emissor de produção pode estar vários quadros acima do wrapper).
  Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 50);

  /**
   * Identidade dos módulos transpilados (rodada 3). Os carregadores das suítes fazem, em sequência síncrona,
   * `readFileSync(<arquivo>.ts)` → `ts.transpileModule` → `new Function(...)`/`vm.*`. O último .ts lido (consumido uma vez)
   * é o candidato; só vira identidade se TODOS os nomes exportados no .ts aparecem no JS (impressão digital) — senão o
   * código segue sem identidade e seus quadros ficam INDETERMINADO (reprova). A identidade é um `//# sourceURL=` no fim do
   * código; as linhas reportadas são as do JS transpilado.
   */
  function identificarModulosTranspilados() {
    const { pathToFileURL, fileURLToPath } = require("node:url");
    const vm = require("node:vm");
    let pendente = null;
    const ler = fs.readFileSync;
    fs.readFileSync = function (alvo, ...resto) {
      const v = ler.call(this, alvo, ...resto);
      try {
        const s = typeof alvo === "string" ? alvo : alvo instanceof URL ? fileURLToPath(alvo) : null;
        if (s && /\.(c|m)?tsx?$/.test(s) && typeof v === "string") pendente = { arquivo: path.resolve(s), fonte: v };
      } catch { /* leitura segue intacta */ }
      return v;
    };
    const nomesExportados = (ts) => [...ts.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    function identidade(codigo) {
      if (typeof codigo !== "string" || /\/\/# sourceURL=/.test(codigo) || !pendente) return codigo;
      const { arquivo, fonte } = pendente;
      pendente = null;
      const nomes = nomesExportados(fonte);
      if (!nomes.length || !nomes.every((n) => codigo.includes(n))) return codigo;
      return `${codigo}\n//# sourceURL=${pathToFileURL(arquivo).href}\n`;
    }
    const FunctionOriginal = Function;
    const comIdentidade = (args) => (args.length ? [...args.slice(0, -1), identidade(String(args[args.length - 1]))] : args);
    globalThis.Function = new Proxy(FunctionOriginal, {
      construct: (alvo, args, novo) => Reflect.construct(alvo, comIdentidade(args), novo === globalThis.Function ? alvo : novo),
      apply: (alvo, este, args) => Reflect.apply(alvo, este, comIdentidade(args)),
    });
    for (const nome of ["runInNewContext", "runInThisContext", "runInContext"]) {
      const original = vm[nome];
      vm[nome] = function (codigo, ...resto) { return original.call(this, identidade(codigo), ...resto); };
    }
    const compilar = vm.compileFunction;
    vm.compileFunction = function (codigo, ...resto) { return compilar.call(this, identidade(codigo), ...resto); };
    const Script = vm.Script;
    vm.Script = class extends Script { constructor(codigo, ...resto) { super(identidade(codigo), ...resto); } };
    require("node:module").syncBuiltinESMExports();
  }

  const RE_INICIO = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
  const RE_FIM = /^\s*(COMMIT|END|ROLLBACK)\b(?!\s+TO\b)/i;
  const classificar = classificarComando;

  function fecharTransacao(cliente, desfecho) {
    const t = cliente.__guardaTx;
    cliente.__guardaTx = null;
    if (!t) return;
    if (transacoesNoArquivo) registrar({ tipo: "TRANSACAO", desfecho, todos: t.todos });
    if (guardarTransacoes) transacoes.push({ desfecho, comandos: t.comandos.map(({ classe, texto, origem }) => ({ classe, texto, origem })) });
    // Rodada 2 (P2 do Astra): AGENDA **ou** LINHA. Uma transação só com DML/trava de linha nas tabelas inventariadas
    // (ex.: UPDATE fechamentos SET status) também exige a configuração antes; antes ela saía sem avaliação.
    const primeira = t.comandos.findIndex((c) => c.classe === "AGENDA" || c.classe === "LINHA");
    if (primeira < 0) return;
    const config = t.comandos.findIndex((c) => c.classe === "CONFIG");
    if (config >= 0 && config < primeira) {
      // Cobertura do D'' (inventário por entrada): quem tomou a configuração antes da primeira trava, em produção.
      if (cobertura) registrar({ tipo: "ORDEM_OK", quadros: quadrosDeProducao(t.comandos[config].erro), desfecho });
      return;
    }
    const c = t.comandos[primeira];
    const origem = origemDe(c.erro);
    const emissor = emissorDe(c.erro);
    registrar({ tipo: "ORDEM", producao: reprova(emissor), emissor, origem, pilha: pilhaDe(c.erro),
      motivo: config < 0 ? `${c.classe} sem a configuração: ${c.texto}` : `${c.classe} antes da configuração: ${c.texto}` });
  }

  const textoDe = (a) => (typeof a === "string" ? a : a && typeof a.text === "string" ? a.text : "");

  const conectar = pg.Client.prototype.connect;
  pg.Client.prototype.connect = function (...args) {
    if (!this.__guardaOuvindo) {
      this.__guardaOuvindo = true;
      this.on("notice", (n) => {
        const e = eventoDaMensagem(n?.message);
        if (e) registrar({ ...e, origem: this.activeQuery?.__guardaOrigem ? origemDe(this.activeQuery.__guardaOrigem) : "desconhecida" });
      });
    }
    return conectar.apply(this, args);
  };

  const consultar = pg.Client.prototype.query;
  pg.Client.prototype.query = function (config, ...resto) {
    const texto = textoDe(config);
    const pilha = new Error();
    if (RE_INICIO.test(texto)) this.__guardaTx = { comandos: [], todos: [texto.replace(/\s+/g, " ").trim().slice(0, 200)] };
    else if (this.__guardaTx) {
      this.__guardaTx.todos.push(texto.replace(/\s+/g, " ").trim().slice(0, 200));
      const classe = classificar(texto);
      if (classe) this.__guardaTx.comandos.push({ classe, texto: texto.replace(/\s+/g, " ").slice(0, 160), erro: pilha });
    } else {
      // Rodada 2: fora de transação explícita (autocommit) nenhuma trava de configuração pode valer para o comando;
      // com a 114 o gatilho recusaria. AGENDA/LINHA aqui é sempre ORDEM.
      const classe = classificar(texto);
      if (classe === "AGENDA" || classe === "LINHA") {
        const origem = origemDe(pilha);
        const emissor = emissorDe(pilha);
        registrar({ tipo: "ORDEM", producao: reprova(emissor), emissor, origem, autocommit: true, pilha: pilhaDe(pilha),
          motivo: `${classe} fora de transação (sem a configuração): ${texto.replace(/\s+/g, " ").slice(0, 160)}` });
      }
    }
    if (RE_FIM.test(texto)) fecharTransacao(this, texto.trim().split(/\s+/)[0].toUpperCase());
    // Callback: o KD901 também é registrado (e repassado intacto).
    const ultimo = resto.at(-1);
    if (typeof ultimo === "function") {
      resto[resto.length - 1] = (erro, ...r) => { if (erro?.code === "KD901") registrar({ tipo: "KD901", mensagem: erro.message, origem: origemDe(pilha) }); return ultimo(erro, ...r); };
    }
    const r = consultar.call(this, config, ...resto);
    const q = this.queryQueue?.at(-1) ?? this.activeQuery;
    if (q && typeof q === "object") q.__guardaOrigem = pilha;
    if (r && typeof r.then === "function") r.then(undefined, (erro) => { if (erro?.code === "KD901") registrar({ tipo: "KD901", mensagem: erro.message, origem: origemDe(pilha) }); });
    return r;
  };
}
