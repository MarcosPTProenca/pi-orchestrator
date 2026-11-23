const IMPLEMENT_SKILL_COMMAND = "/skill:implement";

export function launchMessage(briefPath: string, forked: boolean, mode: string): string {
  const body = forked
    ? `Continue a tarefa do brief em ${briefPath}. Se o conteúdo dele já estiver nesta sessão, não o releia; caso contrário, leia-o com a ferramenta read. Ao terminar, chame orch_report.`
    : `Leia o brief em ${briefPath} com a ferramenta read e execute a tarefa que ele descreve. Ao terminar, chame orch_report.`;
  return mode === "direct-pr" ? `${IMPLEMENT_SKILL_COMMAND} ${body}` : body;
}
