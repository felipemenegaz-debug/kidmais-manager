// Evidência independente: ambiente sintético, sem carregar .env ou configurações de conexão herdadas.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const raiz = path.resolve(__dirname, '../../..');
const base = path.resolve('E:/kidmais-pg-descartavel/funil-oportunidades');
const registro = path.join(__dirname, 'cluster.json');
const bins = 'C:/Program Files/PostgreSQL/18/bin';
const permitido = new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA']);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => permitido.has(k.toUpperCase())));
function rodar(bin, args, log, extra = {}) {
  const fd = fs.openSync(path.join(__dirname, log), 'a');
  try {
    const r = spawnSync(bin, args, { cwd: raiz, env: {...env, ...extra}, stdio: ['ignore', fd, fd], windowsHide: true });
    if (r.status !== 0) throw new Error(`${path.basename(bin)} falhou (${r.status}, ${r.error?.code ?? ''}); ver ${log}`);
  } finally { fs.closeSync(fd); }
}
function estado() {
  const r = JSON.parse(fs.readFileSync(registro));
  if (!/^independente-20261114-[0-9a-f-]{36}$/.test(path.basename(r.pasta)) || path.dirname(path.resolve(r.pasta)) !== base || r.porta !== 55834) throw Error('alvo recusado');
  return r;
}
function opt(r) { return {KIDMAIS_POSTGRES_DESCARTAVEL:'kidmais_pacotes_v1_descartavel',KIDMAIS_DESCARTAVEL_PORTA:String(r.porta),KIDMAIS_DESCARTAVEL_AUTORIZACAO:`127.0.0.1:${r.porta}/kidmais_pacotes_v1_descartavel`}; }
async function main() {
  const modo = process.argv[2];
  if (modo === 'inicio') {
    if (fs.existsSync(registro)) throw Error('registro já existe');
    await new Promise((resolve,reject) => { const s=net.createServer(); s.once('error',reject); s.listen(55834,'127.0.0.1',()=>s.close(resolve)); });
    const r={pasta:path.join(base,`independente-20261114-${randomUUID()}`),porta:55834,criadoEm:new Date().toISOString()};
    fs.mkdirSync(r.pasta,{recursive:true});
    fs.writeFileSync(registro,JSON.stringify(r,null,2),{flag:'wx'});
    fs.writeFileSync(path.join(r.pasta,'.proprietario.json'),JSON.stringify(r));
    rodar(path.join(bins,'initdb.exe'),['-D',path.join(r.pasta,'dados'),'-U','kidmais_descartavel','-A','trust','--encoding=UTF8','--locale=C'],'initdb.log');
    rodar(path.join(bins,'pg_ctl.exe'),['-D',path.join(r.pasta,'dados'),'-l',path.join(__dirname,'servidor.log'),'-o','-c listen_addresses=127.0.0.1 -p 55834 -c cluster_name=kidmais_descartavel','-w','-t','60','start'],'pg-ctl.log');
    console.log('Cluster próprio iniciado: 127.0.0.1:55834, kidmais_descartavel');
  } else if (modo === 'exec') {
    const r=estado();
    rodar(process.execPath,process.argv.slice(4),process.argv[3],opt(r));
    console.log(`${process.argv[3]} PASS`);
  } else if (modo === 'limpar') {
    const r=estado();
    const marca=JSON.parse(fs.readFileSync(path.join(r.pasta,'.proprietario.json')));
    if (JSON.stringify(marca)!==JSON.stringify(r) || fs.realpathSync(r.pasta)!==path.resolve(r.pasta)) throw Error('marca/caminho divergente');
    rodar(path.join(bins,'pg_ctl.exe'),['-D',path.join(r.pasta,'dados'),'-m','fast','-w','-t','60','stop'],'pg-ctl.log');
    if (fs.existsSync(path.join(r.pasta,'dados/postmaster.pid'))) throw Error('cluster ainda ativo');
    function semLinks(p) { for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);if(fs.lstatSync(q).isSymbolicLink())throw Error('link recusado');if(e.isDirectory())semLinks(q);} }
    semLinks(r.pasta);
    fs.rmSync(r.pasta,{recursive:true});
    fs.writeFileSync(path.join(__dirname,'cluster-limpeza.json'),JSON.stringify({...r,parado:true,removido:!fs.existsSync(r.pasta),fim:new Date().toISOString()},null,2));
    console.log('Cluster próprio parado e removido; logs preservados');
  } else throw Error('modo recusado');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
