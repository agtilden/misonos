import { spawn } from "node:child_process";

// Production-ish run: the backend services (bridge + SMAPI sources) plus the
// BUILT web app served by `vite preview`, so the real service worker is active
// and the PWA is installable. Run `npm start` (it builds the web first).
const commands = [
  ["npm", ["run", "dev", "-w", "@misonos/bridge"]],
  ["npm", ["run", "dev", "-w", "@misonos/grateful-smapi"]],
  ["npm", ["run", "dev", "-w", "@misonos/phish-smapi"]],
  ["npm", ["run", "dev", "-w", "@misonos/ytmusic-smapi"]],
  ["npm", ["run", "preview", "-w", "@misonos/web"]]
];

const children = commands.map(([command, args]) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  // Unlike dev.mjs, do NOT cascade-kill the others when one exits: a crashed
  // source (e.g. a missing Grateful Dead DB) shouldn't take down the bridge.
  child.on("exit", (code) => {
    console.error(`[start] "${args.join(" ")}" exited with code ${code ?? "null"}`);
  });
  return child;
});

const shutdown = () => {
  for (const child of children) child.kill("SIGTERM");
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
