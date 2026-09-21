/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

// Chamado pelo runner 014, exclusivamente no clone isolado e com autenticação real.
module.exports = async function validarModelos({ c, festa, nova, fresh, op, freeze, accept, edition, packs, payment, ok }) {
  const { lerDocumento } = require('../lib/contratos/storage/postgres.ts');
  const repos = require('../lib/contratos/repositories');
  const output = '.tmp/modelos-oficiais';
  fs.mkdirSync(output, { recursive: true });
  const evidence = [];
  async function documento(vid, codigo, tarifa) {
    const d = (await c.query("SELECT * FROM contrato_documentos WHERE contrato_versao_id=$1 AND categoria='CONTRATO' ORDER BY revisao DESC", [vid])).rows[0];
    assert(d);
    assert.equal(d.template_codigo, `FESTA_${codigo}_V4`);
    assert.equal(d.template_versao, 4);
    assert.equal(crypto.createHash('sha256').update(d.conteudo_pdf).digest('hex'), d.pdf_hash);
    assert((await lerDocumento(d.id)).conteudo_pdf.equals(d.conteudo_pdf));
    const v = await repos.buscarVersaoPorId(vid);
    assert.equal(v.snapshot.evento.pacote.codigo, codigo);
    const raw = d.conteudo_pdf.toString('latin1');
    assert.equal(v.snapshot.aniversariante.idadeNoEvento,v.numeroVersao===1?1:2);
    assert(raw.includes(v.numeroVersao===1?'1 ano.':'2 anos.'));
    assert(!raw.includes('1 anos.')); 
    const bold = [...raw.matchAll(/\/F2 9\.00 Tf \(([^)]*)\) Tj/g)].map(x => x[1]).join('');
    const nome = { ESSENCIAL: 'Festa Essencial', COMPLETA: 'Festa Completa', PREMIUM: 'Festa Premium' }[codigo];
    const data = v.snapshot.evento.data.split('-').reverse().join('/');
    for (const value of [nome, data, `${v.snapshot.evento.convidadosFaturados} pessoas`, `R$ ${tarifa},00 por pessoa excedente`]) assert(bold.includes(value), value);
    for (const outra of [110, 130, 150].filter(x => x !== tarifa)) assert(!bold.includes(`R$ ${outra},00 por pessoa excedente`));
    const assinatura = (await c.query('SELECT parte,pdf_hash,documento_id FROM contrato_assinaturas WHERE contrato_versao_id=$1 ORDER BY parte', [vid])).rows;
    assert.deepEqual(assinatura.map(x => x.parte), ['CLIENTE', 'KIDMAIS']);
    for (const a of assinatura) { assert.equal(a.pdf_hash, d.pdf_hash); assert.equal(a.documento_id, d.id); }
    assert.equal((await c.query('SELECT versao_vigente_id FROM contrato_fluxos WHERE contrato_id=$1', [v.contratoId])).rows[0].versao_vigente_id, vid);
    assert.equal(v.status, 'ASSINADA');
    const path = `${output}/${codigo.toLowerCase()}-${v.snapshot.evento.data}-contratacao-v${v.numeroVersao}.pdf`;
    fs.writeFileSync(path, d.conteudo_pdf);
    evidence.push({ codigo, tarifa, versao: v.numeroVersao, modelo: d.template_codigo, templateVersao: d.template_versao, pdfHash: d.pdf_hash, path });
    return d;
  }
  for (const [index, [origem, destino, anterior, atual]] of [
    ['ESSENCIAL', 'COMPLETA', 110, 130],
    ['COMPLETA', 'PREMIUM', 130, 150],
    ['PREMIUM', 'COMPLETA', 150, 130],
  ].entries()) {
    const f = await festa(`2097-08-${10 + index}`, origem, 1);
    const d1 = await documento(f.vid, origem, anterior);
    assert.equal((await c.query('SELECT count(*)::int n FROM pagamentos p JOIN contrato_versoes v ON v.id=p.contrato_versao_id JOIN contratos c ON c.id=v.contrato_id WHERE c.fechamento_id=$1', [f.fid])).rows[0].n, 0);
    await assert.rejects(op(f.vid, { acao: 'gerar_pdf', revisao: (await edition(f.vid)).revisao }));
    ok(`${origem}: Fechamento → revisão/PDF → assinatura Kidmais → liberação → OTP/aceite → vigente, sem Pagamento automático`);
    const p = await payment(f);
    const financeiro = (await c.query('SELECT to_jsonb(p)::text row FROM pagamentos p WHERE id=$1', [p.pagamento.id])).rows;
    const v1 = (await c.query('SELECT to_jsonb(v)::text row FROM contrato_versoes v WHERE id=$1', [f.vid])).rows;
    const v2 = await nova(f);
    const edit = await fresh(v2, { pacoteId: packs[destino], buffetStatus: 'PENDENTE', idadeAniversarianteEvento: 2 });
    await op(v2, edit);
    await freeze(v2); await accept(v2);
    const d2 = await documento(v2, destino, atual);
    assert.notEqual(d1.pdf_hash, d2.pdf_hash);
    assert((await lerDocumento(d1.id)).conteudo_pdf.equals(d1.conteudo_pdf));
    assert.deepEqual((await c.query('SELECT to_jsonb(v)::text row FROM contrato_versoes v WHERE id=$1', [f.vid])).rows, v1);
    assert.deepEqual((await c.query('SELECT to_jsonb(p)::text row FROM pagamentos p WHERE id=$1', [p.pagamento.id])).rows, financeiro);
    assert.equal((await c.query('SELECT count(*)::int n FROM pagamentos p JOIN contrato_versoes v ON v.id=p.contrato_versao_id JOIN contratos c ON c.id=v.contrato_id WHERE c.fechamento_id=$1', [f.fid])).rows[0].n, 1);
    ok(`${origem}→${destino}: V2 usa ${atual}; V1/BYTEA/hash e obrigação financeira original intactos`);
  }
  fs.writeFileSync(`${output}/resultados.json`, JSON.stringify(evidence, null, 2));
};
