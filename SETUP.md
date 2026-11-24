# Setup da Pi Factory

Instalação só de escopo local. Nada vai para `~/.pi/agent`, para settings globais nem para `~/.pi/orchestrator` durante o setup.

## Pré-requisitos

| Requisito                                             | Perfil            | Como conferir                                     |
| ----------------------------------------------------- | ----------------- | ------------------------------------------------- |
| Node.js 22.18 ou mais                                 | minimal, complete | `node -v`                                         |
| git                                                   | minimal, complete | `git --version`                                   |
| Pi 1.5.2                                              | minimal, complete | `pi --version`                                    |
| Herdr 0.9.x (dentro de um pane)                       | minimal, complete | `herdr --version`                                 |
| treehouse                                             | minimal, complete | `treehouse --version`                             |
| gh autenticado na conta certa                         | complete          | `gh --version`, depois `gh auth login` se preciso |
| pi-subagents 0.88.0 (Oracle)                          | complete          | ver "Pacote pi-subagents" abaixo                  |
| skills `implement` e `tdd`, extensão `pr-review-hook` | complete          | fora do repo, em `~/.pi/agent`                    |

Perfil **minimal** executa tarefas `report` sem Oracle, sem skills Matt Pocock e sem reviewer. Perfil **complete** cobre `direct-pr` e `design`.

## Passos

```bash
git clone <repo> && cd pi-orchestrator
npm run bootstrap        # npm ci a partir do package-lock.json + core.hooksPath local
npm run doctor           # perfil minimal; use npm run doctor:complete para o perfil completo
npm test && npm run quality
```

Depois, dentro de um pane do Herdr: `bin/pi-factory` (ou `bin/pi-orch`).

## Pacote pi-subagents

O manifesto fixa `npm:pi-subagents@0.88.0`, com integridade `sha512-Hc7GT36…` (igual ao `package-lock.json` pessoal). A spec em `~/.pi/agent/settings.json` ainda pode estar sem versão. O doctor aponta isso, mas **não edita** settings: troque para `"npm:pi-subagents@0.88.0"` manualmente e reinicie o Pi.

## Skills Matt Pocock

Origem **não verificada** (sem repositório git nem licença conferidos). O repo não copia nem redistribui essas skills. Instale a partir de uma origem pinada e com licença verificada; até lá, o perfil complete fica incompleto.

## Doctor

`npm run doctor [--profile complete]` é somente leitura. Mostra cada requisito como:

- `[ready]`: atende ao perfil.
- `[missing]`: falta e bloqueia o perfil; traz a linha `corrija:`.
- `[optional]`: fora do perfil ou variável de ambiente ausente; não bloqueia.

Variáveis de ambiente aparecem só como `definida` ou `ausente`. O valor nunca é impresso. Sai com código 1 se houver `missing`.

## Bootstrap

`npm run bootstrap` é idempotente: rodar duas vezes não reinstala nem reescreve hooks. Ele só grava `node_modules/.pi-factory-lock.sha256` depois de um `npm ci` bem-sucedido, então uma instalação interrompida é refeita na próxima execução. Não faz commit, push, PR nem merge.

## Compatibilidade

- `bin/pi-factory` e `bin/pi-orch` não mudaram. `pi-orch` continua alias de `pi-factory`.
- `~/.pi/orchestrator` (estado) e `~/.pi/agent` (setup pessoal) não são lidos nem escritos pelo bootstrap.

## Rollback

- Remover dependências locais: apague `node_modules/`. Nada mais foi instalado.
- Desfazer o hook local: `git config --local --unset core.hooksPath`.
- Reverter a mudança no repo: `git revert -m 1 <merge-da-PR>` (ou reverter o commit, se a PR for squash). Nada fora do repo muda com este setup, então não há limpeza externa.

## WSL

Testado com WSL2 (kernel `microsoft-standard-WSL2`); o doctor identifica o ambiente como `Linux (WSL2)`. O Herdr precisa estar instalado no Linux/WSL para o launcher funcionar.
