import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export async function waitForEnter(message, { interactive = true } = {}) {
  if (!interactive) {
    return;
  }

  const rl = readline.createInterface({ input, output });
  try {
    await rl.question(`${message}\n按 Enter 继续，或按 Ctrl+C 停止。\n`);
  } finally {
    rl.close();
  }
}
