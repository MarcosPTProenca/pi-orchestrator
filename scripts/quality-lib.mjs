import ts from "typescript";

export const METRICS = ["duplication_pct", "dead_code", "comment_lines", "type_errors"];

function commentRanges(text, fileName = "file.ts") {
  const kind = fileName.endsWith(".mjs") || fileName.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found = new Map();
  const scanTrivia = (from, to) => {
    if (to <= from) return;
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text.slice(from, to));
    for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
      if (k !== ts.SyntaxKind.SingleLineCommentTrivia && k !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
      const pos = from + scanner.getTokenPos();
      found.set(pos, { pos, end: from + scanner.getTextPos() });
    }
  };
  const walk = (node) => {
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      scanTrivia(node.pos, node.getStart(sf));
      return;
    }
    kids.forEach(walk);
  };
  walk(sf);
  return [...found.values()]
    .map((r) => ({ pos: r.pos, end: r.end, text: text.slice(r.pos, r.end) }))
    .filter((c) => !/^(\/\/|\/\*)\s*shortcut:/.test(c.text));
}

export function countCommentLines(text, fileName = "file.ts") {
  const lines = commentRanges(text, fileName).reduce((sum, c) => sum + c.text.split("\n").length, 0);
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
