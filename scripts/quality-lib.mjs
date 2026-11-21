import ts from "typescript";

export const METRICS = ["duplication_pct", "dead_code", "comment_lines", "type_errors"];

export function countCommentLines(text, fileName = "file.ts") {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  let lines = 0;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind !== ts.SyntaxKind.SingleLineCommentTrivia && kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const body = scanner.getTokenText();
    if (/^(\/\/|\/\*)\s*shortcut:/.test(body)) continue;
    lines += body.split("\n").length;
  }
  return { file: fileName, lines };
}

export function deadCodeCount(knipReport) {
  let total = 0;
  for (const issue of knipReport.issues ?? []) {
    for (const [key, value] of Object.entries(issue)) {
      if (key === "file" || key === "unresolved") continue;
      if (Array.isArray(value)) total += value.length;
    }
  }
  return total;
}

export function typeErrorCount(tscOutput) {
  return tscOutput.split("\n").filter((line) => /error TS\d+/.test(line)).length;
}

export function compare(current, baseline, targets) {
  const rows = METRICS.map((m) => {
    const value = current[m];
    const base = baseline[m];
    const target = targets[m];
    const regressed = base !== undefined && value > base;
    const improved = base !== undefined && value < base;
    const meta = value <= target;
    return { metric: m, current: value, baseline: base, target, regressed, improved, meta };
  });
  return { rows, regressions: rows.filter((r) => r.regressed), improvements: rows.filter((r) => r.improved) };
}
