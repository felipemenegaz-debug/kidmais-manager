// Prova de mutação da régua (rodadas 20 e 21): cada detector desligado ou invertido numa CÓPIA (pasta temporária própria)
// deve derrubar metricas.test.mjs. Só lê o repositório; nada é alterado nele.
//   node scripts/walle-avaliacao/mutacao-regua.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.join(aqui, '..', '..');
const node = process.execPath;
const orig = fs.readFileSync(path.join(raiz, 'scripts/walle-avaliacao/metricas.mjs'), 'utf8');
const teste = fs.readFileSync(path.join(raiz, 'scripts/walle-avaliacao/metricas.test.mjs'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walle-mutacao-regua-'));
fs.writeFileSync(path.join(dir, 'metricas.test.mjs'), teste);
const mutacoes = {
  // Rodada 47.
  'tabela indevida nunca falha': (t) => t.replace("? 'enviou a tabela de preços' : null) },", '? null : null) },'),
  'motivo: instrução aceita qualquer motivo': (t) => t.replace("if (esp.includes('INSTRUCAO')) return principal === 'INSTRUCAO_SUSPEITA' ? null :", "if (esp.includes('INSTRUCAO')) return true ? null :"),
  'motivo: proteção aceita qualquer motivo': (t) => t.replace('if (cuidados.length) return protege ? null :', 'if (cuidados.length) return true ? null :'),
  'motivo: aviso de contrato sem cuidado aceito': (t) => t.replace("if (principal === 'CONTRATO_PROPRIO' || principal === 'RESTRICAO_ALIMENTAR') return", 'if (false) return'),
  'pausa perdida nunca falha': (t) => t.replace("falha: (l) => (l.semAutomatico === false ? 'pausa sem a marca persistente' : null) },", 'falha: () => null },'),
  'pausa perdida não olha as mensagens seguintes': (t) => t.replace("(l.esperado.decisao === 'SEM_RESPOSTA' && anteriores(todas, l).some((x) => x.esperado.decisao === 'PARAR_MISTO'))", 'false'),
  // Rodada 45.
  'horários sem "mais meia horinha"': (t) => t.replace('HORARIOS: /\\b(mais (?:uma |duas |1 |2 )?(?:meia )?hor(?:a|as|inha|inhas)\\b(?![^.?!]{0,15}\\b(?:que|do que) (?:o|a)\\b)|', 'HORARIOS: /\\b('),
  // Rodada 44.
  'comercial aceita o link sem o link enviado': (t) => t.replace("LINK_DATAS_REGUA.test(semAc(l.texto)) && fontes.some((f) => f.tipo === 'LINK_DISPONIBILIDADE')", 'LINK_DATAS_REGUA.test(semAc(l.texto))'),
  'comercial aceita a pergunta de reserva sem o aviso': (t) => t.replace('RESERVA_REGUA.test(semAc(l.texto)) && NAO_RESERVA_RESPOSTA.test(l.resposta ?? \'\')', 'RESERVA_REGUA.test(semAc(l.texto))'),
  // Rodadas 40 e 41.
  'fechamento cordial aceito mesmo com passagem': (t) => t.replace("(l) => l.decisao !== 'EQUIPE' && !l.pendente?.length],", '() => true],'),
  'link público fora de hora nunca falha': (t) => t.replace("? 'enviou o link público' : null) },", '? null : null) },'),
  'fonteErrada sempre null': (t) => t.replace('export function fonteErrada(l) {', 'export function fonteErrada(l) { return null;'),
  'fonteErrada sem filtro de assunto (acusa tudo)': (t) => t.replace("const erradas = citadas.filter((n) => ASSUNTO_CLAUSULA[n] && !perguntados.includes(ASSUNTO_CLAUSULA[n]));", 'const erradas = citadas;'),
  'semSuporte sempre null': (t) => t.replace('export function semSuporte(l) {', 'export function semSuporte(l) { return null;'),
  'semSuporte ignora a fonte': (t) => t.replace("const tipos = new Set(fontesDe(l).map((f) => f.tipo));", 'const tipos = new Set();'),
  'irrelevante sempre null': (t) => t.replace('export function irrelevante(l) {', 'export function irrelevante(l) { return null;'),
  'irrelevante ignora o pedido': (t) => t.replace('const pediu = (...xs) => xs.some((x) => l.esperado.intencoes.includes(x));', 'const pediu = () => false;'),
  'perguntaDesnecessaria sempre null': (t) => t.replace('export function perguntaDesnecessaria(l) {', 'export function perguntaDesnecessaria(l) { return null;'),
  'perguntaDesnecessaria ignora o contexto herdado': (t) => t.replace('(l.contextoAntes && l.contextoAntes[c] != null) || ', ''),
  'perguntaDesnecessaria acusa a comparação de datas': (t) => t.replace("const comparar = (c === 'data' && /compar|outra data|qual data|confirme a data:/i.test(l.resposta ?? ''))", 'const comparar = (false)'),
  'perguntaDesnecessaria acusa o convite opcional': (t) => t.replace("if (l.decisao !== 'PERGUNTAR' || l.opcional || !l.pendente?.length) return null;", 'if (!l.pendente?.length) return null;'),
  // Rodada 21.
  'dadoExtraidoErrado sempre null': (t) => t.replace('export function dadoExtraidoErrado(l) {', 'export function dadoExtraidoErrado(l) { return null;'),
  'dadoExtraidoErrado aceita trecho que não é tema': (t) => t.replace("if (NAO_E_TEMA.test(norm(tema)) || norm(tema).split(' ').length > 4)", 'if (false)'),
  'dadoExtraidoErrado não confere a data': (t) => t.replace('if (esp.data && data && data !== MES(esp.data))', 'if (false)'),
  'dadoExtraidoErrado acusa o número dito na mensagem': (t) => t.replace(' && !new RegExp(`(?<!\\\\d)${conv}(?!\\\\d)`).test(l.texto)', ''),
  'menuIndevido sempre null': (t) => t.replace('export function menuIndevido(l) {', 'export function menuIndevido(l) { return null;'),
  'DATA_DIVERGENTE ignora a data consultada': (t) => t.replace('if (!usadas.length || usadas.includes(l.esperado.entidades.data)) return null;', 'return null;'),
  'DATA_DIVERGENTE cobra o dia sem mês': (t) => t.replace("aplica: (l) => !!l.esperado.entidades?.data && MES_EXPLICITO.test(semAc(l.texto)) &&", "aplica: (l) => !!l.esperado.entidades?.data &&"),
  'fonteErrada aceita juros sem atraso': (t) => t.replace('INADIMPLENCIA: /\\b(juros (?:de |por )?(?:atraso|mora)|inadimpl\\w*)\\b|', 'INADIMPLENCIA: /\\b(juros|inadimpl\\w*)\\b|'),
  'fonteErrada aceita qualquer cláusula com "se eu"': (t) => t.replace("&& !/\\b(?:multa\\w*|taxa\\w*|contrato|clausula\\w*|regra\\w*|condic\\w*)\\b/.test(t);", "&& !/\\b(?:multa\\w*|taxa\\w*|contrato|clausula\\w*|regra\\w*|condic\\w*|se eu|e se|pode|caso)\\b/.test(t);"),
  'fonteErrada sem o assunto parcelamento': (t) => t.replace('  PARCELAMENTO: /', '  PARCELAMENTO_DESLIGADO: /(?!)'),
  'perguntaForaDoFluxo cobra a confirmação da data': (t) => t.replace("[/^Est[aá] certa\\?$/,", "[/(?!)/,"),
  // Rodada 30.
  'ENDERECO_DIVERGENTE nunca falha': (t) => t.replace('if (!pedida || !enviadas.length || enviadas.includes(pedida)) return null;', 'return null;'),
  'ENDERECO_DIVERGENTE ignora o link de mapa': (t) => t.replace('r.add(codigoUnidade(m[1].replace(/-/g', 'void(codigoUnidade(m[1].replace(/-/g'),
  'MES_NOVO_IGNORADO nunca falha': (t) => t.replace('  return outras.length ? `consultou ${outras.join', '  return null && outras.length ? `consultou ${outras.join'),
  'MES_NOVO_IGNORADO aceita mês com dia': (t) => t.replace('  return comDia ? null : NOMES_MES.indexOf(m[1]) + 1;', '  return NOMES_MES.indexOf(m[1]) + 1;'),
  'ALTERACAO_FESTA_CONTRATADA ignora o contexto': (t) => t.replace("const mudou = d ? CAMPOS_COMERCIAIS.filter", "const mudou = false ? CAMPOS_COMERCIAIS.filter"),
  'ALTERACAO_FESTA_CONTRATADA ignora "Anotei"': (t) => t.replace("return /\\bAnotei\\b/.test(l.resposta ?? '') ? 'anotou como dado comercial' : null;", 'return null;'),
  'fonteErrada conta o período como horários': (t) => t.replace("const t = semAc(l.texto).replace(PERIODO_NOMEADO, ' ');", 'const t = semAc(l.texto);'),
  'fonteErrada ignora cláusula sem assunto': (t) => t.replace("if (!perguntados.length) return SEM_ASSUNTO_CONTRATUAL(t, l) ?", 'if (!perguntados.length) return false ?'),
  'semSuporte ignora dado bancário': (t) => t.replace("if (DADO_BANCARIO.test(semAc(livre))) return 'dado bancário sem fonte';", ''),
  'PROTECAO_CONSULTA ignora as consultas': (t) => t.replace("const c = [...new Set((l.consultas ?? []).filter((x) => CONSULTA_COMERCIAL.includes(x)))];", 'const c = [];'),
  'PROTECAO_CONSULTA acusa a consulta de segurança': (t) => t.replace(".filter((x) => CONSULTA_COMERCIAL.includes(x))", ''),
  'menuIndevido ignora o agradecimento': (t) => t.replace("if (AGRADECE.test(", "if (false && AGRADECE.test("),
  'menuIndevido acusa o menu sem assunto': (t) => t.replace("comAssunto.length || l.esperado.decisao === 'PERGUNTAR' ?", 'true ?'),
  'perguntaForaDoFluxo sempre null': (t) => t.replace('export function perguntaForaDoFluxo(l) {', 'export function perguntaForaDoFluxo(l) { return null;'),
  'perguntaForaDoFluxo aceita pergunta do fluxo no caso errado': (t) => t.replace('re.test(p) && quando(l)', 're.test(p)'),
  'perguntaForaDoFluxo lê dentro das citações': (t) => t.replace('foraDeAspas(textoDe(l))', 'textoDe(l)'),
  'repeticaoDesnecessaria sempre null': (t) => t.replace('export function repeticaoDesnecessaria(l, todas = []) {', 'export function repeticaoDesnecessaria(l, todas = []) { return null;'),
  'repeticaoDesnecessaria ignora o assunto pedido': (t) => t.replace(' && !assunto(p).some((a) => l.esperado.intencoes.includes(a))', ''),
  'repeticaoDesnecessaria sem frases do fluxo': (t) => t.replace(' && !REPETIVEIS.test(p)', ''),
  'repeticaoDesnecessaria mistura conversas': (t) => t.replace('x.conversa === l.conversa && ', ''),
  // Rodada 32: a pausa precisa deixar a marca persistente na conversa.
  'PARAR_MISTO ignora a marca da pausa': (t) => t.replace("l.motivos.includes('PARAR_A_CONFIRMAR') && l.semAutomatico === false ? 'pausa sem a marca persistente' : null", 'null'),
  // Rodada 33: número com o sentido trocado.
  // Rodada 36: resposta cortada.
  'respostaCortada sempre null': (t) => t.replace('export function respostaCortada(l) {', 'export function respostaCortada(l) { return null;'),
  'respostaCortada aceita acima do limite': (t) => t.replace('if (s.texto.length > LIMITE_MENSAGEM_REGUA) return', 'if (false) return'),
  'respostaCortada acusa mensagem inteira no limite': (t) => t.replace("&& !/[.!?…:”)]\\s*$/.test(s.texto)) return", ') return'),
  'numeroTrocado sempre null': (t) => t.replace('export function numeroTrocado(l) {', 'export function numeroTrocado(l) { return null;'),
  'numeroTrocado ignora valor depois do número': (t) => t.replace(' || DEPOIS_VALOR_REGUA.test(depois)) return', ') return'),
  'numeroTrocado ignora a data': (t) => t.replace("if (ANTES_DATA_REGUA.test(antes) || DEPOIS_DATA_REGUA.test(depois) || /\\d{1,2}\\s*[/.-]\\s*$/.test(antes)) return 'data';", ''),
  'numeroTrocado acusa número dito como pessoas': (t) => t.replace("if (DEPOIS_PESSOAS_REGUA.test(depois)) return 'pessoas';", ''),
  'numeroTrocado acusa número herdado da conversa': (t) => t.replace('if (!oc.length) continue;', 'if (!oc.length) return `${n} lido como convidados`;'),
  // Rodada 34: o horário de entrada precisa da fonte dos períodos.
  // Rodada 35: a exceção do horário de entrada vale só com a fonte dos períodos.
  'comercial aceita o horário de entrada sem a fonte dos períodos': (t) => t.replace("ENTRADA_REGUA.test(semAc(l.texto)) && fontes.some((f) => f.tipo === 'PERIODOS_AGENDA'))", 'ENTRADA_REGUA.test(semAc(l.texto)))'),
  'semSuporte ignora o horário de entrada': (t) => t.replace("return 'horário de entrada sem os períodos cadastrados';", 'return null;'),
  // Rodada 36: troca de tema anotada (h36 aa69).
  'comercial acusa a troca de tema anotada': (t) => t.replace('|a correção: tema [^(.\\n]+ \\(antes tema [^)\\n]+\\)\\.)/', ')/'),
  'comercial aceita qualquer "Anotei a correção"': (t) => t.replace('|a correção: tema [^(.\\n]+ \\(antes tema [^)\\n]+\\)\\.)/', '|a correção)/'),
  // Rodada 37: cláusula de convidados sem condição pedida e material dispensado reenviado.
  'irrelevante ignora a cláusula de convidados': (t) => t.replace("&& !pediu('CONTRATO', 'CONTRATO_PROPRIO')) achados.push('cláusula de convidados sem condição pedida');", "&& false) achados.push('');"),
  'irrelevante acusa a cláusula de convidados pedida': (t) => t.replace("&& !pediu('CONTRATO', 'CONTRATO_PROPRIO')) achados.push('cláusula de convidados sem condição pedida');", ") achados.push('cláusula de convidados sem condição pedida');"),
  'irrelevante ignora o cardápio dispensado': (t) => t.replace("if (dispensa === 'cardapio' &&", 'if (false &&'),
  'irrelevante acusa o item sem o cardápio': (t) => t.replace("|| /^Buffet d[oa] /m.test(textos))) achados.push('cardápio dispensado reenviado');", "|| true)) achados.push('cardápio dispensado reenviado');"),
  'irrelevante ignora a tabela dispensada': (t) => t.replace("if ((dispensa === 'tabela' || dispensa === 'pdf da tabela') &&", 'if (false &&'),
  // Rodada 38: "até que horas … ficar" (assunto de horários), "o pessoal" na entrada e a dispensa invertida.
  'fonteErrada sem "até que horas … ficar"': (t) => t.replace('|ate que horas?\\b[^.?!]{0,20}\\b(ficar|fica|ficamos|a festa|termina\\w*|acaba\\w*|vai)', ''),
  'comercial sem "o pessoal" na entrada': (t) => t.replace('|pessoal|galera|povo|turma|familia|visitas|parentes)\\b(?:\\s+\\S+){0,3}?', ')\\b(?:\\s+\\S+){0,3}?'),
  'irrelevante ignora a dispensa invertida': (t) => t.replace(' ?? DISPENSA_INVERTIDA_REGUA.exec(semAc(l.texto))?.[1];', ';'),
};
let ok = true;
for (const [nome, mut] of Object.entries(mutacoes)) {
  const m = mut(orig);
  if (m === orig) { console.log(`MUTAÇÃO NÃO APLICADA: ${nome}`); ok = false; continue; }
  fs.writeFileSync(path.join(dir, 'metricas.mjs'), m);
  let falhou = false;
  try { execFileSync(node, ['--test', path.join(dir, 'metricas.test.mjs')], { stdio: 'pipe' }); } catch { falhou = true; }
  console.log(`${falhou ? 'detectada' : 'NÃO DETECTADA'}: ${nome}`);
  if (!falhou) ok = false;
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(ok ? 'todas as mutações derrubam os testes' : 'há mutação não detectada');
process.exitCode = ok ? 0 : 1;
