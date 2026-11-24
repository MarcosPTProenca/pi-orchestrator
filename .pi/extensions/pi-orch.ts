// Auto-discovered mirror of src/orchestrator/extension.ts (ver #101/wsl-restart).
//
// bin/pi-orch carrega a extensão via `pi -e src/index.ts`. Depois de um restart do
// Herdr (ex.: wsl --shutdown), o Herdr reconstrói o pane com o comando nativo de
// resume do Pi (`pi --session <path>`), sem a flag -e: a sessão volta como Pi comum,
// sem nenhuma tool orch_* e sem o papel de orquestrador. Herdr não expõe hoje um jeito
// de uma extensão -e reportar seu próprio resume_argv num pane já detido pela
// integração oficial herdr:pi (resume_not_accepted); ver discussão na issue do projeto.
//
// Este arquivo é o mesmo módulo em local auto-discovered (.pi/extensions/, carregado
// sempre que a sessão abre com cwd dentro deste repo, sem precisar de -e nem de
// /reload manual). A extensão já decide por conta própria se assume o papel: ela lê
// ctx.cwd no session_start e só se torna dona do escopo se nenhuma outra sessão viva
// já é dona (acquireOwnership em src/shared/lock.ts); do contrário fica em modo
// somente leitura. Nenhuma lógica nova aqui.
export { default } from "../../src/orchestrator/extension.ts";
