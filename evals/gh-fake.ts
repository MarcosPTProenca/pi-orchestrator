// keep: gh falso do eval de triagem; lê um tracker em memória, não publica nada, e o runner o grava em disco para o wrapper gh.
export const GH_FAKE_SOURCE = `const repo = "https://github.com/exemplo/herdr";
const issues = {
  224: { number: 224, title: "Visual do painel de tarefas", state: "OPEN",
    body: "Bloqueada por: nenhuma.\\nAjustar o painel de tarefas do Herdr conforme o layout aprovado." },
  225: { number: 225, title: "Visual do status por worker", state: "OPEN",
    body: "Bloqueada por: #224.\\nMostrar o status de cada worker no painel visual do Herdr." },
  226: { number: 226, title: "Visual do histórico de planos", state: "OPEN",
    body: "Bloqueada por: #225.\\nListar o histórico de planos no painel visual do Herdr." },
  229: { number: 229, title: "Gate de qualidade visual de UI (regressão de screenshots)", state: "OPEN",
    body: "Gate de CI que compara screenshots da interface. Não é apresentação do Herdr." },
};
const withUrl = (i) => ({ ...i, url: repo + "/issues/" + i.number });
const [a, b, c] = process.argv.slice(2);
if (a === "issue" && b === "list") {
  console.log(JSON.stringify(Object.values(issues).map(withUrl)));
} else if (a === "issue" && b === "view") {
  const i = issues[c];
  if (!i) {
    console.error("Could not resolve to an issue");
    process.exit(1);
  }
  console.log(JSON.stringify(withUrl(i)));
} else {
  console.error("comando não simulado: gh " + process.argv.slice(2).join(" "));
  process.exit(1);
}
`;
