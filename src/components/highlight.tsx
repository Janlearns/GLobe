import type { ReactNode } from "react";

/** Tiny dependency-free syntax colouring for the code viewer. */

const KEYWORDS = new Set(
  (
    "abstract and as async await break case catch class const continue def default del do elif else enum export extends " +
    "false final finally fn for from func function go if impl import in interface is lambda let loop match mod module mut " +
    "new nil none not null or package pass private protected pub public raise return self static struct super switch this " +
    "throw throws trait true try type typeof use using var void while with yield True False None echo param foreach elseif " +
    "int float double char bool boolean string long short byte unsigned signed include define"
  ).split(" "),
);

const HASH_COMMENT = new Set(["py", "pyw", "sh", "bash", "ps1", "psm1", "rb", "r", "yaml", "yml", "toml", "ini", "conf", "cfg", "pl", "dockerfile", "makefile", "gitignore", "env"]);
const DASH_COMMENT = new Set(["sql", "lua", "hs"]);

function commentPattern(ext: string): string {
  if (HASH_COMMENT.has(ext)) return "#.*";
  if (DASH_COMMENT.has(ext)) return "--.*";
  if (ext === "bat" || ext === "cmd") return "(?:^\\s*(?:rem\\b|::)).*";
  if (ext === "html" || ext === "xml" || ext === "svg" || ext === "md") return "<!--.*?(?:-->|$)";
  return "\\/\\/.*|\\/\\*.*?(?:\\*\\/|$)";
}

/** Simple single-line tokenizer: comments, strings, numbers, keywords. */
export function makeTokenizer(ext: string): RegExp {
  return new RegExp(
    `(${commentPattern(ext)})|("(?:\\\\.|[^"\\\\])*"?|'(?:\\\\.|[^'\\\\])*'?|\`(?:\\\\.|[^\`\\\\])*\`?)|(\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b|\\b0x[0-9a-f]+\\b)|([A-Za-z_$][\\w$]*)`,
    "gi",
  );
}

export function highlight(line: string, re: RegExp, key: number): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const cls = m[1] ? "tk-com" : m[2] ? "tk-str" : m[3] ? "tk-num" : KEYWORDS.has(m[4]) ? "tk-kw" : null;
    out.push(cls ? (
      <span key={k++} className={cls}>
        {m[0]}
      </span>
    ) : (
      m[0]
    ));
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < line.length) out.push(line.slice(last));
  return <span key={key}>{out}{"\n"}</span>;
}
