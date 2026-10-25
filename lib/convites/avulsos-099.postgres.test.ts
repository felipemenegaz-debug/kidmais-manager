import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,mkdtempSync} from 'node:fs';
import {createRequire} from 'node:module';
import type {Client} from 'pg';
import {conectarDescartavel,encerrarDescartavel,semTransacaoExplicita} from '../comercial/postgres-descartavel.ts';
import {hashSnapshotContrato} from '../contratos/services/snapshot-core.ts';
import {registrarAutorizacao,revogarAutorizacao,hashTextoIA} from './consentimento.ts';
import {VERSAO_TEXTOS_IA} from './consentimento-textos.ts';
const ler=(f:string)=>readFileSync(f,'utf8');
const PRE=ler('database/checks/20261024_099_precheck.sql');
const UP=ler('database/migrations/20261024_099_convites_avulsos.sql');
const POST=ler('database/checks/20261024_099_postcheck.sql');
const DOWN=ler('database/rollback/20261024_099_convites_avulsos_down.sql');
// Fixture de contrato/festa copiada da suíte 088, sem desativar gatilhos.
const cod = () => `av${randomBytes(3).toString("hex")}`;
const id = async (db: Client, sql: string, v: unknown[]) => (await db.query<{ id: string }>(sql, v)).rows[0].id;
const SENHA_FALSA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";

async function recusa(c: Client, sql: string, v: unknown[], motivo: RegExp) {
  await c.query("SAVEPOINT recusa");
  await assert.rejects(c.query(sql, v), motivo);
  await c.query("ROLLBACK TO SAVEPOINT recusa");
}

async function empresa(db: Client) {
  const e = await id(db, `INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Empresa 088', 'PROVISIONAMENTO') RETURNING id`, [cod()]);
  await db.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
  return e;
}
async function usuario(db: Client, empresaId: string) {
  const u = await id(db, `INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Usuário 088', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id`,
    [`${cod()}@example.test`, SENHA_FALSA]);
  const m = await id(db, `INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', now(), 'REPRESENTANTE_AUTORIZADO') RETURNING id`, [empresaId, u]);
  await db.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
  return u;
}

/** Contrato ASSINADO com versão vigente e a Festa dele (cópia do fixture da composição 085/086). */
async function festa(db: Client, empresaId: string, criador: string) {
  const pacote = await id(db, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, $2, 'Festa E1', 1, true, true) RETURNING id`, [empresaId, cod().toUpperCase()]);
  const tabela = await id(db, `INSERT INTO tabelas_preco (codigo, nome, vigencia_inicio, ativa, empresa_id) VALUES ($1, 'Tabela E1', '2026-01-01', false, $2::uuid) RETURNING id`, [cod(), empresaId]);
  const preco = await id(db, `INSERT INTO precos_pacote (tabela_preco_id, pacote_id, convidados_min, tipo_calculo, valor, categoria_horario) VALUES ($1::uuid, $2::uuid, 1, 'FIXO', 100, 'PADRAO') RETURNING id`, [tabela, pacote]);
  const agenda = await id(db, `INSERT INTO configuracao_agenda (codigo, nome, horario_inicio_padrao, horario_fim_padrao, ordem_exibicao) VALUES ($1, 'Agenda E1', '10:00', '18:00', 9) RETURNING id`, [cod()]);
  const cliente = await id(db, `INSERT INTO clientes (nome_completo, empresa_id) VALUES ('Cliente E1', $1::uuid) RETURNING id`, [empresaId]);
  const fechamento = await id(db, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
      categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
    VALUES ('2026-09-01', '14:00', '18:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PADRAO', 'PADRAO', 20, 20, 100, 100, 100, 'ATENDIMENTO_KIDMAIS', $6::uuid, 'AGUARDANDO_PAGAMENTO') RETURNING id`,
    [agenda, empresaId, pacote, tabela, preco, cliente]);
  const contrato = await id(db, `INSERT INTO contratos (fechamento_id, status, assinado_em) VALUES ($1::uuid, 'ASSINADO', now()) RETURNING id`, [fechamento]);
  const snapshot = { comercial: { valorFinalContrato: 100 }, evento: { data: "2026-09-01", convidados: 20, pacote: { codigo: "E1", nome: "Festa E1" } }, contratacao: { buffet: {}, adicionais: [] } };
  const hash = hashSnapshotContrato(snapshot);
  const pdf = Buffer.from(`%PDF-1.4
% E1 contrato ${randomUUID()}
%%EOF
`);
  const pdfHash = createHash("sha256").update(pdf).digest("hex");
  const versao = await id(db, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo)
     VALUES ($1::uuid, 1, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP') RETURNING id`, [contrato, JSON.stringify(snapshot), hash, pdfHash]);
  const doc = await id(db, `INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf, gerado_por_usuario_id)
     VALUES ($1::uuid, 'CONTRATO', 1, $2, 'CONTRATO_E1', 1, $3, $4, $5, $6::uuid) RETURNING id`, [versao, hash, pdfHash, pdf.length, pdf, criador]);
  const comprovante = await id(db, `INSERT INTO contrato_documentos (contrato_versao_id, categoria, revisao, snapshot_hash, template_codigo, template_versao, pdf_hash, tamanho_bytes, conteudo_pdf)
     VALUES ($1::uuid, 'COMPROVANTE_ASSINATURA', 1, $2, 'COMPROVANTE_E1', 1, $3, $4, $5) RETURNING id`, [versao, hash, pdfHash, pdf.length, pdf]);
  await db.query(`INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id, documento_revisado_id, revisado_por_usuario_id, revisado_em)
     VALUES ($1::uuid, $2::uuid, 'INICIAL', 'CONCLUIDA', '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $3::uuid, $3::uuid, $4::uuid, $3::uuid, now())`, [versao, contrato, criador, doc]);
  const validacao = await id(db, `INSERT INTO validacoes_identidade_cliente (cliente_id, canal, status, confirmado_em, token_prova_hash, prova_expira_em) VALUES ($1::uuid, 'EMAIL', 'CONFIRMADA', now(), $2, now() + interval '10 minutes') RETURNING id`, [cliente, randomBytes(32).toString("hex")]);
  await db.query(`INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, usuario_id, sessao_id, autenticacao_metodo, autenticado_em, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
     VALUES ($1::uuid, 'KIDMAIS', $2::uuid, $3::uuid, $4::uuid, 'SENHA', now(), $5::jsonb, $6, $7, 'SESSAO_REAUTENTICADA', 'INTERNAL', now(), $8::uuid, $9::uuid, $10::uuid)`,
    [versao, doc, criador, randomUUID(), JSON.stringify({ usuarioId: criador, papel: "REPRESENTANTE_AUTORIZADO", nome: "Usuário E1", cargo: null }), hash, pdfHash, randomUUID(), randomUUID(), comprovante]);
  await db.query(`INSERT INTO contrato_assinaturas (contrato_versao_id, parte, documento_id, validacao_identidade_id, identidade_snapshot, snapshot_hash, pdf_hash, metodo, provider, assinado_em, request_id, chave_idempotencia, comprovante_documento_id)
     VALUES ($1::uuid, 'CLIENTE', $2::uuid, $3::uuid, $4::jsonb, $5, $6, 'OTP', 'INTERNAL', now(), $7::uuid, $8::uuid, $9::uuid)`,
    [versao, doc, validacao, JSON.stringify({ schemaVersao: 1, clienteId: cliente, nome: "Cliente E1" }), hash, pdfHash, randomUUID(), randomUUID(), comprovante]);
  await db.query(`INSERT INTO contrato_fluxos (contrato_id, versao_vigente_id) VALUES ($1::uuid, $2::uuid)`, [contrato, versao]);
  const f = await id(db, `INSERT INTO festas (contrato_id, versao_contratual_criacao_id, chave_criacao, payload_hash, criado_por) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid) RETURNING id`,
    [contrato, versao, randomUUID(), createHash("sha256").update("e1").digest("hex"), criador]);
  const convite = await id(db, `INSERT INTO convites (empresa_id, festa_id, cliente_id, estabelecimento_id, publico_token, rascunho, versao_contrato_id)
    VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, $4, '{}'::jsonb, $5::uuid) RETURNING id`, [empresaId, f, cliente, randomBytes(32).toString("base64url"), versao]);
  return { id: convite, empresa_id: empresaId, festa_id: f, cliente_id: cliente };
}


test('099: cadeia completa, preservação, avulso, consentimento, vínculo e rollback protegido', {timeout:120000}, async t=>{
  if(!opt()){t.skip('opt-in PostgreSQL ausente');return;}
  const c=await conectarDescartavel();
  try {
    await c.query('BEGIN');
    const e=await empresa(c), u=await usuario(c,e);
    const vinculado=await festa(c,e,u);
    const antes=(await c.query('SELECT to_jsonb(c) AS linha FROM convites c WHERE id=$1',[vinculado.id])).rows[0].linha;
    await c.query(PRE);
    await c.query(semTransacaoExplicita(UP));
    await c.query(POST);
    assert.deepEqual((await c.query('SELECT to_jsonb(c) AS linha FROM convites c WHERE id=$1',[vinculado.id])).rows[0].linha,antes);
    await recusa(c,PRE,[],/anterior ou parcial/);
    // Rollback funciona antes de existir avulso e não muda o convite ligado.
    await c.query('SAVEPOINT reversao');
    await c.query(semTransacaoExplicita(DOWN));
    await c.query(PRE);
    await c.query('ROLLBACK TO SAVEPOINT reversao');
    await c.query(POST);
    const av=await id(c,'INSERT INTO convites(empresa_id,publico_token,rascunho) VALUES($1,$2,$3) RETURNING id',[e,randomBytes(32).toString('base64url'),{}]);
    await recusa(c,'UPDATE convites SET cliente_id=$2 WHERE id=$1',[av,vinculado.cliente_id],/convite_avulso_vinculo_completo/);
    await recusa(c,'UPDATE convites SET editor_hash=$2 WHERE id=$1',[av,'hash-sintetico'],/convite_avulso_vinculo_completo/);
    const ref={id:av,empresa_id:e,festa_id:null,cliente_id:null};
    const consent=await registrarAutorizacao(c,ref,{tipo:'BUFFET',usuarioId:u},`USUARIO:${u}`,'openai',{
      versao:VERSAO_TEXTOS_IA,provedor:'openai',textoHash:hashTextoIA('openai','BUFFET'),responsavelNome:'Responsável Sintético',vinculo:'MAE',meio:'WHATSAPP',declaracao:true});
    assert.equal((await c.query('SELECT festa_id FROM convite_ia_autorizacoes WHERE id=$1',[consent.id])).rows[0].festa_id,null);
    await recusa(c,semTransacaoExplicita(DOWN),[],/099/);
    // Uma festa vazia para testar avulso → vinculado; o convite fixture é descartado nesta transação de teste.
    const destino=await festa(c,e,u);
    const d=(await c.query('SELECT * FROM convites WHERE id=$1',[destino.id])).rows[0];
    await c.query('DELETE FROM convites WHERE id=$1',[destino.id]);
    await revogarAutorizacao(c,ref,`USUARIO:${u}`);
    await c.query('UPDATE convites SET festa_id=$2,cliente_id=$3,versao_contrato_id=$4 WHERE id=$1',[av,d.festa_id,d.cliente_id,d.versao_contrato_id]);
    await recusa(c,'UPDATE convites SET festa_id=NULL,cliente_id=NULL,versao_contrato_id=NULL WHERE id=$1',[av],/imutável/);
    await recusa(c,'UPDATE convites SET festa_id=$2 WHERE id=$1',[av,vinculado.festa_id],/imutável/);
    // Mesmo vinculado, a evidência histórica com festa nula impede um rollback que perderia essa evidência.
    await recusa(c,semTransacaoExplicita(DOWN),[],/099/);
    assert.equal((await c.query('SELECT usado_festa FROM convites WHERE id=$1',[av])).rows[0].usado_festa,0);
    await c.query('ROLLBACK');
    await c.query(PRE);
    // Mesmo aplicador de staging, conectado apenas por este conector descartável e com disco temporário local.
    const ap=createRequire(import.meta.url)('../../scripts/migration-099-staging.cjs');
    const sql=ap.lerArquivos(), dir=mkdtempSync('.local-099-aplicador-');
    assert.equal((await ap.conferir(c,sql)).estado,'AUSENTE_PRECHECK_PASS');
    assert.equal((await ap.aplicar(c,sql,dir)).estado,'APLICADA_POSTCHECK_PASS');
    assert.equal((await ap.conferir(c,sql)).estado,'APLICADA_POSTCHECK_PASS');
    await assert.rejects(ap.aplicar(c,sql,dir),/EEXIST/);
    await c.query(DOWN);
    await c.query(PRE);
  } finally {await encerrarDescartavel(c);}
});
