import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { iniciarTeste } from './servico.ts';
import { prepararOferta, type PedidoOferta } from './ofertas.ts';
import { sincronizarEmpresa } from './sincronizacao.ts';
import { DOCUMENTOS, hashDocumento } from '../cadastro/documentos-legais.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';

/**
 * Apoio das suítes da 109 (B-9 production, plano rev. 5): empresa com contrato Fundador CONFIRMADO pelo caminho do produto
 * (mesmo roteiro de renovacao-agendada.postgres.test.ts) e linhas de renovação inseridas direto, com datas relativas ao
 * relógio do BANCO em Brasília (a guarda usa clock_timestamp).
 */
const ENV = { ASSINATURA_PLANOS_ATIVOS: 'true', ASAAS_AMBIENTE: 'sandbox' };
const PEDIDO: PedidoOferta = { plano: 'essencial', ciclo: 'MENSAL', valorEsperadoCentavos: 11820, versao: '2026-10-20' };
const docs = () => Object.fromEntries(Object.values(DOCUMENTOS).map((d) => [d.documento, { versao: d.versao, hash: hashDocumento(d) }]));
function cnpj(n: number) {
    const base = `6${String(n).padStart(7, '0')}0001`;
    const dv = (b: string) => { let s = 0, p = 2; for (let i = b.length - 1; i >= 0; i--) { s += (b.charCodeAt(i) - 48) * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r <= 1 ? 0 : 11 - r; };
    const d1 = dv(base); return base + d1 + dv(base + d1);
}
let seq = 0;

export async function emTx<T>(client: Client, acao: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try { const r = await acao(); await client.query('COMMIT'); return r; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
}
export const hojeBanco = async (client: Client) => (await client.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS d")).rows[0].d as string;
export const somar = (data: string, dias: number) => new Date(Date.parse(data) + dias * 86400000).toISOString().slice(0, 10);

/** Identidade sintética da Gestão: o INSERT fica nas suítes (*.test.ts), nunca em código de apoio (F1 de plataforma.test.ts). */
export const usuarioSintetico = () => [`r109${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`];

/** Empresa ATIVA com contrato Fundador confirmado (sincronização da reconciliação, como o produto). */
export async function empresaFundador(client: Client, usuario: string, fixture = false) {
    const q = (t: string, p: unknown[] = []) => client.query(t, p);
    const n = ++seq + Math.floor(Math.random() * 1e6);
    const id = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id",
        [`${fixture ? 'hml-' : ''}r109${n}${randomBytes(3).toString('hex')}`, fixture ? 'TESTE renovação 109' : 'Buffet 109'])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [id]);
    await q(`INSERT INTO plataforma_empresas_cadastro (empresa_id, nome_empresarial, documento_fiscal, responsavel_nome, email, criado_por, atualizado_por)
        VALUES ($1, 'Festas 109 Ltda', $2, 'Responsável', $3, $4, $4)`, [id, cnpj(n), `r109${n}@example.test`, usuario]);
    await emTx(client, () => iniciarTeste(client as never, { empresaId: id, documento: cnpj(n) }));
    await q(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1, $2, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO')`, [id, usuario]);
    await q("UPDATE memberships SET status = 'ATIVA' WHERE empresa_id = $1 AND usuario_id = $2", [id, usuario]);
    await emTx(client, () => prepararOferta(client as never, id, usuario, { ...PEDIDO, documentos: docs() }, ENV));
    const hoje = await hojeBanco(client);
    const k = randomBytes(4).toString('hex');
    const sub: AssinaturaProvedor = { id: `sub_${k}`, customer: `cus_${k}`, externalReference: id, cycle: 'MONTHLY', status: 'ACTIVE', deleted: false, valorCentavos: 11820, nextDueDate: hoje };
    const pay = { id: `pay_${k}`, status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, deleted: false, invoiceUrl: null, valorCentavos: 11820,
        assinaturaId: sub.id, clienteId: sub.customer, billingType: 'PIX' } as CobrancaProvedor;
    const provedor = {
        async obterAssinatura(x: string) { return x === sub.id ? { ...sub } : null; },
        async listarCobrancasDaAssinatura(x: string) { return x === sub.id ? [{ ...pay }] : []; },
        async listarAssinaturasPorReferencia(ref: string) { return ref === id ? [{ ...sub }] : []; },
    };
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = $2, provedor_assinatura_id = $3 WHERE empresa_id = $1", [id, sub.customer, sub.id]);
    const r = await emTx(client, () => sincronizarEmpresa(client as never, id, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(r.resultado === 'SINCRONIZADA' && r.depois, 'ATIVA');
    const c = (await q('SELECT contratacao_atual_id AS c FROM empresa_assinaturas WHERE empresa_id = $1', [id])).rows[0].c as string;
    return { empresaId: id, contratacaoId: c, usuario, sub, pay };
}

export function mensagem(id: string, para = 'gestor@example.test') {
    return { para, assunto: 'a', texto: 't', html: '<p>t</p>', idempotencia: `kidmais-renovacao/${id}` };
}

/** INSERT direto (raiz ou sucessor). `substitui` só no schema 109. */
export async function inserir(client: Client, e: { empresaId: string; contratacaoId: string; usuario: string },
    o: { pdr: string; pv: string; substitui?: string; id?: string }) {
    const id = o.id ?? randomUUID();
    const cols = 'id,empresa_id,contratacao_id,destinatario_id,primeiro_vencimento,primeira_data_regular,aviso_dias,mensagem' + (o.substitui ? ',substitui_id' : '');
    const vals = '$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6::date,30,$7::jsonb' + (o.substitui ? ',$8::uuid' : '');
    const params: unknown[] = [id, e.empresaId, e.contratacaoId, e.usuario, o.pv, o.pdr, JSON.stringify(mensagem(id))];
    if (o.substitui) params.push(o.substitui);
    await client.query(`INSERT INTO assinatura_renovacoes (${cols}) VALUES (${vals})`, params);
    return id;
}
