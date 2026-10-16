import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, delimiter } from "node:path";

const [mode, ...args] = process.argv.slice(2);
const cargoBin = join(homedir(), ".cargo", "bin");
const env = { ...process.env, PATH: `${cargoBin}${delimiter}${process.env.PATH ?? ""}` };
let command;
let commandArgs;
if (mode === "desktop") {
  command = process.execPath;
  commandArgs = [resolve("node_modules/@tauri-apps/cli/tauri.js"), ...args];
} else if (mode === "cargo") {
  command = join(cargoBin, process.platform === "win32" ? "cargo.exe" : "cargo");
  if (!existsSync(command)) command = "cargo";
  commandArgs = args;
} else {
  throw new Error(`Unknown runner: ${mode}`);
}
const child = spawn(command, commandArgs, { env, stdio: "inherit" });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
