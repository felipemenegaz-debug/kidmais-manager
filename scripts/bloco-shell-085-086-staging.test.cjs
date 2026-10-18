/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 6b: executados DE VERDADE com bash num destino temporário (só o destino difere do de staging e o
// comando do aplicador não é anexado). Prova gravação, conferência de sha, recusas e limpeza; não toca banco.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process'),{createHash}=require('node:crypto');
const b=require('./bloco-shell-085-086-staging.cjs'),{ETAPAS}=require('./migration-085-086-staging.cjs');
const root=path.resolve(__dirname,'..');
const lf=a=>fs.readFileSync(path.join(root,a),'utf8').replace(/\r\n/g,'\n');
const sha=s=>createHash('sha256').update(s).digest('hex');
const posix=p=>p.replace(/\\/g,'/');
function destino({deps=true}={}){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'bloco-085-086-'));
  if(deps)for(const a of b.DEPENDENCIAS){fs.mkdirSync(path.dirname(path.join(d,a)),{recursive:true});fs.writeFileSync(path.join(d,a),lf(a));}
  return d;
}
function rodar(d,modo){
  const bloco=b.gerar({modo,rotulo:'9080f45',destino:posix(d),executarComando:false});
  const f=path.join(d,'..',path.basename(d)+'-'+modo+'.sh'); fs.writeFileSync(f,bloco);
  const r=spawnSync('bash',[f],{encoding:'utf8'}); fs.rmSync(f,{force:true});
  return {status:r.status,saida:(r.stdout||'')+(r.stderr||''),bloco};
}
const presentes=d=>b.ARQUIVOS.filter(a=>fs.existsSync(path.join(d,a)));

test('arquivos do bloco: aplicador + 6 SQL revisados; dependências são as 4 que o aplicador carrega',()=>{
  assert.deepEqual(b.ARQUIVOS,['scripts/migration-085-086-staging.cjs',...ETAPAS.map(e=>e[1])]);
  assert.deepEqual(b.DEPENDENCIAS,['scripts/migration-078-staging.cjs','scripts/assinatura-staging-ensaio.cjs','scripts/assinatura-preservacao.cjs','scripts/conexao-staging.cjs']);
  for(const [,a,h] of ETAPAS)assert.equal(sha(lf(a)),h,a);
  assert.equal(b.DESTINO,'/opt/render/project/src');
  assert.throws(()=>b.gerar({modo:'X',rotulo:'9080f45'}),/MODO_DESCONHECIDO/);
  assert.throws(()=>b.gerar({modo:'H0',rotulo:'abc; rm -rf /'}),/ROTULO_INVALIDO/);
});

test('blocos oficiais: destino fixo, comando certo por modo, sem segredo nem variável de ambiente',()=>{
  const h0=b.gerar({modo:'H0',rotulo:'9080f45'}),h1=b.gerar({modo:'H1',rotulo:'9080f45'}),l=b.gerar({modo:'LIMPEZA',rotulo:'9080f45'});
  for(const x of [h0,h1,l]){assert.match(x,/^cd '\/opt\/render\/project\/src'$/m);assert.doesNotMatch(x,/DATABASE_URL|PGPASSWORD|postgres(ql)?:\/\//);}
  assert.match(h0,/^node scripts\/migration-085-086-staging\.cjs --conferir-085-086$/m);assert.doesNotMatch(h0,/--aplicar/);
  assert.match(h1,/^node scripts\/migration-085-086-staging\.cjs --aplicar-085-086-autorizado$/m);
  assert.doesNotMatch(l,/^node /m);assert.doesNotMatch(l,/B64/);
});

test('sem dependência idêntica o bloco para antes de escrever qualquer arquivo',()=>{
  const d=destino();
  try{fs.appendFileSync(path.join(d,'scripts/conexao-staging.cjs'),'\n// alterado');
    const r=rodar(d,'H0');assert.equal(r.status,3);assert.match(r.saida,/DEPENDENCIA_DIVERGENTE scripts\/conexao-staging\.cjs/);assert.deepEqual(presentes(d),[]);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('grava os 7 arquivos idênticos à árvore; repetir é aceito (JA_PRESENTE); limpeza remove só os 7',()=>{
  const d=destino();
  try{const r=rodar(d,'H1');assert.equal(r.status,0,r.saida);assert.match(r.saida,/ARQUIVOS_OK/);
    for(const a of b.ARQUIVOS)assert.equal(fs.readFileSync(path.join(d,a),'utf8'),lf(a),a);
    const r2=rodar(d,'H0');assert.equal(r2.status,0,r2.saida);assert.equal((r2.saida.match(/JA_PRESENTE/g)||[]).length,7);
    const l=rodar(d,'LIMPEZA');assert.equal(l.status,0,l.saida);assert.equal((l.saida.match(/REMOVIDO/g)||[]).length,7);
    assert.deepEqual(presentes(d),[]);for(const a of b.DEPENDENCIAS)assert.ok(fs.existsSync(path.join(d,a)),'dependência preservada '+a);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('arquivo presente e diferente: para sem escrever os demais; limpeza preserva o divergente',()=>{
  const d=destino();
  try{const alvo=path.join(d,ETAPAS[4][1]);fs.mkdirSync(path.dirname(alvo),{recursive:true});fs.writeFileSync(alvo,'-- outro conteúdo\n');
    const r=rodar(d,'H1');assert.equal(r.status,3);assert.match(r.saida,/JA_EXISTE_DIFERENTE database\/migrations\/20261018_086_marketing_automacoes\.sql/);
    assert.deepEqual(presentes(d),[ETAPAS[4][1]],'nenhum outro arquivo gravado');
    const l=rodar(d,'LIMPEZA');assert.match(l.saida,/DIVERGENTE_PRESERVADO database\/migrations\/20261018_086/);assert.ok(fs.existsSync(alvo));
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('conteúdo corrompido no bloco: para na conferência, antes de gravar qualquer arquivo',()=>{
  const d=destino();
  try{const bloco=b.gerar({modo:'H1',rotulo:'9080f45',destino:posix(d),executarComando:false});
    const linhas=bloco.split('\n'),i=linhas.findIndex(x=>x.startsWith('prep 3 '))+1;linhas[i]=linhas[i].replace(/^./,c=>c==='A'?'B':'A');
    const f=d+'-corrompido.sh';fs.writeFileSync(f,linhas.join('\n'));const r=spawnSync('bash',[f],{encoding:'utf8'});fs.rmSync(f,{force:true});
    assert.notEqual(r.status,0);assert.deepEqual(presentes(d),[]);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
