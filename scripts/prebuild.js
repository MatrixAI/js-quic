#!/usr/bin/env node

const os = require('os');
const fs = require('fs');
const path = require('path');
const process = require('process');
const childProcess = require('child_process');
const semver = require('semver');
const packageJSON = require('../package.json');

/**
 * Version of visual studio used for compilation on windows
 * This must correspond to the installed visual studio on the operating system
 */
const msvsVersion = semver.minVersion(packageJSON.engines.msvs).major;

/**
 * Target version corresponds to node headers and node.lib
 * This should be updated as the nixpkgs `pkgs.nodejs.version` is updated
 */
const nodeTarget = semver.minVersion(packageJSON.engines.node).version;

/**
 * There is no cross-compilation with node-gyp
 * So the target platform is always the host platform
 */
const platform = os.platform();

/* eslint-disable no-console */
async function main(argv = process.argv) {
  argv = argv.slice(2);
  let nodedir;
  let devdir;
  let arch;
  const restArgs = [];
  while (argv.length > 0) {
    const option = argv.shift();
    let match;
    if ((match = option.match(/--nodedir(?:=(.+)|$)/))) {
      nodedir = match[1] ?? argv.shift();
    } else if ((match = option.match(/--devdir(?:=(.+)|$)/))) {
      devdir = match[1] ?? argv.shift();
    } else if ((match = option.match(/--arch(?:=(.+)|$)/))) {
      arch = match[1] ?? argv.shift();
    } else {
      restArgs.push(option);
    }
  }

  if (nodedir == null) {
    nodedir = process.env.npm_config_nodedir;
  }

  if (devdir == null) {
    devdir = process.env.npm_config_devdir;
  }

  if (arch == null) {
    arch = process.env.npm_config_arch ?? os.arch();
  }

  // If `nodedir` is specified, this means the headers are already part of the node source code
  // When using `nix`, alwys specify the `nodedir` to avoid downloading from the internet in the middle of `nix-build`
  if (nodedir == null) {
    // If `devdir` is not specified, node-gyp will place headers into default cache
    // Linux: `$XDG_CACHE_HOME/node-gyp` or `$HOME/.cache/node-gyp`
    // Windows: `$env:LOCALAPPDATA/node-gyp` or `~/AppData/Local/node-gyp`
    // MacOS: `~/Library/Caches`
    const installArgs = [
      `install`,
      ...(devdir != null ? [`--devdir=${devdir}`] : []),
      `--target=${nodeTarget}`,
      '--ensure',
    ];
    console.error('Running node-gyp install:');
    console.error(['node-gyp', ...installArgs].join(' '));
    childProcess.execFileSync('node-gyp', installArgs, {
      stdio: ['inherit', 'inherit', 'inherit'],
      windowsHide: true,
      encoding: 'utf-8',
      shell: platform === 'win32' ? true : false,
    });
  } else {
    console.error('Skipping node-gyp install due to specified `nodedir`');
  }

  const configureArgs = [
    'configure',
    ...(nodedir != null
      ? [`--nodedir=${nodedir}`]
      : devdir != null
      ? [`--devdir=${devdir}`]
      : []),
    ...(platform === 'win32' ? [`--msvs_version=${msvsVersion}`] : []),
    `--target=${nodeTarget}`,
    '--verbose',
  ];
  console.error('Running node-gyp configure:');
  console.error(['node-gyp', ...configureArgs].join(' '));
  childProcess.execFileSync('node-gyp', configureArgs, {
    stdio: ['inherit', 'inherit', 'inherit'],
    windowsHide: true,
    encoding: 'utf-8',
    shell: platform === 'win32' ? true : false,
  });

  const buildArgs = [
    'build',
    ...(nodedir != null
      ? [`--nodedir=${nodedir}`]
      : devdir != null
      ? [`--devdir=${devdir}`]
      : []),
    ...(platform === 'win32' ? [`--msvs_version=${msvsVersion}`] : []),
    `--arch=${arch}`,
    `--target=${nodeTarget}`,
    `--jobs=max`,
    `--release`,
    '--verbose',
  ];
  console.error('Running node-gyp build:');
  console.error(['node-gyp', ...buildArgs].join(' '));
  childProcess.execFileSync('node-gyp', buildArgs, {
    stdio: ['inherit', 'inherit', 'inherit'],
    windowsHide: true,
    encoding: 'utf-8',
    shell: platform === 'win32' ? true : false,
  });

  const projectRoot = path.join(__dirname, '..');
  const buildsPath = path.join(projectRoot, 'build', 'Release');
  const prebuildsPath = path.join(projectRoot, 'prebuilds');

  const buildNames = await fs.promises.readdir(buildsPath);
  const buildName = buildNames.find((filename) => /\.node$/.test(filename));
  const buildPath = path.join(buildsPath, buildName);

  const prebuildTuple = `${platform}-${arch}`;
  // Tags are dot separated `<runtime>.<abi>.<othertag>`
  // <runtime>: node | electron | node-webkit
  // <abi>: napi | abi\d+
  // Other tags depends on node-gyp-build parser
  const prebuildTags = ['node', 'napi'].join('.');
  // The path must end with `.node`
  const prebuildPath =
    path.join(prebuildsPath, prebuildTuple, prebuildTags) + '.node';

  await fs.promises.mkdir(path.join(prebuildsPath, prebuildTuple), {
    recursive: true,
  });

  console.error(`Copying ${buildPath} to ${prebuildPath}`);
  await fs.promises.copyFile(buildPath, prebuildPath);
}
/* eslint-enable no-console */

void main();
