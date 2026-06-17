import { spawn } from "node:child_process";

const commands = [
  ["npm", ["run", "dev", "-w", "@misonos/bridge"]],
  ["npm", ["run", "dev", "-w", "@misonos/grateful-smapi"]],
  ["npm", ["run", "dev", "-w", "@misonos/phish-smapi"]],
  ["npm", ["run", "dev", "-w", "@misonos/ytmusic-smapi"]],
  ["npm", ["run", "dev", "-w", "@misonos/lma-smapi"]],
  ["npm", ["run", "dev", "-w", "@misonos/podcast-smapi"]],
  ["npm", ["run", "dev", "-w", "@misonos/tunein-smapi"]],
  ["npm", ["run", "dev", "-w", "@misonos/web"]]
];

const children = commands.map(([command, args]) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  child.on("exit", (code) => {
    if (code !== 0) {
      for (const other of children) {
        if (other !== child) other.kill("SIGTERM");
      }
      process.exit(code ?? 1);
    }
  });
  return child;
});

const shutdown = () => {
  for (const child of children) child.kill("SIGTERM");
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
