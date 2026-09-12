/* eslint-disable @typescript-eslint/no-require-imports */
const fs=require('node:fs');
function preservar(){
 const files=['next-env.d.ts','tsconfig.json'].map(p=>[p,fs.readFileSync(p)]);
 const restaurar=()=>{for(const [p,bytes] of files)fs.writeFileSync(p,bytes);};
 process.once('exit',restaurar);return restaurar;
}
module.exports={preservar};
