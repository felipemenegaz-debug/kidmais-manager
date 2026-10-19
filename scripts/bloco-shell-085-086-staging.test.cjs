/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 6b: executados DE VERDADE com bash num destino temporário (só o destino difere do de staging; o
// comando do aplicador é omitido ou trocado por um substituto que só devolve um código). Inclui COLAGEM INTERATIVA
// (bash -i, bloco + linhas do operador), como no Web Shell: o shell do operador precisa sobreviver e ler o código.
// Não toca banco nem /opt/render.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process'),{createHash}=require('node:crypto');
const b=require('./bloco-shell-085-086-staging.cjs'),{ETAPAS}=require('./migration-085-086-staging.cjs');
const root=path.resolve(__dirname,'..');
const lf=a=>fs.readFileSync(path.join(root,a),'utf8').replace(/\r\n/g,'\n');
const sha=s=>createHash('sha256').update(s).digest('hex');
const posix=p=>p.replace(/\\/g,'/');
const SEM_COMANDO=null;
function destino({deps=true}={}){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'bloco-085-086-'));
  if(deps)for(const a of b.DEPENDENCIAS){fs.mkdirSync(path.dirname(path.join(d,a)),{recursive:true});fs.writeFileSync(path.join(d,a),lf(a));}
  fs.mkdirSync(path.join(d,'tmp'));
  return d;
}
/** Executa um arquivo de sessão: `bash arquivo` ou, com interativo, `bash -i < arquivo` (colagem no terminal). */
function sessao(d,conteudo,opcoes={}){
  // servico ausente = staging; servico: undefined = variável REMOVIDA (o padrão da desestruturação engoliria esse caso)
  const interativo=opcoes.interativo===true,servico=Object.hasOwn(opcoes,'servico')?opcoes.servico:b.SERVICO;
  const f=d+'-sessao.sh';fs.writeFileSync(f,conteudo);
  const env={...process.env,TMPDIR:posix(path.join(d,'tmp'))};if(servico===undefined)delete env.RENDER_SERVICE_ID;else env.RENDER_SERVICE_ID=servico;
  const r=interativo?spawnSync('bash',['--norc','--noprofile','-i'],{input:fs.readFileSync(f),encoding:'utf8',env}):spawnSync('bash',[f],{encoding:'utf8',env});
  fs.rmSync(f,{force:true});
  return {status:r.status,saida:(r.stdout||'')+(r.stderr||'')};
}
const gerar=(d,modo,comando=SEM_COMANDO)=>b.gerar({modo,rotulo:'b659b14',destino:posix(d),comando});
const rodar=(d,modo,comando,opcoes)=>sessao(d,gerar(d,modo,comando),opcoes);
// Só linhas de SAÍDA (no bash -i sem terminal as linhas coladas também aparecem, com prompt): âncora de linha.
const codigo=s=>Number((/^CODIGO_SAIDA_BLOCO=(\d+)$/m.exec(s)||[])[1]);
const linhas=(s,re)=>s.split(/\r?\n/).filter(l=>re.test(l)).length;
const presentes=d=>b.ARQUIVOS.filter(a=>fs.existsSync(path.join(d,a)));
const temporarios=d=>fs.readdirSync(path.join(d,'tmp')).length;

test('arquivos do bloco: aplicador + 6 SQL revisados; dependências são as 4 que o aplicador carrega',()=>{
  assert.deepEqual(b.ARQUIVOS,['scripts/migration-085-086-staging.cjs',...ETAPAS.map(e=>e[1])]);
  assert.deepEqual(b.DEPENDENCIAS,['scripts/migration-078-staging.cjs','scripts/assinatura-staging-ensaio.cjs','scripts/assinatura-preservacao.cjs','scripts/conexao-staging.cjs']);
  for(const [,a,h] of ETAPAS)assert.equal(sha(lf(a)),h,a);
  assert.equal(b.DESTINO,'/opt/render/project/src'); assert.equal(b.SERVICO,'srv-daif418ae00c73e8k2gg');
  assert.throws(()=>b.gerar({modo:'X',rotulo:'b659b14'}),/MODO_DESCONHECIDO/);
  assert.throws(()=>b.gerar({modo:'H0',rotulo:'abc; rm -rf /'}),/ROTULO_INVALIDO/);
});

test('blocos oficiais: ASCII, guarda de serviço antes de tudo, corpo em subshell, código impresso, comando por modo',()=>{
  for(const modo of ['H0','H1','LIMPEZA']){
    const x=b.gerar({modo,rotulo:'b659b14'});
    assert.match(x,/^[\x09\x0a\x20-\x7e]*$/,'ASCII '+modo); assert.equal(Buffer.byteLength(x,'utf8'),x.length,'bytes = caracteres '+modo);
    const L=x.split('\n');const iGuarda=L.findIndex(l=>l.startsWith('if [ "$RENDER_SERVICE_ID" != "srv-daif418ae00c73e8k2gg" ]'));
    assert.ok(iGuarda>0&&L.slice(0,iGuarda).every(l=>l.startsWith('#')||l.startsWith('bind ')),'nada antes da guarda '+modo);
    assert.equal(L[iGuarda+1],'(');assert.ok(L.includes(')')&&L.includes('echo "CODIGO_SAIDA_BLOCO=$?"')&&L.at(-2)==='fi');
    assert.match(x,/^cd '\/opt\/render\/project\/src' \|\| \{ echo "DESTINO_INACESSIVEL"; exit 4; \}$/m); assert.doesNotMatch(x,/DATABASE_URL|PGPASSWORD|postgres(ql)?:\/\//);
  }
  assert.match(b.gerar({modo:'H0',rotulo:'b659b14'}),/^NODE_PATH="\$PWD\/node_modules" node scripts\/migration-085-086-staging\.cjs --conferir-085-086 \|\| codigo=\$\?$/m);
  assert.match(b.gerar({modo:'H1',rotulo:'b659b14'}),/^NODE_PATH="\$PWD\/node_modules" node scripts\/migration-085-086-staging\.cjs --aplicar-085-086-autorizado \|\| codigo=\$\?$/m);
  assert.doesNotMatch(b.gerar({modo:'LIMPEZA',rotulo:'b659b14'}),/^NODE_PATH|^node |B64/m);
});

test('P3-A: shell de outro serviço (ou sem RENDER_SERVICE_ID) não executa nada',()=>{
  for(const servico of ['srv-dak77m2d0e5s73b8rkkg',undefined]){
    const d=destino();
    try{const r=rodar(d,'H1',SEM_COMANDO,{servico});assert.equal(r.status,0);assert.match(r.saida,/^SHELL_ERRADO_NAO_E_STAGING/m);
      assert.doesNotMatch(r.saida,/CODIGO_SAIDA_BLOCO/);assert.deepEqual(presentes(d),[]);
    }finally{fs.rmSync(d,{recursive:true,force:true});}
  }
});

test('sem dependência idêntica: código 4 antes de escrever qualquer arquivo',()=>{
  const d=destino();
  try{fs.appendFileSync(path.join(d,'scripts/conexao-staging.cjs'),'\n// alterado');
    const r=rodar(d,'H0');assert.equal(codigo(r.saida),4);assert.match(r.saida,/DEPENDENCIA_DIVERGENTE scripts\/conexao-staging\.cjs/);assert.deepEqual(presentes(d),[]);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('grava os 7 arquivos idênticos; repetir aceita (JA_PRESENTE); limpeza remove só os 7; temporário removido',()=>{
  const d=destino();
  try{const r=rodar(d,'H1');assert.equal(codigo(r.saida),0,r.saida);assert.match(r.saida,/ARQUIVOS_OK/);
    for(const a of b.ARQUIVOS)assert.equal(fs.readFileSync(path.join(d,a),'utf8'),lf(a),a);
    assert.equal(temporarios(d),0,'trap do subshell removeu o temporário');
    const r2=rodar(d,'H0');assert.equal(codigo(r2.saida),0,r2.saida);assert.equal(linhas(r2.saida,/^JA_PRESENTE /),7);
    const l=rodar(d,'LIMPEZA');assert.equal(codigo(l.saida),0,l.saida);assert.equal(linhas(l.saida,/^REMOVIDO /),7);
    assert.deepEqual(presentes(d),[]);for(const a of b.DEPENDENCIAS)assert.ok(fs.existsSync(path.join(d,a)),'dependência preservada '+a);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('arquivo presente e diferente: código 4 sem escrever os demais; limpeza preserva o divergente',()=>{
  const d=destino();
  try{const alvo=path.join(d,ETAPAS[4][1]);fs.mkdirSync(path.dirname(alvo),{recursive:true});fs.writeFileSync(alvo,'-- outro conteudo\n');
    const r=rodar(d,'H1');assert.equal(codigo(r.saida),4);assert.match(r.saida,/JA_EXISTE_DIFERENTE database\/migrations\/20261018_086_marketing_automacoes\.sql/);
    assert.deepEqual(presentes(d),[ETAPAS[4][1]],'nenhum outro arquivo gravado');
    const l=rodar(d,'LIMPEZA');assert.match(l.saida,/DIVERGENTE_PRESERVADO database\/migrations\/20261018_086/);assert.ok(fs.existsSync(alvo));
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('conteúdo corrompido (base64/gzip ou sha): código 4 com CONTEUDO_DIVERGENTE, antes de gravar qualquer arquivo',()=>{
  for(const corromper of [l=>l.replace(/^./,c=>c==='A'?'B':'A'),l=>'!!!'+l.slice(3)]){
    const d=destino();
    try{const linhas=gerar(d,'H1').split('\n'),i=linhas.findIndex(x=>x.startsWith('prep 3 '))+1;linhas[i]=corromper(linhas[i]);
      const r=sessao(d,linhas.join('\n'));assert.equal(codigo(r.saida),4,r.saida.slice(-300));assert.match(r.saida,/^CONTEUDO_DIVERGENTE database\/checks\/20261018_085_postcheck\.sql$/m);
      assert.deepEqual(presentes(d),[]);
    }finally{fs.rmSync(d,{recursive:true,force:true});}
  }
});

test('destino inacessível: código 4 com DESTINO_INACESSIVEL, nenhum arquivo criado (nunca 1, que é do aplicador)',()=>{
  const d=destino();
  try{const r=sessao(d,b.gerar({modo:'H0',rotulo:'d14983d',destino:posix(path.join(d,'nao-existe')),comando:null}));
    assert.equal(codigo(r.saida),4,r.saida);assert.match(r.saida,/^DESTINO_INACESSIVEL$/m);assert.ok(!fs.existsSync(path.join(d,'nao-existe')));assert.deepEqual(presentes(d),[]);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('P2-A: colagem interativa (bash -i) — o shell do operador sobrevive, sem errexit/umask/cd/trap herdados; código legível 0/2/3/4',()=>{
  const POS=['echo "POS_BLOCO opcoes=$- umask=$(umask) pwd=$PWD"','trap -p EXIT','cat arquivo-que-nao-existe-no-teste','echo SHELL_DO_OPERADOR_VIVO'].join('\n')+'\n';
  for(const [rotulo,comando,dep,esperado] of [['sucesso','node -e "process.exitCode=0"',true,0],['falha do aplicador','node -e "process.exitCode=2"',true,2],
    ['recusaria','node -e "process.exitCode=3"',true,3],['recusa do bloco',null,false,4]]){
    const d=destino();
    try{if(!dep)fs.rmSync(path.join(d,'scripts/conexao-staging.cjs'));
      const inicio=sessao(d,'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n',{interativo:true}).saida;
      const r=sessao(d,'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n'+gerar(d,'H0',comando)+POS,{interativo:true});
      assert.equal(codigo(r.saida),esperado,rotulo+': '+r.saida.slice(-400));
      assert.match(r.saida,/^SHELL_DO_OPERADOR_VIVO$/m,rotulo+': o shell não pode cair no erro seguinte');
      const antes=/^ANTES opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(inicio),pos=/^POS_BLOCO opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(r.saida);
      assert.ok(antes&&pos,rotulo);assert.equal(pos[1],antes[1],rotulo+': opções do shell');assert.equal(pos[2],antes[2],rotulo+': umask');assert.equal(pos[3].trim(),antes[3].trim(),rotulo+': diretório');
      assert.doesNotMatch(r.saida,/trap -- .*EXIT/,rotulo+': nenhum trap EXIT no shell do operador');
      assert.equal(temporarios(d),0,rotulo+': nenhum temporário restante');
    }finally{fs.rmSync(d,{recursive:true,force:true});}
  }
});

test('P2-A: duas colagens na mesma sessão (H0 e depois H1) — sem vazamento de temporário, shell vivo',()=>{
  const d=destino();
  try{const r=sessao(d,gerar(d,'H0','node -e "process.exitCode=0"')+gerar(d,'H1','node -e "process.exitCode=0"')+'echo DUAS_COLAGENS_OK\n',{interativo:true});
    assert.equal(linhas(r.saida,/^CODIGO_SAIDA_BLOCO=0$/),2,r.saida.slice(-400));assert.match(r.saida,/^DUAS_COLAGENS_OK$/m);
    assert.equal(linhas(r.saida,/^JA_PRESENTE /),7,'a 2ª colagem encontra os arquivos da 1ª');assert.equal(temporarios(d),0);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

// P3-1 da revisão de 8a43fd5: o `rm` do trap EXIT falhando (rm falso como função do shell do operador, herdada pelo
// subshell) não pode trocar o código principal; sai o aviso TEMPORARIO_NAO_REMOVIDO com o caminho que ficou.
const RM_FALSO='rm() { echo "rm falso: $*" >&2; return 1; }\n';
const aviso=s=>s.split(/\r?\n/).filter(l=>/^TEMPORARIO_NAO_REMOVIDO /.test(l));
test('P3-1: trap só no H0/H1 (a LIMPEZA não tem); falha do rm vira aviso e não muda o código',()=>{
  for(const modo of ['H0','H1'])assert.ok(b.gerar({modo,rotulo:'b659b14'}).split('\n').includes(`trap 'rm -rf -- "$T" || echo "TEMPORARIO_NAO_REMOVIDO $T"' EXIT`),modo);
  assert.doesNotMatch(b.gerar({modo:'LIMPEZA',rotulo:'b659b14'}),/^trap |mktemp -d/m);
});

test('P3-1: rm falso no trap com aplicador 0/1/2/3 e por sinal — código preservado, aviso com o temporário restante, registro listado',()=>{
  for(const [comando,esperado] of [['node -e "process.exitCode=0"',0],['node -e "process.exitCode=1"',1],['node -e "process.exitCode=2"',2],
    ['node -e "process.exitCode=3"',3],["bash -c 'kill -TERM $$'",143]]){
    const d=destino();
    try{const r=sessao(d,RM_FALSO+gerar(d,'H1',comando));
      assert.equal(codigo(r.saida),esperado,comando+': '+r.saida.slice(-300));
      assert.equal(linhas(r.saida,/^=== REGISTRO /),1,'o aplicador rodou e o registro foi listado');
      const a=aviso(r.saida);assert.equal(a.length,1,'um aviso');assert.equal(temporarios(d),1,'o temporário ficou');
      assert.equal(path.posix.basename(a[0].slice('TEMPORARIO_NAO_REMOVIDO '.length)),fs.readdirSync(path.join(d,'tmp'))[0],'o aviso identifica o temporário que ficou');
      assert.match(r.saida,/rm falso: -rf -- /);
    }finally{fs.rmSync(d,{recursive:true,force:true});}
  }
});

test('P3-1: recusa do bloco (4) seguida de falha do trap continua 4, com a mensagem da recusa e o aviso',()=>{
  const d=destino();
  try{const L=gerar(d,'H1','node -e "process.exitCode=0"').split('\n'),i=L.findIndex(x=>x.startsWith('prep 3 '))+1;L[i]='!!!'+L[i].slice(3);
    const r=sessao(d,RM_FALSO+L.join('\n'));assert.equal(codigo(r.saida),4,r.saida.slice(-300));
    assert.match(r.saida,/^CONTEUDO_DIVERGENTE database\/checks\/20261018_085_postcheck\.sql$/m);assert.equal(aviso(r.saida).length,1);
    assert.equal(linhas(r.saida,/^=== REGISTRO /),0,'aplicador não rodou');assert.deepEqual(presentes(d),[]);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('P3-1: caso normal remove o temporário sem aviso; LIMPEZA com rm falso continua 4 REMOCAO_FALHOU (sem aviso de temporário)',()=>{
  const d=destino();
  try{const r=rodar(d,'H1','node -e "process.exitCode=3"');assert.equal(codigo(r.saida),3);assert.equal(aviso(r.saida).length,0);assert.equal(temporarios(d),0);
    const l=sessao(d,RM_FALSO+gerar(d,'LIMPEZA'));assert.equal(codigo(l.saida),4,l.saida.slice(-300));
    assert.match(l.saida,/^REMOCAO_FALHOU scripts\/migration-085-086-staging\.cjs$/m);assert.equal(aviso(l.saida).length,0);
    assert.equal(presentes(d).length,7,'nada removido');
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});

test('P3-1: colagem interativa com falha do trap — shell vivo, código 2 legível, sem opções/umask/cwd/trap herdados',()=>{
  const d=destino();
  try{const POS='echo "POS_BLOCO opcoes=$- umask=$(umask) pwd=$PWD"\ntrap -p EXIT\necho "T_HERDADO=${T-ausente} codigo_herdado=${codigo-ausente}"\ncat arquivo-que-nao-existe-no-teste\necho SHELL_DO_OPERADOR_VIVO\n';
    const r=sessao(d,RM_FALSO+'echo "ANTES opcoes=$- umask=$(umask) pwd=$PWD"\n'+gerar(d,'H0','node -e "process.exitCode=2"')+POS,{interativo:true});
    assert.equal(codigo(r.saida),2,r.saida.slice(-400));assert.equal(aviso(r.saida).length,1);assert.match(r.saida,/^SHELL_DO_OPERADOR_VIVO$/m);
    const antes=/^ANTES opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(r.saida),pos=/^POS_BLOCO opcoes=(\S*) umask=(\d+) pwd=(.*)$/m.exec(r.saida);
    assert.ok(antes&&pos);assert.equal(pos[1],antes[1]);assert.equal(pos[2],antes[2]);assert.equal(pos[3].trim(),antes[3].trim());
    assert.doesNotMatch(r.saida,/trap -- .*EXIT/);assert.match(r.saida,/^T_HERDADO=ausente codigo_herdado=ausente$/m);
  }finally{fs.rmSync(d,{recursive:true,force:true});}
});
