/**
 * Code viewer and terminal actions shared by the details panel. Both need a
 * Security setting (off by default); asking here turns it on in place, after
 * a clear explanation, instead of sending the user to another panel.
 */
import { api, errorMessage } from "../api";
import { useStore } from "../state/store";
import type { Entry, SecuritySettings, TerminalShell } from "../types";

async function enable(key: "allowReadContents" | "allowTerminal", title: string, body: string, confirmLabel: string): Promise<boolean> {
  const st = useStore.getState();
  if (!st.settings) return false;
  if (st.settings[key]) return true;
  const ok = await st.ask({ title, body, confirmLabel, danger: key === "allowTerminal" });
  if (!ok) return false;
  try {
    const settings = await api.setSettings({ ...st.settings, [key]: true } as SecuritySettings);
    useStore.setState({ settings });
    return true;
  } catch (e) {
    st.notify("error", errorMessage(e));
    return false;
  }
}

export async function openCodeView(e: Entry) {
  const ok = await enable(
    "allowReadContents",
    "Allow reading file contents?",
    "The code viewer shows the text of files you open in it. Only the file you pick is read, only when you open it, and nothing " +
      "is changed, run, saved or sent anywhere.\n\nYou can turn this off again in Security settings.",
    "Allow and open",
  );
  if (ok) useStore.setState({ codeView: e });
}

const SHELL_NAME: Record<TerminalShell, string> = { powershell: "PowerShell", cmd: "Command Prompt" };

/** Opens the docked terminal in `dir` (a confirmation every time a new session starts). */
export async function openTerminal(dir: Entry, shell: TerminalShell, prefill?: string) {
  const st = useStore.getState();
  const cur = st.terminal;
  if (cur && cur.dir.id === dir.id && cur.shell === shell) {
    if (prefill) useStore.setState({ terminal: { ...cur, prefill: { text: prefill, n: (cur.prefill?.n ?? 0) + 1 } } });
    return;
  }
  const enabled = await enable(
    "allowTerminal",
    "Allow the terminal?",
    "Lets you open PowerShell or Command Prompt inside a folder you indexed and type commands, for example to run your code.\n\n" +
      "Commands run with your normal rights (never as administrator), exactly as if you typed them in Windows Terminal, and " +
      "are recorded in launch-log.tsv. Only run commands you understand.\n\nYou can turn this off again in Security settings.",
    "Allow terminal",
  );
  if (!enabled) return;
  const ok = await st.ask({
    title: `Open ${SHELL_NAME[shell]} here?`,
    body: `A ${SHELL_NAME[shell]} session will start in:\n\n${dir.path}\n\nNothing runs until you type a command and press Enter.`,
    confirmLabel: "Open terminal",
  });
  if (!ok) return;
  useStore.setState({
    terminal: { dir, shell, run: (cur?.run ?? 0) + 1, prefill: prefill ? { text: prefill, n: 1 } : null },
  });
}

export async function openExternalTerminal(dir: Entry, shell: TerminalShell) {
  try {
    await api.openExternalTerminal(dir.id, shell, true);
  } catch (e) {
    useStore.getState().notify("error", errorMessage(e));
  }
}

/** PowerShell command that runs a file from its own folder, or null if we do not know how. */
export function runCommandFor(e: Entry): string | null {
  const f = `".\\${e.name}"`;
  const by: Record<string, string> = {
    py: `python ${f}`,
    pyw: `python ${f}`,
    js: `node ${f}`,
    mjs: `node ${f}`,
    cjs: `node ${f}`,
    ts: `npx tsx ${f}`,
    ps1: `& ${f}`,
    bat: `& ${f}`,
    cmd: `& ${f}`,
    exe: `& ${f}`,
    jar: `java -jar ${f}`,
    java: `java ${f}`,
    go: `go run ${f}`,
    rb: `ruby ${f}`,
    php: `php ${f}`,
    lua: `lua ${f}`,
    r: `Rscript ${f}`,
    sh: `bash ${f}`,
    dart: `dart run ${f}`,
    // Opens the notebook in Jupyter (needs Jupyter installed).
    ipynb: `jupyter notebook ${f}`,
  };
  return e.kind === "file" ? (by[e.ext.toLowerCase()] ?? null) : null;
}
