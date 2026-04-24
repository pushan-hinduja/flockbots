import { runWizard } from './wizard';
import { runDoctor } from './doctor';
import { runUpgrade } from './upgrade';
import { runTaskAdd } from './task';
import { runKgCommand } from './kg';
import { runUninstall } from './uninstall';
import { getVersion } from './version';
import { TAGLINE, fg, COLORS, dim } from './brand';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      await runWizard();
      break;
    case 'doctor':
      await runDoctor();
      break;
    case 'upgrade':
      await runUpgrade();
      break;
    case 'task':
      await runTaskCommand(args.slice(1));
      break;
    case 'kg':
      await runKgCommand(args.slice(1));
      break;
    case 'uninstall':
      await runUninstall();
      break;
    case 'version':
    case '--version':
    case '-v':
      printVersion();
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exit(1);
  }
}

async function runTaskCommand(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'add':
      await runTaskAdd(args.slice(1));
      break;
    default:
      console.error(`Unknown task subcommand: ${sub || '(none)'}\n\nUsage:\n  flockbots task add "<description>"`);
      process.exit(1);
  }
}

function printVersion(): void {
  console.log(`flockbots ${getVersion()}`);
}

function printHelp(): void {
  const title = fg(COLORS.duck, 'flockbots');
  console.log(`${title} — ${dim(TAGLINE)}

Usage: flockbots <command>

Commands:
  init                        Run the interactive setup wizard
  doctor                      Check prerequisites + configuration
  upgrade                     Pull latest, rebuild, restart via pm2
  task add "<description>"    Queue a task from the CLI
  kg build [--incremental]    Build the graphify knowledge graph
  uninstall                   Remove FlockBots from this machine
  version                     Print the version
  help                        Show this message

Run the coordinator with pm2 — the wizard prints the exact command
after init finishes.
`);
}

main().catch((err) => {
  console.error('Error:', err?.message || err);
  process.exit(1);
});
