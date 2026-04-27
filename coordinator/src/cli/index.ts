import { runWizard } from './wizard';
import { runDoctor } from './doctor';
import { runUpgrade } from './upgrade';
import { runTaskAdd } from './task';
import { runKgCommand } from './kg';
import { runInstancesCommand } from './instances';
import { runUninstall } from './uninstall';
import { runRemove } from './remove';
import { runDashboardDeploy } from './dashboard-deploy';
import { runWebhookDeploy } from './webhook-deploy';
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
      await runDoctor(args.slice(1));
      break;
    case 'instances':
      await runInstancesCommand(args.slice(1));
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
    case 'dashboard':
      await runDashboardCommand(args.slice(1));
      break;
    case 'webhook':
      await runWebhookCommand(args.slice(1));
      break;
    case 'remove':
      await runRemove(args.slice(1));
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

async function runDashboardCommand(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'deploy':
      await runDashboardDeploy(args.slice(1));
      break;
    default:
      console.error(`Unknown dashboard subcommand: ${sub || '(none)'}\n\nUsage:\n  flockbots dashboard deploy [-i <slug>]`);
      process.exit(1);
  }
}

async function runWebhookCommand(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'deploy':
      await runWebhookDeploy(args.slice(1));
      break;
    default:
      console.error(`Unknown webhook subcommand: ${sub || '(none)'}\n\nUsage:\n  flockbots webhook deploy [-i <slug>]`);
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
  init                        Run the interactive setup wizard (or
                              reconfigure individual sections on re-run)
  doctor [-i <slug>]          Check prerequisites + per-instance config
  instances                   List configured instances + pm2 status
  upgrade                     Pull latest, rebuild, restart via pm2
  task add "<description>"    Queue a task from the CLI
  kg build [--incremental]    Build the graphify knowledge graph
  dashboard deploy            Deploy the web dashboard to Vercel
  webhook deploy              Deploy the WhatsApp webhook-relay to Vercel
  remove                      Remove a single instance (pm2 + dir + Supabase)
  uninstall                   Remove FlockBots from this machine
  version                     Print the version
  help                        Show this message

Most per-instance commands accept -i <slug> when you have more than one
instance configured (task add, kg build, dashboard deploy, webhook deploy,
remove). With a single instance, the slug is auto-picked.

Run the coordinator with pm2 — the wizard prints the exact command
after init finishes.
`);
}

main().catch((err) => {
  console.error('Error:', err?.message || err);
  process.exit(1);
});
