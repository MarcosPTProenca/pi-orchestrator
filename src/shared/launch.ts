const IMPLEMENT_SKILL_COMMAND = "/skill:implement";

// keep: relançamento por fork passa revised=true; o aviso de retomada só existe no brief novo, não na sessão copiada.
export function launchMessage(briefPath: string, forked: boolean, mode: string, revised = false): string {
  const body = forked
    ? revised
      ? `Continue a tarefa. Leia o brief em ${briefPath} com a ferramenta read: ele foi revisado nesta retomada e o aviso no fim não está nesta sessão. Ao terminar, chame orch_report.`
      : `Continue a tarefa do brief em ${briefPath}. Se o conteúdo dele já estiver nesta sessão, não o releia; caso contrário, leia-o com a ferramenta read. Ao terminar, chame orch_report.`
    : `Leia o brief em ${briefPath} com a ferramenta read e execute a tarefa que ele descreve. Ao terminar, chame orch_report.`;
  return mode === "direct-pr" ? `${IMPLEMENT_SKILL_COMMAND} ${body}` : body;
}
