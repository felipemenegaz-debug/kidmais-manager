const receita=require('../../../scripts/regressao-v1-postgres-receita.cjs');
(async()=>{const {admin}=await receita.conectarAdmin();try{await receita.restaurar(admin,'kidmais_pacotes_v1_descartavel','122');console.log('Banco de trabalho restaurado do modelo122 canônico');}finally{await admin.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
