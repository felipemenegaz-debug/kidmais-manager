/**
 * Pedido de parar (opt-out). Bloquear é definitivo (nem a equipe envia depois), então há dois níveis e uma regra de
 * mistura:
 *  - ESTRITO (regras; recepção e worker): recusa + objeto de contato na mesma oração ("não autorizo o envio de
 *    mensagens", "me tira da lista", "não entrem mais em contato"), também no pedido FORMAL por substantivo ("solicito a
 *    exclusão do meu número", "peço a remoção do meu contato da lista", "quero ser descadastrada"), sem material ("esse
 *    PDF", "a tabela") nem outro objeto ("a festa", "o carro", "meu marido") logo depois.
 *  - AMPLO (só para VALIDAR o trecho que o modelo apontou como pedido de parar): pistas de recusa e de contato mais largas
 *    ("me deixem em paz", "esqueçam este número"), com as mesmas exclusões. O modelo nunca bloqueia sem esse trecho.
 *  - Com outra pergunta ou pedido na mesma mensagem ("…mas quanto custa?", "…me passa pra uma pessoa") o pedido é
 *    AMBÍGUO: nada é enviado e a conversa vai para a equipe, sem o bloqueio definitivo. Também é AMBÍGUO parar só a FORMA
 *    ("pode parar de mandar áudio?"), só por um tempo ("não me liga agora, tô no trabalho") ou só uma parte ("me
 *    descadastra das promoções, mas continua mandando os lembretes das parcelas").
 * "Cancelar a festa", "parar o carro", "não mande esse PDF" e "que horas temos que sair?" não são pedido de parar.
 */
export type PedidoParar = { tipo: 'INEQUIVOCO' | 'AMBIGUO'; trecho: string };

const normal = (t: string) => String(t ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const limpo = (t: string) => normal(t).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
/**
 * Como `limpo`, mas a vírgula (e ";", ":") fica como palavra: separa a recusa de outra oração na mesma frase ("não quero
 * fechar agora, pode me mandar mensagem mês que vem"). "Por favor" e afins saem junto com as vírgulas em volta ("me
 * tira, por favor, da lista").
 */
const comVirgula = (t: string) => normal(t).replace(/[,;:]/g, ' , ').replace(/[^\p{L}\p{N}\s,]/gu, ' ').replace(/\s+/g, ' ')
  .replace(/(?:, )?\b(?:por favor|porfavor|por gentileza|pfvr|pfv|pf|pls|plis|please)\b(?: ,)?/g, ' ').replace(/\s+/g, ' ').trim();
const semCortesia = (t: string) => t.replace(/\b(?:por favor|porfavor|por gentileza|pfvr|pfv|pf|pls|plis|please|obrigad[oa]|ok)\b/g, ' ').replace(/\s+/g, ' ').trim();

const EXATO = /^(?:parar|pare|para|sair|stop|chega|basta|descadastrar|descadastre|descadastro|descadastramento|pode parar|podem parar|parem|pare ja|para ja|parem ja|para com isso|pare com isso|parem com isso|chega disso|basta disso|nao me envie mensagens|exclusao|excluir|me exclua|me exclui|me remova|me remove|me retire|me tire|me tira|solicito (?:a )?exclusao|solicito (?:o )?descadastramento|quero sair|quero sair da lista|remover|me remover|(?:exclua|exclui|remova|remove|retire|retira|tire|tira|descadastre|descadastra) me|unsubscribe|unsub|opt out|optout)$/;
/** Outra pessoa: "tira o nome da minha sogra da lista", "não liguem pro meu marido" não é o cliente pedindo para sair. */
const TERCEIRO = String.raw`(?:marido|esposa|esposo|mulher|namorad[oa]s?|noiv[oa]s?|sogr[oa]s?|mae|pai|filh[oa]s?|ti[oa]s?|avo|avos|vovo|prim[oa]s?|irma[os]?|irmaos|cunhad[oa]s?|amig[oa]s?|convidad[oa]s?|crianc\w*|vizinh[oa]s?|madrinha|padrinho|sobrinh[oa]s?|colegas?|pessoal|familia|turma|galera|visita\w*|ele|ela|eles|elas)`;
/** Depois do verbo, a forma, o canal ou o tempo, não o contato: "não me escreve em inglês", "não me liguem no fim de semana". */
const SO_FORMA = String.raw`(?:a|o|os|as|esse|essa|este|esta|isso|de volta|de (?!novo\b|vez\b|uma vez\b)\w+|em|por|pelo|pela|no|na|nesse|neste|com|assim|desse|dessa|sem|so|antes|depois|ate|hoje|agora)`;
/** Tirar/remover/apagar; negado é o contrário ("não quero que me excluam da lista", "não precisa me tirar", "não me tira"). */
const REMOVER = String.raw`(?<!\b(?:nao|nem|nunca) (?:(?:quero|queria|precisa|precisam|vou|vao|deixa|deixem|pode|podem|deve|devem|tem que)(?: mais)?(?: que)? )?(?:me )?)(?:tira|tire|tirem|tirar|retira|retire|retirem|retirar|remove|remova|removam|remover|exclui|exclua|excluam|excluir|apaga|apague|apaguem|apagar|bloqueia|bloqueie|bloqueiem|bloquear|deleta|delete|deletem|deletar|tirarem|retirarem|removerem|excluirem|apagarem|bloquearem|deletarem|some com|suma com|sumam com)`;
/**
 * Recusa que pede objeto de contato depois ("não quero receber", "me tira da", "removam meu"). "Para"/"chega" ficam em
 * PARE_COM; tirar/apagar SEM "me" só vale com o próprio contato (PROPRIO): "apaga a mensagem que mandei" não.
 */
const RECUSA = String.raw`(?:(?:nao|num) (?:quero|desejo|autorizo|aceito|permito|gostaria de)(?: mais)?(?: que)?|(?:prefiro|preferia|gostaria de|peco (?:para|pra|que)|favor)(?: que)? nao|nao tenho (?:mais )?interesse em|(?:nao|num) (?:me )?(?:mande|mandem|manda|envie|enviem|envia|mandar|enviar|mandarem|enviarem|mandasse|mandassem|enviasse|enviassem)(?: mais)?|me ${REMOVER})`;
/** "Lista de convidados", "lista de preços" e "lista de espera" não são lista de contato; "lista", "lista de transmissão" e "lsita" (digitação) são. */
const LISTA = String.raw`(?:l(?:is|si)tas?(?! d[eao]s? (?:convidad|presen|espera|preco|valor|iten|nome|crianc|doce|salgad|bebida|brinquedo|music|compra|material|tarefa|opc|pacote|sabor|tema|decorac|aniversari|fornecedor))|grupo (?:de )?(?:transmiss\w*|divulgac\w*|promoc\w*|ofertas?|clientes|vendas|marketing))`;
/** O próprio contato do cliente ("tira meu número", "remove esse telefone daí", "exclui meu cadastro"); "o cadastro da festa" não. */
const PROPRIO = String.raw`(?:contato|contatos|numero|telefone|celular|${LISTA}|whats\w*|zap|cadastro(?! d[aoe]s? (?:festa|evento|crianc|filh|convidad|aniversari|reserva)))`;
/** "Receber" mensagens, não "receber os convidados", "receber o kit festa" ou "receber a decoração". */
const RECEBER = String.raw`receber(?! (?:o|a|os|as|um|uma|seu|sua|seus|suas|meu|minha|meus|minhas|nosso|nossa) (?!mensage|msg|propaganda|promoc|contato|ligac|notificac|spam|comunicac|publicidade|oferta|novidade|informac|informativ|newsletter|e ?mail|lista|disparo|envio)\w)`;
const CONTATO = String.raw`(?:mensage\w*|msg\w*|contatad[oa]s?|contactad[oa]s?|contatar|contactar|(?:incomodad|perturbad)[oa]s?(?! (?:no|na|nos|nas|durante|antes|depois|ate|em|de manha|de noite|a noite|a tarde|hoje|amanha|agora|nesse|neste)\b)|${PROPRIO}|propaganda\w*|promoc\w*|publicidade|ofertas|comunicados|informativos|newsletter|envio\w*|disparo\w*|notificac\w*|spam|${RECEBER}|me (?:mandar|mandando|enviar|enviando|ligar|ligando|chamar|chamando|procurar|procurando|incomodar|incomodando|escrever|escrevendo|perturbar|perturbando)\b(?! de (?!novo\b|vez\b|uma vez\b)))`;
/**
 * Palavra entre a recusa e o contato: não atravessa vírgula, conjunção, outro pedido nem outra pessoa ("pare de me
 * ignorar e responde minha mensagem", "não quero fechar agora me manda mensagem", "tira meu marido da lista"). Depois de
 * "que" o pedido é a própria recusa ("não quero que você me mande mensagem").
 */
const PALAVRA = String.raw`\s+(?!(?:,|e|mas|que|porque|pq|pois|se|quando|ou|entao|pode|podem|poderia|poderiam|consegue|conseguem|tir\w*|retir\w*|remov\w*|exclu\w*|apag\w*|bloque\w*|delet\w*|${TERCEIRO})(?=\s|$)|(?<!\bque(?: voce| voces| vc| vcs)? )(?:me|nos) (?:manda|mande|envia|envie|passa|passe|fala|fale|diz|diga|liga|ligue|responde|responda|chama|chame|avisa|avise|explica|explique|confirma|confirme|informa|informe)\b)\S+`;
/** Verbo de envio/contato depois de "para de"/"deixa de" ("para de me mandar", "deixem de me ligar", "parem de encher meu zap"). */
const ENVIAR = String.raw`(?:mandar|manda|mandando|enviar|envia|enviando|escrever|ligar|ligando|chamar(?! de (?!novo\b))|disparar|entrar em contato|encher(?= *$| (?:o|meu|minha) (?:saco|zap|whats\w*|celular|telefone)\b)|me (?:mand\w*|envi\w*|escrev\w*|lig\w*|cham\w*\b(?! de (?!novo\b))|incomod\w*|perturb\w*|ench\w*|procur\w*|contat\w*|contact\w*|amol\w*|aborrec\w*)|ficar (?:me )?(?:mandando|enviando|ligando|chamando)|incomodar|perturbar)`;
const PARE = String.raw`(?:pare|para|parem|parar|pode parar|podem parar)`;
/** "Para com as mensagens", "chega de tanta propaganda", "para d manda msg", "pode parar por favor de mandar mensagem". */
const PARE_COM = String.raw`(?:${PARE}|chega|basta)(?: (?:ja|agora|logo|imediatamente))* (?:de|d|com|dess[ea]s?|dest[ea]s?|d[ao]s?)(?: (?:me|ficar|ficarem|tanta|tanto|tantas|tantos|ess[ea]s?|est[ea]s?|as|os|a|o|isso|isso de|de|toda|todo|esse tipo de|essa coisa de))* (?:${CONTATO}|${ENVIAR})`;
/** Recusas que já dizem "contato" sozinhas. */
const AUTOSSUFICIENTE = String.raw`(?:(?:nao|nunca mais) (?:me )?(?:procure|procurem|contate|contatem|ligue|liguem|chame|chamem|escreva|escrevam|incomode|incomodem|perturbe|perturbem|mande|mandem|envie|enviem)(?: mais)?\b(?! ${SO_FORMA}\b)|`
  // Rodada 15: infinitivo pessoal e subjuntivo depois de "pedir pra vocês…", "gostaria que…": "queria pedir pra vocês não me
  // mandarem mais nada", "peço que nunca mais me procurem", "pra não me ligarem mais". Mandar/enviar só com "nada"
  // ("não me mandarem mais nada"); "não me mandarem o PDF" fica com o OBJETO (material) e não bloqueia.
  + String.raw`(?:nao|nunca mais) (?:me )?(?:mandarem|enviarem|mandassem|enviassem|mandar|enviar)(?: mais)? (?:nada|nada mais|mais nada|nenhuma (?:mensage\w*|msg\w*|coisa)|coisa nenhuma)\b(?! d[eao]s?\b)|(?:nao|nunca mais) (?:me )?(?:procurarem|procurassem|ligarem|ligassem|contatarem|contatassem|chamarem|chamassem|escreverem|escrevessem|incomodarem|incomodassem|perturbarem|perturbassem)(?: mais)?\b(?! ${SO_FORMA}\b)|`
  + String.raw`nao (?:entrem|entre|entrar)(?: mais)? em contato|(?:${PARE}|deixa|deixe|deixem|deixar) d(?:e)? ${ENVIAR}|sair (?:d[aeo]s?|dess[ea]s?|dest[ea]s?) (?:${LISTA}|mailing)|(?:nao aguento|nao suporto|cansei de|(?:to|tou|estou) cansad[oa] de) (?:mais )?(?:(?:receber|recebendo|ficar recebendo|tanta|tanto|tantas|tantos|ess[ea]s?|as|os|de|d[ao]s?) )*(?:mensage\w*|msg\w*|propaganda\w*|promoc\w*|spam|disparo\w*|notificac\w*)|descadastr\w*|desinscrev\w*|cancel\w* (?:o |a |meu |minha )?(?:cadastro|inscricao|assinatura|recebimento|envio)|(?:please )?stop (?:texting|messaging|sending|contacting|calling|spamming|bothering)|stop (?:the |your |these |all )?(?:messages|message|texts|msgs|spam)|unsubscribe|opt out|optout|don ?t (?:text|message|contact|call) me|do not (?:text|message|contact|call) me)`;
/**
 * Imperativo de conversa ("nunca mais me escreve", "não me liga mais", "não manda mais nada"): é igual ao indicativo ("ela
 * não me liga de volta", reclamação), então só vale no começo da oração, depois de vocativo ou interjeição — ou depois
 * de "(e) depois disso", "a partir de agora", "daí pra frente" (rodada 16: "me manda só o pdf e depois disso não me manda
 * mais nada"; o pedido do material junto faz o pedido ser AMBÍGUO: equipe em silêncio, sem enviar o PDF).
 */
const COLOQUIAL = String.raw`(?:^|, |\b(?:e )?(?:depois(?: disso| dai)?|a partir (?:dai|de agora|de hoje)|dai (?:pra|para) (?:frente|diante)|em seguida)(?: ,)? )(?:(?:oi|ola|olha|ei|moco|moca|gente|pessoal|serio|cara|mano|mana|amiga|amigo|querida|querido|oxe|vixe|aff\w*|bah|tche|uai|ok|ta|entao|bom dia|boa tarde|boa noite|ja falei|ja disse|ja pedi|eu ja falei|eu ja disse|eu ja pedi|pela ultima vez|pelo amor de deus|sai fora|cai fora|vaza|vaza daqui|some daqui|xo|chega|chega disso|por enquanto|por ora|por agora|no momento|neste momento|nesse momento|agora)(?: ,)? )*(?:nao|nunca mais|nem|num) (?:me (?:procura|contata|contacta|liga|chama|escreve|incomoda|perturba|amola|aborrece|manda|envia)(?: mais)?|(?:manda|envia) (?:mais nada|nada mais|mais))\b(?! ${SO_FORMA}\b)`;
/**
 * "Me remove daí", "me tira daqui", "me exclui dessa", "pode me remover" (no fim da oração): sair da lista sem dizer
 * "lista". "Me tira dessa dúvida" e "não quero que me excluam" não.
 */
const SAIR_DAI = String.raw`(?:(?<!\b(?:nao|nem|nunca)(?: \S+){0,2} )me (?:tira|tire|tirem|tirar|retira|retire|retirem|retirar|remove|remova|removam|remover|exclui|exclua|excluam|excluir|apaga|apague|descadastra|descadastre)(?: (?:dai|daqui|dali|de ai|de la)\b|(?: (?:dessa|desse|disso|dessas|desses))?(?= *(?:,|$)))|(?:tira|tire|retira|retire|remove|remova|exclui|exclua|descadastra|descadastre) me(?: (?:dai|daqui|dali))?(?= *(?:,|$)))`;
/** As mensagens como sujeito, no fim da oração: "essas mensagens precisam parar imediatamente", "quero que as propagandas parem". */
const SUJEITO = String.raw`(?:mensage\w*|msgs?|propagandas?|promocoes|spam|disparos?|notificac\w*|publicidades?|ligacoes)(?:\s+(?!(?:se|quando|ou|porque|pq|festa\w*|evento\w*|music\w*|som|carro\w*|cobranc\w*|boleto\w*|parcela\w*|pagamento\w*|horario\w*)\b)\S+){0,6}?\s+(?:(?:precis\w+|tem que|tem q|tem de|devem|deve|podem|pode) (?:parar|acabar|cessar)|parem|acabem|cessem)(?: (?:,|imediatamente|agora|ja|logo|urgente|urgentemente|serio|de vez|de uma vez|ok|viu|ta|ne|entendeu|obrigad\w*|com isso|de chegar|de vir|aqui|pra mim|no meu (?:whats\w*|zap|celular|numero)))*$`;
/**
 * Pedido FORMAL por substantivo: exclusão/remoção/retirada/descadastramento/cancelamento/bloqueio + objeto de contato,
 * ligados só por artigo, preposição ou possessivo ("a exclusão do meu número", "remoção do meu contato da lista",
 * "cancelamento do meu cadastro", "exclusão da lista", "cancelamento do envio de comunicados"). "Cancelamento da festa",
 * "bloqueio da data" e "cancelamento do envio do contrato" não passam. Rodada 16: "baixa" ("providenciar a baixa do meu
 * número na lista de envios"); "baixa do boleto" e "baixa no valor" não têm objeto de contato.
 */
const NOMINAL = String.raw`(?:exclusao|remocao|retirada|descadastramento|descadastro|cancelamento|bloqueio|desinscricao|baixa)(?:\s+(?:definitiv[oa]|total|complet[oa]|imediat[oa]|permanente|urgente))?(?:\s+(?:d[oae]s?|n[oa]s?|meus?|minhas?|est[ea]s?|ess[ea]s?|o|a|os|as|nossos?|nossas?|seus?|suas?|vossos?|vossas?|dest[ea]s?|dess[ea]s?|tod[oa]s?))*\s+(?:numero|numeros|contato|contatos|cadastro(?! d[aoe]s? (?:festa|evento|crianc|filh|convidad|aniversari|reserva))|telefone|celular|whats\w*|zap|lista|listas|dados|inscricao|e ?mail|comunicac\w*|divulgac\w*|mailing|mensagens|comunicados|notificacoes|disparos|propagandas|(?:envio|envios|recebimento) (?:de|d[aeo]s?) (?:mensage\w*|comunicad\w*|ofertas?|promoc\w*|propaganda\w*|publicidade\w*|marketing|notificac\w*|informativ\w*|novidades|campanhas?|anuncios?))`;
/** "Quero ser excluída", "gostaria de ser removido da lista". */
const PASSIVO = String.raw`(?:quero|queria|gostaria de|desejo|peco (?:para|pra)|solicito|preciso|favor)\s+(?:ser\s+)?(?:excluid[oa]s?|removid[oa]s?|retirad[oa]s?|descadastrad[oa]s?)`;
const RECUSA_AMPLA = String.raw`(?:${RECUSA}|${REMOVER}|${PARE}|chega|basta|esquec\w*|deix\w* (?:eu |me )?em paz|some|sumam|nunca mais (?:me )?\w+|nao (?:quero|desejo)(?: mais)? (?:saber|ouvir falar|falar))`;
const CONTATO_AMPLO = String.raw`(?:${CONTATO}|em paz|de (?:voces|vcs)|com (?:voces|vcs)|comigo|(?:este|esse|meu) numero)`;
/**
 * Objeto que tira o sentido de opt-out: material da conversa ou outro assunto ("não me mande mais, a tabela já tenho");
 * na mesma oração, também a forma ("parar de mandar áudio"), outra pessoa ("parem de mandar mensagem pra minha mãe") e
 * a mensagem da festa ("não quero mensagem no bolo", "não quero meu telefone no convite"); tirar o número DO CONTRATO é
 * mudar o contrato.
 */
const ARTIGO = String.raw`(?:a|o|as|os|esse|essa|esses|essas|este|esta|isso|isto|aquele|aquela|de novo|mais|me|pra mim|mesmo|mesma|mesmos|mesmas)`;
const OBJETO = new RegExp([
  String.raw`^(?:\s*(?:,|(?:${ARTIGO}|em|por|pelo|pela|no|na|nos|nas|com|nesse|neste)\b))*\s*(?:tabela|cardapio|foto|fotos|pdf|video|videos|material|materiais|endereco|link|orcamento|arquivo|documento|festa|festas|carro|reserva|pacote|data|contrato|evento|pagamento|parcela|boleto|bolo|docinhos|salgados|decoracao)\b`,
  String.raw`^\s+d[oa]s? (?:contrato|pagamento|parcela\w*|boleto\w*|orcamento|reserva|pacote|cardapio|documento)\b`,
  String.raw`^(?:\s*(?:${ARTIGO}|pra|pro|para|pros|pras|ao|aos|de|do|da|dos|das|em|por|no|na|com|meu|minha|meus|minhas|nosso|nossa|seu|sua|mensage\w*|msg\w*|nada|coisa\w*|ligac\w*)\b)*\s*(?:audio\w*|voz|figurinha\w*|sticker\w*|${TERCEIRO})\b`,
  String.raw`^(?:\s+d[eao] (?:telefone|celular|contato|whats\w*))?\s+(?:de (?:parabens|aniversario|boas vindas|agradecimento|carinho|feliz)|(?:no|na|nos|nas|do|da|dos|das) (?:bolo|telao|convite\w*|painel|lembranc\w*|topo|camis\w*|cart[ao]\w*|placa|faixa|tag\w*|caneca\w*|mural))\b`,
].join('|'));
/** Parar só a forma ("pode parar de mandar áudio?", "não me manda áudio, só texto"): quer continuar o contato. Figurinha
 * e sticker o atendimento nunca manda ("para de me mandar figurinha, Joana… era pro grupo"): nem isso é parar. */
const FORMA = new RegExp(String.raw`\b(?:${PARE} (?:de|d|com)|deixa de|deixe de|deixem de|chega de|(?:nao|num|nem) (?:me )?(?:manda|mande|mandem|envia|envie|enviem|mandar|enviar)(?: mais)?)(?: (?:me|mais|ess[ea]s?|os|as|tanto|tanta|tantos|tantas|mandar|enviar|ficar|mandando|enviando))* (?:audio\w*|mensage\w* de (?:voz|audio)|voz)\b`);

/**
 * Rodada 18: recusa que já NOMEIA o contato ("me tira da lista", "parem de mandar mensagem") não ganha objeto depois da
 * vírgula: "me tira da lista, a festa foi um desastre" é o pedido de parar seguido de outra frase. Sem contato nomeado
 * ("não me manda mais, a tabela eu já tenho"), o objeto depois da vírgula continua valendo (não é parar).
 */
const CONTATO_NOMEADO = /\b(?:lista|listas|numero|contato|cadastro|mensage\w*|msg\w*|whats\w*|zap|telefone|celular|propaganda\w*|promoc\w*|transmissao|e ?mail)\b/;
function casa(texto: string, padrao: RegExp) {
  for (const m of texto.matchAll(padrao)) {
    const resto = texto.slice((m.index ?? 0) + m[0].length);
    if (!OBJETO.test(resto) || (CONTATO_NOMEADO.test(m[0]) && /^\s*,/.test(resto))) return m[0];
  }
  return null;
}
/** Rodada 24: vocativo, interjeição ou desabafo depois da recusa ("…propagandas mano", "…pqp", "…eu nunca pedi isso"). */
const VOCATIVO_FIM = String.raw`(?:mano|mana|cara|vei|veio|velho|meu|brother|bro|irmao|parca|tio|tia|moco|moca|gente|pessoal|amigo|amiga|querid[oa]|serio|po|poxa|pqp|porra|affs?|aff+|oxe|vixe|uai|credo|caramba|kk+|rs+|haha\w*|ja falei|ja disse|ja pedi|eu (?:ja|nunca|nem)|nunca pedi|toda (?:hora|semana)|todo (?:dia|santo dia)|por favor|pf|pfv|obrigad\w*|tchau)`;
/**
 * Rodada 19: recusa coloquial pelo lugar ("sai do meu zap", "some do meu whats", "vaza do meu celular", "suma da minha
 * vida") e "me deixa em paz" / "me esquece". Só o imperativo, sem negação antes ("minha filha não sai do meu pé" não);
 * "vou sair do zap" (infinitivo: a própria pessoa) não.
 */
const SUMA = String.raw`(?:(?<!\b(?:nao|nem|nunca|num) )(?:sai|saia|saiam|some|suma|sumam|vaza|vazem|cai fora|caiam fora|desaparece|desapareca|desaparecam)(?: daqui)? (?:do|da|de) (?:meu |minha |nosso |nossa )?(?:zap|zapzap|zapp|whats\w*|wpp|celular|cel|telefone|numero|vida|pe)|(?<!\b(?:nao|nem|nunca|num) )(?:sai|saia|saiam|cai|caia|caiam|vaza|vazem)(?: (?:fora|daqui))+(?= *(?:,|$))|(?<!\b(?:nao|nem|nunca|num) )(?:(?:sai|saia|saiam|cai|caia|caiam) (?:fora|daqui)(?: daqui)?|vaza|vazem|some|suma|sumam)(?: daqui)? (?:com|c) (?:(?:ess[ea]s?|est[ea]s?|as|os|a|o|sua|suas|seu|seus|tanta|tantas|tanto|tantos|isso de)\s+)?(?:propaganda\w*|promoc\w*|mensage\w*|msg\w*|spam|disparo\w*|notificac\w*|ofertas?|publicidade\w*|marketing|correntes?|zap|whats\w*)(?= *(?:,|$)|\s+(?:nao|nem|nunca|chat\w*|irritant\w*|insuportave\w*|de (?:voces|vcs)|daqui|ai|que saco|que chato|pelo amor|${VOCATIVO_FIM})\b)|(?<!\b(?:nao|nem|nunca|num) )me (?:deixa|deixe|deixem) em paz|(?<!\b(?:nao|nem|nunca|num) )me (?:esquece|esqueca|esquecam)(?= *(?:,|$)))`;
const ESTRITO = [new RegExp(String.raw`\b${SUMA}\b`, 'g'), new RegExp(String.raw`\b${AUTOSSUFICIENTE}\b`, 'g'), new RegExp(COLOQUIAL, 'g'), new RegExp(String.raw`\b${SAIR_DAI}\b`, 'g'), new RegExp(String.raw`\b${NOMINAL}\b`, 'g'), new RegExp(String.raw`\b${PASSIVO}\b`, 'g'), new RegExp(String.raw`\b${PARE_COM}\b`, 'g'), new RegExp(String.raw`\b${RECUSA}\b(?:${PALAVRA}){0,6}?\s+${CONTATO}\b`, 'g'), new RegExp(String.raw`\b${REMOVER}\b(?:${PALAVRA}){0,6}?\s+${PROPRIO}\b`, 'g'), new RegExp(String.raw`\b${SUJEITO}`, 'g')];
const AMPLO = [...ESTRITO, new RegExp(String.raw`\b${RECUSA_AMPLA}\b(?:\s+\S+){0,6}?\s+${CONTATO_AMPLO}\b`, 'g'), new RegExp(String.raw`\b${CONTATO_AMPLO}\b(?:\s+\S+){0,4}?\s+${RECUSA_AMPLA}\b`, 'g')];

/** O trecho é, por si só, um pedido para não receber mais mensagens/contato (nível estrito)? */
export function trechoDeOptOut(trecho: string) {
  return EXATO.test(semCortesia(limpo(trecho))) || ESTRITO.some((re) => !!casa(comVirgula(trecho), re));
}
/** Validação do trecho apontado pelo MODELO (nível amplo, mesmas exclusões). */
export function trechoDeOptOutAmplo(trecho: string) {
  return trechoDeOptOut(trecho) || AMPLO.some((re) => !!casa(limpo(trecho), re));
}
/** O trecho fala de contato/mensagens (mesmo sem recusa clara)? */
export function trechoFalaDeContato(trecho: string) {
  return new RegExp(String.raw`\b${CONTATO_AMPLO}\b`).test(limpo(trecho));
}

/**
 * Outra coisa a responder na mesma mensagem: pergunta (palavra interrogativa), pedido (verbo de pedido NÃO negado),
 * pessoa, ou assunto que costuma ser pergunta mesmo sem "?" (valor, tabela, endereço, vaga, pagamento). Substantivo de
 * assunto sozinho ("as comunicações do buffet", "a festa") não é pedido.
 */
const ACIONAVEL = new RegExp([
  String.raw`\b(?:quanto|qto|qual|quais|onde|quando|como|teria|tem como|poderia|consegue|conseguem|da pra|gostaria de saber|quero saber|queria saber|preciso saber|duvida)\b`,
  String.raw`\bme (?:manda|mande|passa|passe|envia|envie|diz|diga|fala|fale|informa|informe|liga|ligue|explica|explique|confirma|confirme|avisa|avise|responde|responda|ve|veja)\b`,
  String.raw`\b(?:quero|queria|gostaria de|preciso|vou) (?:falar|fechar|reservar|cancelar|remarcar|pagar|ver|saber|contratar|marcar)\b`,
  String.raw`\b(?:cancela|cancele|cancelem|cancelar|remarca|remarque|remarcar|fecha|feche|reserva|reserve|paga|pague)\b`,
  // "Essa pessoa" é de quem se fala ("número errado, não conheço essa pessoa"), não pedido de pessoa.
  String.raw`\b(?:atendente|(?<!\b(?:essa|esta|dessa|desta|outra|nenhuma|tal) )pessoa|alguem|responsavel|falar com|ligar pra|gerente)\b`,
  String.raw`\b(?:valor|valores|preco|precos|tabela|endereco|vaga|vagas|livre|livres|disponivel|disponibilidade|agenda|cardapio|pix|boletos?|parcelas?|comprovantes?|reembolso|multa)\b`,
  // Só uma parte ("…mas continua mandando os lembretes da festa"); "e continua mandando" é reclamação, não pedido.
  String.raw`(?<!\b(?:e|ja|ainda|se|voce|voces|vc|vcs) )\b(?:continua|continue|continuem|pode continuar|podem continuar|mantenha|mantenham)(?: (?:me|so|apenas|somente))* (?:mandando|enviando|avisando|lembrando|informando|mandar|enviar|avisar|lembrar|informar)(?! (?:mensage\w*|msg\w*|propaganda\w*|promoc\w*|spam|isso|ess[ea]s?|nada|tudo|todo|toda|sempre|direto|assim|mesmo|ai)\b) \S+`,
  // "…só quero os avisos da minha festa" ("quero" já saiu como embrulho na mesma oração).
  String.raw`\b(?:so|somente|apenas)(?: (?:quero|preciso|aceito))?(?: receber)? (?:os|as) (?!descadastr|exclus|remoc)\w+`,
  // Outra forma ou outro canal: "prefiro escrito", "só por mensagem", "por escrito".
  String.raw`\b(?:prefiro|preferia|preferiria) (?:que (?:me )?(?:mand|envi|lig|escrev|cham)\w*|(?:receber |ser contatad[oa] )?(?:por|pelo|pela|via|no|na|em) \w+|mensage\w*|msg|escrito|texto|whats\w*|zap|e ?mail|ligac\w*|telefone|tudo)\b|\b(?:so|somente|apenas) (?:por|pelo|pela|via) (?:escrito|texto|mensage\w*|msg|whats\w*|zap|e ?mail|ligac\w*|telefone)\b|\bpor escrito\b|\b(?:so|somente|apenas) (?:texto|escrito)\b`,
  // Só por um tempo: "não me liga agora, tô no trabalho", "parem de mandar mensagem de madrugada".
  // Rodada 29 (h29 aa79): "mais pra frente eu procuro vcs", "futuramente eu chamo", "quando precisar eu chamo" — volta
  // anunciada pelo próprio cliente: pausa (equipe em silêncio), não bloqueio definitivo.
  String.raw`\b(?:por enquanto|nesse horario|neste horario|esse horario|de madrugada|nesse momento|neste momento|mais tarde|outra hora|semana que vem|mes que vem|(?:to|tou|estou) (?:no trabalho|no servico|trabalhando|dirigindo|em reuniao|ocupad[oa])|em reuniao|depois (?:eu|te|a gente|conversamos|falamos|ligo|retorno)|mais (?:pra|para) frente|mais adiante|futuramente|(?:quando|qdo|se) (?:eu )?(?:precisar|quiser|decidir|tiver (?:a )?data)|eu (?:procuro|chamo|retorno|volto a (?:chamar|procurar|falar)|entro em contato)(?: (?:voces|vcs|vc|voce))?(?: depois| mais tarde| quando)?)\b`,
].join('|'));
/** Palavras que só EMBRULHAM a recusa na mesma oração ("pode me tirar da lista?", "venho requerer o descadastramento"). */
const EMBRULHO = /\b(?:tem como|teria como|pode|podem|poderia|poderiam|consegue|conseguem|da pra|daria pra|favor|gostaria de|gostaria que|quero|queria|solicito|peco|venho (?:requerer|solicitar|pedir)|preciso que)\b/g;
/** Rodada 34: palavras de uma pergunta retórica de irritação (sem assunto nem pedido). */
const RETORICA = /^(?:mais|uma|um|outra|outro|msg\w*|mensage\w*|zap|whats\w*|propaganda\w*|promoc\w*|spam|disparo\w*|de|novo|denovo|isso|essa|esse|ate|quando|hoje|toda|todo|hora|dia|santo|semana|vez|vezes|serio|hein|ne|q|que|coisa|chat\w*|insistent\w*|inconvenient\w*|absurdo|gente|vcs|voces|ces|me|pra|mim|aqui|ai|ja|nossa|pqp|af+e?s?|aff+|ah|oh|ow|oxe|vixe|mano|cara|kk+|rs+)$/;
const SOCIAL = /\b(?:(?:nao|n) (?:to|tou|estou|estamos|sou) (?:mais )?interessad\w*|sem interesse|ja fechei|fechei em outro|outro lugar|desisti|nao tenho (?:mais )?interesse|obrigad\w*|valeu|bom dia|boa tarde|boa noite|oi|ola|absurdo|chat[oa]s?|irritante|toda hora|todo dia|spam|que saco|vou pensar|nao vamos fazer|ja fez a festa|nao quero festa|af+e?s?|de novo(?: isso| essa| esse)?|outra vez|mais uma vez|que coisa|q coisa|mais uma (?:msg\w*|mensage\w*)|outra (?:msg\w*|mensage\w*)|serio mesmo|pqp|ai ai|serio|hein|insistent\w*|inconvenient\w*|chat\w* demais|demais|cansativ\w*)\b/;
// Rodada 33 (h33 aa20): "vcs são insistentes demais hein, sério? tira meu número daí" — irritação com "?" e o pedido
// inequívoco: bloqueio definitivo (com reclamação), não pausa. Pergunta de verdade junto ("sério? qual o endereço?")
// continua outro pedido (ACIONAVEL vem antes).
// Rodada 28 (h28 aa11): interjeição de irritação com "?" ("afff de novo isso??", "aff de novo?") é desabafo, não
// outra pergunta; pergunta real junto ("de novo? onde fica?") segue acionável (ACIONAVEL vem antes).
/** `mesmaOracao`: sobra da oração do próprio pedido de parar (sem as palavras que só embrulham a recusa). */
export function temOutroPedido(resto: string, mesmaOracao = false) {
  // Negação não é pedido: "não me manda mais nada" é a própria recusa.
  let r = limpo(resto).replace(/\b(?:nao|nem|nunca)\b(?:\s+(?:me|mais|quero|desejo|precisa|precisam|vou))*\s+\S+/g, ' ');
  if (mesmaOracao) r = r.replace(EMBRULHO, ' ');
  r = r.replace(/\b(?:por favor|porfavor|pfv|pf|ok|ta|mas|e|entao|ai|aí|na verdade|nao)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!r) return false;
  // Rodada 34 (h34 aa06): pergunta RETÓRICA de irritação ("mais uma msg???", "de novo isso?", "até quando?", "outra
  // mensagem hoje?") não é outro pedido: todas as palavras são de desabafo ou de mensagem (antes de ACIONAVEL, que lê o
  // "quando" de "até quando?" como pergunta).
  if (r.split(' ').every((p) => RETORICA.test(p))) return false;
  if (ACIONAVEL.test(r)) return true;
  if (SOCIAL.test(r)) return false;
  return !mesmaOracao && /\?/.test(resto) && r.split(' ').length >= 3;
}

/**
 * Rodada 32 (h32 aa69): "não precisa me mandar mais nada" dispensa o envio sem recusar o contato — nunca é bloqueio
 * definitivo; é pausa (AMBÍGUO: a equipe recebe em silêncio e nada automático sai depois). "Não precisa me mandar a
 * tabela de novo" (material) e "não precisa mandar mais nada sobre o bolo" (um assunto) não entram.
 */
const DISPENSA = /\b(?:nao|num) (?:precisa|precisam|carece)(?: mais)?(?: (?:me|nos))? (?:mandar|enviar|mandarem|enviarem)(?: mais)? (?:nada|nada mais|mais nada|coisa nenhuma|mensage\w*|msgs?)\b(?! (?:sobre|do|da|dos|das|de|desse|dessa|disso|deste|desta|a respeito|referente|com|no|na|nos|nas|pro|pra|para)\b)/;
/**
 * Pedido de parar na mensagem (regras, nível estrito): INEQUIVOCO bloqueia; AMBIGUO (com outro pedido, ou parar só a
 * forma) vai para a equipe em silêncio; null se não houver pedido.
 */
export function pedidoDeParar(texto: string): PedidoParar | null {
  const bruto = String(texto ?? '');
  const t = limpo(bruto);
  if (EXATO.test(semCortesia(t))) return { tipo: 'INEQUIVOCO', trecho: bruto.trim().slice(0, 120) };
  const oracoes = bruto.split(/(?<=[.!?;\n])|\bmas\b/i).map((o) => o.trim()).filter(Boolean);
  let trecho: string | null = null;
  const outras: string[] = [];
  const sobras: string[] = [];
  for (const o of oracoes) {
    const c = comVirgula(o);
    const achado = ESTRITO.map((re) => casa(c, re)).find(Boolean);
    if (achado) { trecho ??= o.slice(0, 120); sobras.push(c.replace(achado, ' ')); } else outras.push(o);
  }
  if (!trecho) return FORMA.test(t) || DISPENSA.test(t) ? { tipo: 'AMBIGUO', trecho: bruto.trim().slice(0, 120) } : null;
  return { tipo: temOutroPedido(outras.join(' ')) || temOutroPedido(sobras.join(' '), true) ? 'AMBIGUO' : 'INEQUIVOCO', trecho };
}
