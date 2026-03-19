import { spawn } from "node:child_process";

function runShell(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export default async function exec(input = {}) {
  const workspace = new URL(".", import.meta.url).pathname.replace(/^\//, "");
  let command = "";

  if (typeof input === "string") {
    command = input;
  } else if (input && typeof input === "object") {
    command =
      input.command ||
      input.cmd ||
      input.shell ||
      input.script ||
      input.task ||
      input.text ||
      "";
    if (Array.isArray(input.args) && input.args.length > 0) {
      command = [command, ...input.args].filter(Boolean).join(" ");
    }
  }

  if (!command) {
    return { ok: true, cwd: workspace, stdout: "", stderr: "", code: 0 };
  }

  const result = await runShell(command, workspace);
  return {
    ok: result.code === 0,
    cwd: workspace,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export { exec };
