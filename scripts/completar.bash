# shellcheck shell=bash
# Autocomplete do comando dashboard no bash (F5, ADR 0029): comandos, opções de cada comando e
# os valores de --importar-v1, --chave-ssh e --modo. Arquivo estático: chamar a CLI custaria
# dezenas de ms a cada Tab. test/unit/autocomplete.test.js confere as listas contra o código.

# Comandos, sem os apelidos (help, -h, versão). As opções internas --pos-atualizacao e --registro ficam de fora.
_DASHBOARD_COMANDOS='instalar abrir iniciar parar status diagnosticar reconfigurar atualizar desinstalar versao ajuda'

# Opções de um comando. Só instalar e reconfigurar têm o modo sem perguntas.
_dashboard_opcoes() {
  case "$1" in
    instalar | reconfigurar)
      echo '--ajuda --chave-ssh --disco --editar-profile --forcar --identidade --importar-v1
        --ja-preparado --memoria --modo --pastas --porta --pre --rede --sem-assinatura
        --sem-atalho --sem-inicio-automatico --sem-interface --sem-link --sem-origem
        --senha-stdin --servicos --servidor --smart --temperatura --terminal --usuario'
      ;;
    atualizar) echo '--pre' ;;
    desinstalar) echo '--apagar-historico --chave-ssh --limpar-servidor --senha-stdin --sim --usuario' ;;
  esac
}

# Apelidos Host do ~/.ssh/config, lidos sem rodar ssh. O Include fica de fora. Só nomes simples
# passam: o Tab cola o nome na linha de comando, e um "$(...)" no arquivo rodaria no Enter.
_dashboard_apelidos() {
  local nome
  local -a campos
  [ -r "$HOME/.ssh/config" ] || return 0
  while IFS=$' \t=' read -r -a campos || [ "${#campos[@]}" -gt 0 ]; do
    # Nome entre aspas pode ter espaço, e o espaço dividiria o apelido: a linha fica de fora.
    [ "${campos[0],,}" = host ] && [[ ${campos[*]} != *\"* ]] || continue
    for nome in "${campos[@]:1}"; do
      case "$nome" in
        '#'*) break ;;
        -* | *[!A-Za-z0-9_.-]*) ;;
        *) printf '%s\n' "$nome" ;;
      esac
    done
  done <"$HOME/.ssh/config"
}

_dashboard() {
  local cur=${COMP_WORDS[COMP_CWORD]} nome
  COMPREPLY=()
  if [ "$COMP_CWORD" -eq 1 ]; then
    mapfile -t COMPREPLY < <(compgen -W "$_DASHBOARD_COMANDOS" -- "$cur")
    return 0
  fi
  case "${COMP_WORDS[COMP_CWORD - 1]}" in
    --importar-v1)
      # Fora do Tab de verdade (nos testes), o compopt falha; o erro não importa.
      compopt -o filenames 2>/dev/null
      mapfile -t COMPREPLY < <(compgen -d -- "$cur")
      ;;
    --chave-ssh)
      # Sem compgen -W: ele expandiria o que está no arquivo.
      while IFS= read -r nome; do
        [[ $nome == "$cur"* ]] && COMPREPLY+=("$nome")
      done < <(_dashboard_apelidos)
      ;;
    --modo) mapfile -t COMPREPLY < <(compgen -W 'manual' -- "$cur") ;;
    # Valor livre: nenhuma sugestão, para o Tab não colar uma opção no lugar dele.
    --disco | --identidade | --memoria | --pastas | --porta | --rede | --servicos | --servidor | --smart | --temperatura | --usuario) ;;
    *) mapfile -t COMPREPLY < <(compgen -W "$(_dashboard_opcoes "${COMP_WORDS[1]}")" -- "$cur") ;;
  esac
  return 0
}

complete -F _dashboard dashboard ./dashboard
