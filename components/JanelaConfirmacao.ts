/** Janela modal da aplicação. showModal torna o restante da página inerte. */
type Pedido = { titulo: string; mensagem: string; valorInicial?: string; executar?: () => Promise<unknown>; gatilho?: HTMLElement | null };
let aberta = false;

function abrir({ titulo, mensagem, valorInicial, executar, gatilho }: Pedido): Promise<string | null> {
  if (aberta) return Promise.resolve(null);
  const origem = gatilho ?? document.activeElement;
  const endereco = location.href;
  const janela = document.createElement('dialog');
  janela.className = 'janela-confirmacao';
  janela.setAttribute('role', 'dialog');
  janela.setAttribute('aria-modal', 'true');
  janela.setAttribute('aria-labelledby', 'janela-confirmacao-titulo');
  janela.setAttribute('aria-describedby', 'janela-confirmacao-resumo');
  const cabecalho = document.createElement('h2');
  cabecalho.id = 'janela-confirmacao-titulo';
  cabecalho.textContent = titulo;
  const resumo = document.createElement('p');
  resumo.id = 'janela-confirmacao-resumo';
  resumo.textContent = mensagem;
  janela.append(cabecalho, resumo);
  const campo = document.createElement('textarea');
  if (valorInicial !== undefined) {
    campo.setAttribute('aria-labelledby', resumo.id);
    campo.value = valorInicial;
    janela.append(campo);
  }
  const acoes = document.createElement('div');
  const voltar = document.createElement('button');
  voltar.type = 'button';
  voltar.textContent = 'Voltar';
  voltar.autofocus = true;
  const principal = document.createElement('button');
  principal.type = 'button';
  principal.textContent = titulo;
  acoes.append(voltar, principal);
  janela.append(acoes);
  document.body.append(janela);
  janela.showModal();
  voltar.focus();
  aberta = true;
  return new Promise((resolve, reject) => {
    let executando = false;
    function concluir(valor: string | null) {
      if (!janela.open) return;
      principal.disabled = true;
      janela.close();
      janela.remove();
      aberta = false;
      window.removeEventListener('popstate', cancelar);
      window.removeEventListener('hashchange', cancelar);
      window.removeEventListener('pagehide', cancelar);
      if (origem instanceof HTMLElement && origem.isConnected) origem.focus();
      resolve(valor);
    }
    function cancelar() { if (!executando) concluir(null); }
    window.addEventListener('popstate', cancelar);
    window.addEventListener('hashchange', cancelar);
    window.addEventListener('pagehide', cancelar);
    voltar.onclick = cancelar;
    principal.onclick = async () => {
      if (executando || !janela.open) return;
      if (endereco !== location.href || !origem?.isConnected) return cancelar();
      if (executar) {
        executando = true;
        principal.disabled = voltar.disabled = true;
        janela.setAttribute('aria-busy', 'true');
        principal.textContent = 'Aguarde…';
        janela.tabIndex = -1;
        janela.focus();
        try { await executar(); }
        catch (erro) { reject(erro); }
      }
      concluir(campo.value);
    };
    janela.oncancel = event => { event.preventDefault(); cancelar(); };
    janela.onkeydown = event => {
      if (event.key !== 'Tab') return;
      if (executando) { event.preventDefault(); return; }
      const primeiro = valorInicial === undefined ? voltar : campo;
      if (event.shiftKey && document.activeElement === primeiro) {
        event.preventDefault();
        principal.focus();
      } else if (!event.shiftKey && document.activeElement === principal) {
        event.preventDefault();
        primeiro.focus();
      }
    };
  });
}

export const dialogo = {
  async confirmar(titulo: string, mensagem: string, executar?: () => Promise<unknown>, gatilho?: HTMLElement | null) {
    return (await abrir({ titulo, mensagem, executar, gatilho })) !== null;
  },
  perguntar(titulo: string, mensagem: string, valorInicial = '', gatilho?: HTMLElement | null) {
    return abrir({ titulo, mensagem, valorInicial, gatilho });
  },
  avisar(mensagem: string, gatilho?: HTMLElement | null) {
    return abrir({ titulo: 'Entendi', mensagem, gatilho });
  },
};
