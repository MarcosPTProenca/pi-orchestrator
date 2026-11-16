# pi-orchestrator

Orquestração mínima de sessões Pi independentes pelo Herdr (MVP). Um orquestrador
conversacional delega tarefas a workers Pi em panes do Herdr, acompanha sem usar LLM
e avisa só quando há decisão, bloqueio ou conclusão.

Não altera `~/.pi/agent`. A extensão é carregada só pelo launcher `bin/pi-orch`.

## Requisitos

- Herdr 0.9.x com a CLI `herdr` no `PATH`.
- Pi (`pi`) instalado; testado com 1.5.2.
- Node.js 22 e npm (para os testes).

## Instalar

```bash
cd ~/github/pi-orchestrator
npm install        # só devDependencies: tsx, typescript, @types/node, todas com versão fixa
npm test           # testes com Herdr simulado (sem efeitos reais)
node_modules/.bin/tsc -p tsconfig.json   # checagem de tipos
```

## Iniciar

Dentro de um pane do Herdr:

```bash
~/github/pi-orchestrator/bin/pi-orch
```

O launcher recusa rodar fora do Herdr (`HERDR_ENV=1` e `HERDR_PANE_ID` obrigatórios).

## Tools do orquestrador

| Tool | Função | Usa LLM? |
|---|---|---|
| `orch_delegate(project_path, role, brief, timeout_minutes?)` | Cria (ou reutiliza) o workspace do projeto, abre uma tab para a tarefa e inicia um worker Pi com o brief. | Não |
| `orch_status()` | Lista tarefas e estados do estado local. | Não |
| `orch_inbox()` | Decisões abertas (`blocked`) e conclusões ou falhas ainda não avisadas. | Não |
| `orch_answer(task_id, answer)` | Envia a resposta ao worker bloqueado, que continua. | Só o worker |
| `orch_cancel(task_id)` | Fecha a tab da tarefa, se ela ainda for do orquestrador. | Não |

O worker recebe a tool `orch_report(status, result, question?, artifacts?)`. Ele a chama
uma vez no fim, com `done`, `failed` ou `blocked`.

## Como funciona

- **Layout:** um workspace Herdr por projeto (rótulo = nome do diretório). Cada tarefa
  é uma tab nesse workspace. A tab criada junto com o workspace fica como âncora, para o
  agrupamento não sumir.
- **Acompanhamento:** `herdr agent wait` em blocos, sem LLM. Antes de aceitar `idle`,
  espera `working` por até 20 s, para não ler o estado anterior ao início.
- **Conclusão:** `done` fecha a tab do worker. O relatório `report.json` e a sessão Pi
  continuam em disco.
- **Bloqueio:** `blocked` aparece no inbox e fica até você responder.
- **Dono:** o orquestrador só fecha panes cujo `pane_id` e `terminal_id` batem com o
  registro. Se não baterem, não fecha nada.
- **Reinício:** `reconcile` confere as tarefas ativas com o Herdr e os relatórios em disco.

## Estado e arquivos

- Estado: `~/.pi/orchestrator/state.json` (troque com `PI_ORCH_STATE_DIR`).
- Tarefas: `~/.pi/orchestrator/tasks/<task_id>/` com `brief.md` e `report.json`.
- Limite de tarefas ativas: `PI_ORCH_MAX_ACTIVE` (padrão 1).

## Smoke test real

Cria workspace, tabs e workers Pi reais em um projeto descartável, com estado isolado.
Cobre conclusão, bloqueio com resposta e cancelamento. Consome tokens do modelo do worker.

```bash
node --import tsx scripts/smoke-herdr.ts
```

## Remover

Apague o diretório do repositório e `~/.pi/orchestrator/`. Nada foi instalado em
`~/.pi/agent`. Para fechar workspaces criados, use `herdr workspace close <id>`.

## Fora do escopo do MVP

Software Factory, DAG de desenvolvimento, worktrees (fica com o treehouse), agendamento,
dashboard, memória própria, múltiplos orquestradores e notificações externas.
