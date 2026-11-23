import { createHash } from 'node:crypto';
import type { DbExecutor } from '../../../db/contracts.ts';
import type { MotivoPassagem, ResultadoWallE, TipoIntencao } from './tipos.ts';

/**
 * Wall-e fatia 1a (LOCAL 23/11/2026; D-WA-2 e D-WA-3 de Felipe; desenho em orquestracao/loop/walle-funil-1a-20261123).
 * Conversa com pedido de festa NOVA vira (ou atualiza) um cartão em "Novo contato" do funil (marketing_contatos, canal
 * WHATSAPP), com o vínculo na 132 (whatsapp_atendimento_oportunidades).
 *
 * - O modelo só classifica: a qualificação lê códigos e entidades validados, nunca grava texto do cliente no cartão.
 * - A resposta grava a MARCA (oportunidade_pendente_em) na mesma instrução que grava a memória da conversa (r2): a marca só
 *   se perde se a resposta inteira for desfeita. O cartão é gravado depois, ao fim do lote do worker, em transação própria
 *   por conversa; falha na captura nunca impede nem atrasa a resposta, e a conversa que falhou é adiada (não trava a fila).
 * - Um cartão ABERTO por telefone (empresa e ambiente), sob a trava consultiva por telefone que o registro manual e o site
 *   também tomam (lib/marketing/contatos.ts); cartão novo só depois de o anterior fechar.
 * - Nenhuma atribuição, evento de histórico, autorização de contato ou automação de Marketing é criada (1b).
 * Dependências mínimas (só tipos e node:crypto): as provas em PG montam este módulo dentro do worker e da privacidade.
 */

/** Intenções que, sozinhas, já são pedido de festa nova. */
const INTENCOES_PEDIDO: readonly TipoIntencao[] = ['PRECOS', 'DISPONIBILIDADE', 'PACOTES', 'CONTRATAR'];
/** Intenções que afastam o cartão: contrato já existente, pedido de parar ou fora do assunto. */
const INTENCOES_BLOQUEIAM: readonly TipoIntencao[] = ['CONTRATO_PROPRIO', 'PARAR', 'EXTERNO'];
/** Passagens que não são pedido de festa nova (suporte a contrato, pagamento, reclamação, instrução, parar). */
const PASSAGENS_BLOQUEIAM: readonly MotivoPassagem[] = ['CONTRATO_PROPRIO', 'PAGAMENTO', 'RECLAMACAO', 'INSTRUCAO_SUSPEITA', 'PARAR_A_CONFIRMAR', 'BLOQUEADO_A_PEDIDO'];
/** Estados de negociação que ainda estão no funil (os mesmos de lib/oportunidades/consultas.ts). */
export const FECHAMENTO_ABERTO = ['RASCUNHO', 'AGUARDANDO_APROVACAO', 'APROVADO', 'AGUARDANDO_CONTRATO', 'CONTRATO_ASSINADO', 'AGUARDANDO_PAGAMENTO'] as const;
export const NOME_ANONIMIZADO = 'Contato anonimizado';
export const TELEFONE_ANONIMIZADO = '0000000000';
/** Espera antes de tentar de novo uma conversa cuja captura falhou (as outras seguem no mesmo lote). */
export const ESPERA_PADRAO_SEGUNDOS = 300;

/** D-WA-2: só pedido de festa NOVA (data, convidados, orçamento ou visita) qualifica. Função pura, sem banco. */
export function qualificaPedidoFesta(resultado: Pick<ResultadoWallE, 'contexto' | 'passagem' | 'parar' | 'silencio'>): boolean {
  if (resultado.parar || resultado.silencio) return false;
  const e = resultado.contexto?.ultimoEntendimento;
  if (!e) return false;
  if (e.parar || e.sinais?.pagamento || e.sinais?.pagamentoAcao || e.sinais?.reclamacao || e.sinais?.instrucao) return false;
  const tipos = (e.intencoes ?? []).map(i => i.tipo);
  if (tipos.some(t => INTENCOES_BLOQUEIAM.includes(t))) return false;
  const motivos = [resultado.passagem?.motivo, ...(resultado.passagem?.motivos ?? [])].filter(Boolean) as MotivoPassagem[];
  if (motivos.some(m => PASSAGENS_BLOQUEIAM.includes(m))) return false;
  if (tipos.some(t => INTENCOES_PEDIDO.includes(t))) return true;
  if ((e.intencoes ?? []).some(i => i.consultaComum === 'ORCAMENTO_INFORMADO' || i.consultaComum === 'VISITA_MARCADA')) return true;
  return !!e.entidades?.data || (typeof e.entidades?.convidados === 'number' && e.entidades.convidados > 0);
}

/**
 * Nome do cartão: o nome de perfil do WhatsApp higienizado (rótulo NÃO verificado na tela): controles, formatação
 * invisível e espaços extras fora, até 120 caracteres. Sem nome útil (ausente ou com menos de 2 caracteres):
 * "WhatsApp final NNNN".
 */
export function nomeDoCartao(perfil: unknown, telefone: string): string {
  const limpo = typeof perfil === 'string' ? perfil.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim() : '';
  const cortado = [...limpo].slice(0, 120).join('').trim();
  return [...cortado].length >= 2 ? cortado : `WhatsApp final ${telefone.replace(/\D/g, '').slice(-4)}`;
}

/** Telefone com e sem o DDI 55 (a mesma regra de lib/marketing/contatos.ts variantesTelefone; paridade em teste). */
export function variantesDoTelefone(digitos: string): string[] {
  const v = new Set([digitos]);
  if (/^55\d{10,11}$/.test(digitos)) v.add(digitos.slice(2));
  if (/^\d{10,11}$/.test(digitos)) v.add(`55${digitos}`);
  return [...v];
}
/**
 * Trava consultiva do telefone no funil, por empresa (sem ambiente; com e sem 55 caem na mesma). A MESMA chave de
 * lib/marketing/contatos.ts (site e registro manual; paridade em teste): a captura nunca decide "não há cartão aberto"
 * enquanto outra origem grava um cartão do mesmo telefone.
 */
export function chaveTravaTelefone(empresaId: string, digitos: string) {
  return `funil-telefone|${empresaId}|${/^55\d{10,11}$/.test(digitos) ? digitos.slice(2) : digitos}`;
}
/**
 * Chave de idempotência do cartão: a conversa e o instante da MARCA que o pediu (durável: reentrega e corrida da mesma
 * marca não duplicam; marca nova, inclusive depois de desfazer e reaplicar a 132, nunca reaproveita chave antiga).
 */
export function chaveDoCartao(empresa: string, ambiente: string, conversa: string, marca: string) {
  return `wa${createHash('sha256').update(`${empresa}|${ambiente}|${conversa}|${marca}`).digest('hex').slice(0, 40)}`;
}

/** Trecho da instrução da resposta que grava a memória da conversa (worker): marca quando o 6º parâmetro é verdadeiro. */
export const SQL_MARCA_PENDENTE = ',oportunidade_pendente_em=CASE WHEN $6::boolean THEN clock_timestamp() ELSE oportunidade_pendente_em END';
/** A coluna da marca chega com a 132; sem ela (ou depois do rollback) a resposta segue sem marcar. Catálogo a cada uso. */
export async function temMarcaPendente(tx: DbExecutor) {
  return !!(await tx.query<{ ok: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.whatsapp_atendimento_conversas')
    AND attname='oportunidade_pendente_em' AND NOT attisdropped) AS ok`)).rows[0]?.ok;
}

export type ResultadoCaptura = 'CRIADO' | 'ATUALIZADO' | 'SEM_MUDANCA' | 'JA_ABERTO' | 'IGNORADO' | 'SEM_PENDENCIA';
type ConversaCaptura = { id: string; empresa_id: string; ambiente: string; contato: string; interesse: { data?: unknown; convidados?: unknown } | null;
  nome_perfil?: string | null; oportunidade_pendente_em: string | null };

function dataValida(v: unknown) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) ? v : null; }
function convidadosValidos(v: unknown) { const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : NaN; return Number.isInteger(n) && n >= 1 && n <= 5000 ? n : null; }
function travarTelefone(tx: DbExecutor, empresaId: string, digitos: string) {
  return tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [chaveTravaTelefone(empresaId, digitos)]);
}
/**
 * r5 (P1): a captura grava o cartão e o vínculo, cuja chave estrangeira pede FOR KEY SHARE na linha da empresa. A exclusão
 * a pedido roda no Tenant Context, que trava a empresa (FOR UPDATE) ANTES da conversa. Tomando a empresa primeiro, aqui
 * também, a ordem é a mesma (empresa → conversa → telefone → cartões): sem impasse.
 */
function travarEmpresa(tx: DbExecutor, empresaId: string) {
  return tx.query('SELECT id FROM empresas WHERE id=$1 FOR KEY SHARE', [empresaId]);
}

/**
 * Captura de UMA conversa marcada, na transação de quem chama (uma por conversa). A empresa é travada primeiro (r5) e só
 * então a conversa (SKIP LOCKED: outra captura ou o worker com ela = tenta no próximo lote), com a pendência conferida de
 * novo sob a trava. Sucesso ou descarte limpam a marca na mesma transação.
 */
export async function capturarOportunidade(tx: DbExecutor, conversaId: string, esperado?: { empresaId: string; ambiente: string }): Promise<ResultadoCaptura> {
  const escopo = esperado ?? (await tx.query<{ empresaId: string; ambiente: string }>('SELECT empresa_id::text AS "empresaId", ambiente FROM whatsapp_atendimento_conversas WHERE id=$1', [conversaId])).rows[0];
  if (!escopo) return 'SEM_PENDENCIA';
  await travarEmpresa(tx, escopo.empresaId);
  // r6 (P2-1): a releitura sob a trava confirma o escopo que levou à trava da empresa (empresa e ambiente esperados);
  // qualquer diferença = SEM_PENDENCIA, nada gravado.
  const linha = (await tx.query<{ c: ConversaCaptura }>(`SELECT to_jsonb(c) AS c FROM whatsapp_atendimento_conversas c WHERE c.id=$1 AND c.empresa_id=$2 AND c.ambiente=$3
     AND c.oportunidade_pendente_em IS NOT NULL FOR UPDATE SKIP LOCKED`, [conversaId, escopo.empresaId, escopo.ambiente])).rows[0];
  if (!linha) return 'SEM_PENDENCIA';
  const c = linha.c;
  const limpar = () => tx.query('UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=NULL WHERE id=$1', [c.id]);
  // Número fora do formato do funil nunca vira cartão.
  if (!/^[0-9]{10,15}$/.test(c.contato)) { await limpar(); return 'IGNORADO'; }
  const variantes = variantesDoTelefone(c.contato);
  await travarTelefone(tx, c.empresa_id, c.contato);
  // nao_contatar ou pausa em QUALQUER variante do número (com e sem 55), na conversa ou nos controles guardados depois de
  // uma exclusão (nao_contatar ou sem_automatico preservados, r3), na mesma empresa e ambiente: nunca vira cartão.
  const bloqueado = (await tx.query(`SELECT 1 FROM whatsapp_atendimento_conversas WHERE empresa_id=$1 AND ambiente=$2 AND contato = ANY($3::text[])
       AND (nao_contatar OR jsonb_typeof(contexto->'semAutomatico')='object')
     UNION ALL SELECT 1 FROM whatsapp_atendimento_controles_contato WHERE empresa_id=$1 AND ambiente=$2 AND contato = ANY($3::text[]) AND (nao_contatar OR sem_automatico)
     LIMIT 1`, [c.empresa_id, c.ambiente, variantes])).rows.length > 0;
  if (bloqueado) { await limpar(); return 'IGNORADO'; }
  const data = dataValida(c.interesse?.data), convidados = convidadosValidos(c.interesse?.convidados);
  // Cartões abertos de qualquer origem: contato em aberto sem negociação, ou contato com negociação aberta (cartões do Wall-e
  // de outro ambiente e anonimizados não contam). Todos travados (FOR UPDATE, sem LIMIT): a equipe que fecha um cartão agora
  // é esperada e a condição é conferida de novo sobre a versão confirmada.
  const abertos = (await tx.query<{ id: string; walle: boolean; novo_contato: boolean; data: string | null; convidados: number | null }>(
    `SELECT k.id, o.contato_id IS NOT NULL AS walle, (k.fechamento_id IS NULL AND k.status IN ('NOVO','EM_ATENDIMENTO')) AS novo_contato,
       k.data_desejada::text AS data, k.convidados
     FROM marketing_contatos k LEFT JOIN whatsapp_atendimento_oportunidades o ON o.contato_id=k.id
     WHERE k.empresa_id=$1 AND k.telefone = ANY($2::text[]) AND (o.contato_id IS NULL OR (o.ambiente=$3 AND o.anonimizado_em IS NULL))
       AND ((k.fechamento_id IS NULL AND k.status IN ('NOVO','EM_ATENDIMENTO'))
         OR EXISTS (SELECT 1 FROM fechamentos f WHERE f.empresa_id=k.empresa_id AND f.id=k.fechamento_id AND f.status = ANY($4::text[])))
     ORDER BY (o.conversa_id = $5::uuid) DESC NULLS LAST, k.recebido_em DESC, k.id FOR UPDATE OF k`, [c.empresa_id, variantes, c.ambiente, FECHAMENTO_ABERTO, c.id])).rows;
  const aberto = abertos[0];
  if (aberto) {
    // Só o cartão do Wall-e ainda em "Novo contato" é atualizado; cartão do site, manual ou em negociação é da equipe.
    if (aberto.walle && aberto.novo_contato && ((data && data !== aberto.data) || (convidados && convidados !== aberto.convidados))) {
      const r = await tx.query(`UPDATE marketing_contatos SET data_desejada=COALESCE($2::date,data_desejada),convidados=COALESCE($3::int,convidados),atualizado_em=clock_timestamp()
        WHERE id=$1 AND empresa_id=$4 AND status IN ('NOVO','EM_ATENDIMENTO') AND fechamento_id IS NULL RETURNING id`, [aberto.id, data, convidados, c.empresa_id]);
      if (r.rows.length) { await limpar(); return 'ATUALIZADO'; }
    }
    await limpar(); return aberto.walle && aberto.novo_contato ? 'SEM_MUDANCA' : 'JA_ABERTO';
  }
  // Negociação aberta de cliente com este telefone (sem contato do funil): também é cartão aberto.
  const negociacao = (await tx.query(`SELECT 1 FROM fechamentos f JOIN clientes cl ON cl.empresa_id=f.empresa_id AND cl.id=f.cliente_id
     WHERE f.empresa_id=$1 AND f.status = ANY($3::text[]) AND cl.status <> 'MESCLADO' AND (cl.telefone = ANY($2::text[]) OR cl.whatsapp = ANY($2::text[])) LIMIT 1`,
    [c.empresa_id, variantes, FECHAMENTO_ABERTO])).rows.length > 0;
  if (negociacao) { await limpar(); return 'JA_ABERTO'; }
  // Cliente só com correspondência ÚNICA de cliente ATIVO (nunca cria cadastro).
  const clientes = (await tx.query<{ id: string }>(`SELECT DISTINCT id::text FROM clientes WHERE empresa_id=$1 AND status='ATIVO'
     AND (telefone = ANY($2::text[]) OR whatsapp = ANY($2::text[])) LIMIT 2`, [c.empresa_id, variantes])).rows;
  const clienteId = clientes.length === 1 ? clientes[0].id : null;
  const chave = chaveDoCartao(c.empresa_id, c.ambiente, c.id, String(c.oportunidade_pendente_em));
  const criado = (await tx.query<{ id: string }>(`INSERT INTO marketing_contatos(empresa_id,cliente_id,canal_atendimento,nome,telefone,data_desejada,convidados,chave_idempotencia,vinculo_cliente,status)
     VALUES($1,$2,'WHATSAPP',$3,$4,$5::date,$6::int,$7,$8,'NOVO') ON CONFLICT (empresa_id, chave_idempotencia) DO NOTHING RETURNING id::text`,
    [c.empresa_id, clienteId, nomeDoCartao(c.nome_perfil, c.contato), c.contato, data, convidados, chave, clienteId ? 'EXISTENTE_CONTATO' : 'SEM_CLIENTE'])).rows[0];
  if (!criado) {
    // Só limpa quando a chave é do vínculo DESTA conversa; outro dono da chave = falha (a conversa é adiada e a marca nova
    // gera outra chave), nunca uma pendência apagada às cegas.
    const dono = (await tx.query<{ conversa: string | null }>(`SELECT o.conversa_id::text AS conversa FROM marketing_contatos k
       JOIN whatsapp_atendimento_oportunidades o ON o.contato_id=k.id AND o.empresa_id=k.empresa_id WHERE k.empresa_id=$1 AND k.chave_idempotencia=$2`, [c.empresa_id, chave])).rows[0];
    if (dono?.conversa === c.id) { await limpar(); return 'SEM_MUDANCA'; }
    throw new Error('OPORTUNIDADE_CHAVE_EM_USO');
  }
  await tx.query('INSERT INTO whatsapp_atendimento_oportunidades(contato_id,empresa_id,ambiente,conversa_id) VALUES($1,$2,$3,$4)', [criado.id, c.empresa_id, c.ambiente, c.id]);
  await limpar();
  return 'CRIADO';
}

export type Transacao = <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;
/** Código seguro de uma falha (nunca a mensagem, que pode carregar dado do banco). */
function codigoFalha(erro: unknown) {
  const e = erro as { code?: unknown; message?: unknown } | null;
  if (typeof e?.message === 'string' && /^OPORTUNIDADE_[A-Z_]+$/.test(e.message)) return e.message;
  return typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? `SQLSTATE_${e.code}` : 'ERRO_INTERNO';
}

/**
 * Recuperação independente: ao fim de cada lote do worker, até `limite` conversas VENCIDAS do ambiente, uma por vez, cada
 * uma escolhida e capturada na MESMA transação (FOR UPDATE SKIP LOCKED). A que falha é adiada em transação separada
 * (marca = agora + espera) e não volta neste lote: conversas que falham sempre não travam as outras. Sem a 132, nada.
 */
/**
 * r7 (P2-A): cursor por ambiente entre lotes (memória do processo), a última candidata vista (marca, id). O lote seguinte
 * começa depois dela e volta ao início quando a fila acaba: 50 pendências antigas presas por outras transações não
 * escondem a 51ª para sempre. Reiniciar o processo só volta a fila ao começo.
 */
const cursorDoLote = new Map<string, { marca: string; id: string }>();
export function reiniciarCursorOportunidades() { cursorDoLote.clear(); }

export async function capturarOportunidadesPendentes(transacao: Transacao, ambiente: string, opcoes: { limite?: number; esperaSegundos?: number; varredura?: number } = {}) {
  const limite = opcoes.limite ?? 10, espera = opcoes.esperaSegundos ?? ESPERA_PADRAO_SEGUNDOS;
  // r6 (P2-2): `limite` conta só as conversas TENTADAS de fato (captura ou falha); as que outra transação segura
  // (SEM_PENDENCIA) não gastam o limite, mas a varredura é limitada (`varredura` candidatas distintas, nunca repetidas):
  // 10 pendências antigas travadas não impedem a captura das seguintes.
  const varredura = Math.max(1, opcoes.varredura ?? limite * 5);
  const saida = { capturas: 0, adiadas: 0, falhas: [] as string[], resultados: [] as ResultadoCaptura[] };
  const vistas: string[] = [];
  let tentadas = 0, voltouAoInicio = false;
  while (tentadas < limite && vistas.length < varredura) {
    const vez: { id: string | null; marca: string | null; empresaId: string | null; fimDaFila?: boolean } = { id: null, marca: null, empresaId: null };
    try {
      const r = await transacao(async tx => {
        // r5 (P1): a candidata é escolhida SEM trava; a empresa é travada antes da conversa e a pendência vencida é
        // conferida de novo sob a trava da conversa (SKIP LOCKED: outra captura com ela = SEM_PENDENCIA, segue a próxima).
        const cursor = cursorDoLote.get(ambiente) ?? null;
        const candidata = (await tx.query<{ id: string; empresa_id: string; marca: string }>(`SELECT id::text, empresa_id::text, oportunidade_pendente_em::text AS marca
           FROM whatsapp_atendimento_conversas WHERE oportunidade_pendente_em <= clock_timestamp() AND ambiente=$1
           AND NOT (id = ANY($2::uuid[])) AND ($3::timestamptz IS NULL OR (oportunidade_pendente_em, id) > ($3::timestamptz, $4::uuid))
           ORDER BY oportunidade_pendente_em, id LIMIT 1`, [ambiente, vistas, cursor?.marca ?? null, cursor?.id ?? null])).rows[0];
        if (!candidata) { vez.fimDaFila = cursor !== null; return null; }
        cursorDoLote.set(ambiente, { marca: candidata.marca, id: candidata.id });
        vez.id = candidata.id;
        vez.empresaId = candidata.empresa_id;
        await travarEmpresa(tx, candidata.empresa_id);
        // r6 (P2-1): a releitura sob a trava exige a mesma empresa (a travada) e o ambiente do lote.
        const escolhida = (await tx.query<{ marca: string }>(`SELECT oportunidade_pendente_em::text AS marca FROM whatsapp_atendimento_conversas
           WHERE id=$1 AND empresa_id=$2 AND ambiente=$3 AND oportunidade_pendente_em <= clock_timestamp() FOR UPDATE SKIP LOCKED`, [candidata.id, candidata.empresa_id, ambiente])).rows[0];
        if (!escolhida) return 'SEM_PENDENCIA' as const;
        vez.marca = escolhida.marca;
        return capturarOportunidade(tx, candidata.id, { empresaId: candidata.empresa_id, ambiente });
      });
      if (r === null) {
        // Fim da fila depois do cursor: volta ao início uma vez por lote (as já vistas neste lote seguem de fora).
        if (vez.fimDaFila && !voltouAoInicio) { voltouAoInicio = true; cursorDoLote.delete(ambiente); continue; }
        break;
      }
      vistas.push(vez.id!);
      saida.resultados.push(r);
      if (r !== 'SEM_PENDENCIA') { saida.capturas++; tentadas++; }
    } catch (erro) {
      if (!vez.id) {
        if ((erro as { code?: string }).code !== '42703') saida.falhas.push(codigoFalha(erro)); // 42703: 132 ainda não aplicada
        break;
      }
      vistas.push(vez.id);
      tentadas++;
      saida.falhas.push(codigoFalha(erro));
      try {
        // Só a marca que falhou é adiada (r3): uma marca nova gravada pelo worker depois do rollback fica como está.
        // r7 (P2-B): e só na empresa e no ambiente revalidados sob a trava (os mesmos da releitura).
        const adiada = await transacao(tx => tx.query('UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=clock_timestamp()+make_interval(secs => $2) WHERE id=$1 AND oportunidade_pendente_em=$3::timestamptz AND empresa_id=$4 AND ambiente=$5 RETURNING id',
          [vez.id, espera, vez.marca, vez.empresaId, ambiente]));
        if (adiada.rows.length) saida.adiadas++;
      } catch (falhaAoAdiar) { saida.falhas.push(codigoFalha(falhaAoAdiar)); }
    }
  }
  return saida;
}

/** Texto que substitui o resumo diário guardado quando um contato dele é anonimizado (o e-mail já enviado não volta). */
export const RESUMO_ANONIMIZADO = 'Resumo removido: um contato deste resumo foi anonimizado a pedido do titular.';

/**
 * D-WA-3, dentro da exclusão a pedido do titular (antes de apagar a conversa). Alcança os cartões do Wall-e do TITULAR na
 * empresa e ambiente: os desta conversa e os do mesmo número com e sem 55 (inclusive os de outra conversa ainda viva e os
 * que perderam a conversa pela retenção).
 * - Marcas pendentes das conversas do mesmo número (com e sem 55) são descartadas ANTES da trava do telefone (r3): a
 *   captura trava a conversa e depois o telefone; aqui a ordem é a mesma (conversa, depois telefone), sem impasse. Uma
 *   captura já em curso termina primeiro e o cartão que ela gravar é alcançado logo abaixo.
 * - Cartão sem negociação é anonimizado: nome e telefone neutros, demais dados pessoais nulos, cliente desvinculado (o
 *   cadastro do cliente não muda), observações das ações do funil apagadas, resumos diários guardados que o citam
 *   substituídos (e não enviados, se pendentes) e o vínculo solto da conversa (r3: conversa_id nulo, nada aponta mais
 *   para o número). Fica só como número na estatística (DELETE segue proibido pela 085).
 * - A atribuição de origem é append-only pela 085 (sem UPDATE nem DELETE) e o histórico do cliente não é apagado: se a
 *   equipe escreveu texto livre na atribuição, ligou o cartão a outro alvo (ex.: CLIENTE) ou o histórico cita o cartão,
 *   ele é anonimizado igual, mas vai em `revisar`/`revisarIds` (id interno para abrir nas Origens), nunca em `anonimizados` (r3/r4).
 * - Cartão com negociação (convertido de fato) fica intacto: Guarda dos clientes. Correspondência de telefone com um
 *   cliente NÃO é conversão. Sem a 132, nada a fazer.
 */
export async function anonimizarOportunidadesDaConversa(tx: DbExecutor, empresa: string, ambiente: string, conversaId: string, contato: string) {
  if (!(await tx.query<{ ok: boolean }>("SELECT to_regclass('public.whatsapp_atendimento_oportunidades') IS NOT NULL AS ok")).rows[0]?.ok) return { anonimizados: 0, preservados: 0, revisar: 0, revisarIds: [] as string[] };
  const variantes = variantesDoTelefone(contato);
  // r4 (P1-3): trava as conversas do número (a própria e as irmãs) na mesma ordem da captura (conversa → telefone → cartão).
  // Uma marca ainda não confirmada numa irmã faz esta leitura esperar; o UPDATE seguinte, nova instrução, já a enxerga e limpa.
  await tx.query(`SELECT id FROM whatsapp_atendimento_conversas WHERE empresa_id=$1 AND ambiente=$2 AND (id=$3 OR contato = ANY($4::text[]))
    ORDER BY id FOR UPDATE`, [empresa, ambiente, conversaId, variantes]);
  await tx.query(`UPDATE whatsapp_atendimento_conversas SET oportunidade_pendente_em=NULL WHERE empresa_id=$1 AND ambiente=$2 AND (id=$3 OR contato = ANY($4::text[]))
    AND oportunidade_pendente_em IS NOT NULL`, [empresa, ambiente, conversaId, variantes]);
  if (/^[0-9]{10,15}$/.test(contato)) await travarTelefone(tx, empresa, contato);
  // r4 (P1-2): a captura não grava atribuição nem histórico; o que houver foi a equipe e pode citar o titular:
  // texto livre na atribuição, atribuição que liga o cartão a outro alvo (ex.: CLIENTE) ou evento no histórico do cliente.
  const vinculos = (await tx.query<{ contato_id: string; convertido: boolean; residuo: boolean }>(`SELECT o.contato_id::text, k.fechamento_id IS NOT NULL AS convertido,
       (EXISTS (SELECT 1 FROM marketing_atribuicoes a WHERE a.empresa_id=k.empresa_id AND (a.contato_id=k.id OR (a.alvo_tipo='CONTATO' AND a.alvo_id=k.id))
          AND (a.detalhe IS NOT NULL OR a.motivo IS NOT NULL OR a.alvo_tipo<>'CONTATO'))
        OR EXISTS (SELECT 1 FROM eventos_historico_cliente h JOIN clientes cl ON cl.id=h.cliente_id AND cl.empresa_id=k.empresa_id
          WHERE h.entidade_tipo='MARKETING_CONTATO' AND h.entidade_id=k.id)) AS residuo
     FROM whatsapp_atendimento_oportunidades o JOIN marketing_contatos k ON k.id=o.contato_id AND k.empresa_id=o.empresa_id
     WHERE o.empresa_id=$1 AND o.ambiente=$2 AND o.anonimizado_em IS NULL AND (o.conversa_id=$3 OR k.telefone = ANY($4::text[]))
     ORDER BY o.contato_id FOR UPDATE OF o, k`, [empresa, ambiente, conversaId, variantes])).rows;
  // perda_observacao e as ações chegam com a 122; sem ela, o resto da anonimização vale igual.
  const comPerda = (await tx.query<{ ok: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.marketing_contatos') AND attname='perda_observacao' AND NOT attisdropped) AS ok")).rows[0]?.ok;
  const comAcoes = (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.oportunidades_acoes') IS NOT NULL AND to_regclass('public.oportunidades_resumos') IS NOT NULL AS ok")).rows[0]?.ok;
  let anonimizados = 0;
  const revisarIds: string[] = [];
  for (const v of vinculos) {
    if (v.convertido) continue;
    await tx.query(comPerda
      ? `UPDATE marketing_contatos SET nome=$3,telefone=$4,email=NULL,mensagem=NULL,data_desejada=NULL,convidados=NULL,cliente_id=NULL,vinculo_cliente='SEM_CLIENTE',perda_observacao=NULL,atualizado_em=clock_timestamp()
        WHERE id=$1 AND empresa_id=$2 AND fechamento_id IS NULL`
      : `UPDATE marketing_contatos SET nome=$3,telefone=$4,email=NULL,mensagem=NULL,data_desejada=NULL,convidados=NULL,cliente_id=NULL,vinculo_cliente='SEM_CLIENTE',atualizado_em=clock_timestamp()
        WHERE id=$1 AND empresa_id=$2 AND fechamento_id IS NULL`, [v.contato_id, empresa, NOME_ANONIMIZADO, TELEFONE_ANONIMIZADO]);
    if (comAcoes) {
      const acoes = (await tx.query<{ id: string }>('UPDATE oportunidades_acoes SET observacao=NULL WHERE empresa_id=$1 AND contato_id=$2 RETURNING id::text', [empresa, v.contato_id])).rows.map(a => a.id);
      // O resumo diário guardado cita o nome do cartão pelo id da ação: o texto sai e o pendente não é mais enviado.
      if (acoes.length) await tx.query(`UPDATE oportunidades_resumos SET mensagem=jsonb_set(jsonb_set(mensagem,'{mensagem,texto}',to_jsonb($3::text)),'{mensagem,html}',to_jsonb($3::text)),
          estado=CASE WHEN estado='PENDENTE' THEN 'OBSOLETO' ELSE estado END WHERE empresa_id=$1 AND mensagem->'acoes' ?| $2::text[]`, [empresa, acoes, RESUMO_ANONIMIZADO]);
    }
    await tx.query('UPDATE whatsapp_atendimento_oportunidades SET anonimizado_em=clock_timestamp(),conversa_id=NULL WHERE contato_id=$1', [v.contato_id]);
    if (v.residuo) revisarIds.push(v.contato_id); else anonimizados++;
  }
  return { anonimizados, preservados: vinculos.length - anonimizados - revisarIds.length, revisar: revisarIds.length, revisarIds };
}
