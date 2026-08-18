#!/usr/bin/env node
'use strict';
// gamelib CLI — the engine with a human face. The GUI calls the same engine.

const engine = require('./engine');

function usage() {
  console.log(`gamelib — Steam-like game library + cloud saves over SSH

Usage: gamelib <command> [args]

  status                     list games, install state, save sync state
  publish <id> [dir] [-n name]   upload a game folder (current OS platform)
  install <id>               download the game to the configured install dir
  save-push <id>             upload local saves as a new cloud snapshot
  save-pull <id>             restore the latest cloud snapshot locally
  play <id>                  pull saves -> launch -> push saves on exit
  save-folder <id>           open the local save folder
  config-path                print the config file location
`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const cfg = engine.loadConfig();
  if (!cfg.server.host && cmd !== 'config-path') {
    throw new engine.GamelibError('no server configured — edit ' + engine.defaultConfigPath());
  }
  switch (cmd) {
    case 'status': {
      const s = await engine.status(cfg);
      console.log(`server: ${s.server.host}:${s.server.port} (password auth)  machine: ${s.machine}`);
      for (const g of s.games) {
        const inst = g.installed ? 'installed' : 'not installed';
        const saves = {
          none: 'no saves', localOnly: 'cloud: none, local only', synced: 'cloud: synced',
          localNewer: 'cloud: local is newer (push!)', serverNewer: 'cloud: server is newer (pull)',
        }[g.saveState] || g.saveState;
        console.log(`  ${g.name.padEnd(20)} ${inst.padEnd(14)} ${saves}${g.cloudTs ? `  @${g.cloudTs}` : ''}${g.error ? `  ERROR: ${g.error}` : ''}`);
      }
      break;
    }
    case 'publish': {
      const id = rest[0];
      const dir = rest[1];
      const nameIdx = rest.indexOf('-n');
      const name = nameIdx >= 0 ? rest[nameIdx + 1] : undefined;
      const osIdx = rest.indexOf('--os');
      const os = osIdx >= 0 ? rest[osIdx + 1] : undefined;
      console.log(`publishing '${id}' (${os || engine.osTag()}) from ${dir}…`);
      await engine.publishGame(cfg, id, dir, { name, os });
      console.log('done');
      break;
    }
    case 'install':
      console.log(`installing '${rest[0]}'…`);
      await engine.installGame(cfg, rest[0]);
      console.log('installed');
      break;
    case 'save-push': {
      const r = await engine.savePush(cfg, rest[0]);
      console.log(`pushed as ${r.snapshot}${r.pruned ? ` (pruned ${r.pruned})` : ''}`);
      break;
    }
    case 'save-pull': {
      const r = await engine.savePull(cfg, rest[0]);
      console.log(`restored ${r.snapshot} from ${r.from}`);
      break;
    }
    case 'play': {
      const r = await engine.play(cfg, rest[0], { onEvent: (e) => console.log(`  ${e.message}`) });
      if (r.pushed) console.log('session pushed:', r.pushed);
      break;
    }
    case 'save-folder':
      console.log(engine.openSaveFolder(cfg, rest[0]));
      break;
    case 'config-path':
    case 'config':
      console.log(engine.defaultConfigPath());
      break;
    default:
      usage();
      process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  });
}
