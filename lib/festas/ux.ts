export const nomes:Record<string,string>={PROXIMA:'Próxima',HOJE:'Hoje',REALIZADA:'Realizada',CANCELADA:'Cancelada',REMOVIDA:'Removida por engano',ANTES:'Antes da festa',DEPOIS:'Depois da festa',PENDENTE:'A fazer',CONCLUIDA:'Concluída',ABERTA:'Em aberto',EM_TRATAMENTO:'Em cuidado',RESOLVIDA:'Resolvido',ENCAMINHADA:'Encaminhado',NAO_SE_APLICA:'Não se aplica',NORMAL:'Normal',IMPORTANTE:'Importante',ATENCAO:'Atenção',CRITICA:'Precisa de atenção',CLIENTE:'Cliente',OPERACIONAL:'Equipe',HORA_EXTRA:'Hora extra',ADICIONAL:'Item adicional',ALTERACAO_OPERACIONAL:'Pedido da equipe',ALTERACAO_CONTRATUAL:'Alteração da contratação'};
export const amigavel=(value:unknown)=>nomes[String(value)]??String(value??'Não informado');
export function erroHumano(value:unknown){const text=String(value??'Não foi possível salvar. Tente novamente.');
 if(/FESTA_|capacidade|representante autorizado|autoconcess/i.test(text))return 'Você não tem acesso para fazer esta alteração. Peça ajuda à Gestão.';
 if(/atualizad.*outra|outra operação|chave já|revis[aã]o.*conflit/i.test(text))return 'Esta informação foi alterada por outra pessoa enquanto você estava preenchendo. Seus dados não foram perdidos.';
 if(/VERSION_MISMATCH|versão contratual|vigência/i.test(text))return 'A contratação desta festa mudou. Atualize as informações e confira seu registro.';
 if(/clone|016|migration|ambiente/i.test(text))return 'Esta área ainda não está disponível neste ambiente.';
 if(/CSRF|sessão/i.test(text))return 'Sua sessão precisa ser atualizada. Entre novamente para continuar.';
 return text;
}
