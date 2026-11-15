// Launches Electron with ELECTRON_RUN_AS_NODE removed. VS Code terminals set that
// variable, which would make Electron behave like plain Node and crash on startup.
const { spawn } = require("child_process");
const electron = require("electron"); // resolves to the electron.exe path
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = process.argv.length > 2 ? process.argv.slice(2) : ["."]; // e.g. scripts/screenshots.js
const child = spawn(electron, args, { stdio: "inherit", env, cwd: require("path").join(__dirname, "..") });
child.on("exit", (code) => process.exit(code ?? 0));
