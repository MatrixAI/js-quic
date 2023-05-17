#!/usr/bin/env node

const os = require('os');
const fs = require('fs');
const path = require('path');
const process = require('process');
const childProcess = require('child_process');
const packageJSON = require('../package.json');

const platform = os.platform();

/* eslint-disable no-console */
async function main(argv = process.argv) {
  argv = argv.slice(2);
  let arch;
  // This indicates whether the binary is optimised for production
  let production = false;
  const restArgs = [];
  while (argv.length > 0) {
    const option = argv.shift();
    let match;
    if ((match = option.match(/--arch(?:=(.+)|$)/))) {
      arch = match[1] ?? argv.shift();
    } else if ((match = option.match(/--production$/))) {
      production = true;
    } else {
      restArgs.push(option);
    }
  }
  if (arch == null) {
    arch = process.env.npm_config_arch ?? os.arch();
  }
  // Derive rustc targets from platform and arch
  let targetArch;
  switch (arch) {
    case 'x64':
      targetArch = 'x86_64';
      break;
    case 'ia32':
      targetArch = 'i686';
      break;
    case 'arm64':
      targetArch = 'aarch64';
      break;
    default:
      console.error('Unsupported architecture');
      process.exitCode = 1;
      return process.exitCode;
  }
  let targetVendor;
  let targetSystem;
  let targetABI;
  switch (platform) {
    case 'linux':
      targetVendor = 'unknown';
      targetSystem = 'linux';
      targetABI = 'gnu';
      break;
    case 'darwin':
      targetVendor = 'apple';
      targetSystem = 'darwin';
      break;
    case 'win32':
      targetVendor = 'pc';
      targetSystem = 'windows';
      targetABI = 'msvc';
      break;
    default:
      console.error('Unsupported platform');
      process.exitCode = 1;
      return process.exitCode;
  }
  const target = [targetArch, targetVendor, targetSystem, targetABI]
    .filter((s) => s != null)
    .join('-');
  const projectRoot = path.join(__dirname, '..');
  const prebuildPath = path.join(projectRoot, 'prebuild');
  await fs.promises.mkdir(prebuildPath, {
    recursive: true,
  });
  const cargoTOMLPath = path.join(projectRoot, 'Cargo.toml');
  const cargoTOML = await fs.promises.readFile(cargoTOMLPath, 'utf-8');
  const cargoTOMLVersion = cargoTOML.match(/version\s*=\s*"(.*)"/)?.[1];
  if (packageJSON.version !== cargoTOMLVersion) {
    console.error(
      'Make sure that Cargo.toml version matches the package.json version',
    );
    process.exitCode = 1;
    return process.exitCode;
  }
  await fs.promises.writeFile(cargoTOMLPath, cargoTOML, { encoding: 'utf-8' });
  const buildPath = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'prebuild-'),
  );
  const buildArgs = [
    'build',
    buildPath,
    `--target=${target}`,
    ...(production ? ['--release', '--strip'] : []),
  ];
  console.error('Running napi build:');
  console.error(['napi', ...buildArgs].join(' '));
  childProcess.execFileSync('napi', buildArgs, {
    stdio: ['inherit', 'inherit', 'inherit'],
    windowsHide: true,
    encoding: 'utf-8',
    shell: platform === 'win32' ? true : false,
  });
  // Rename to `name-platform-arch.node`
  const buildNames = await fs.promises.readdir(buildPath);
  const buildName = buildNames.find((filename) => /\.node$/.test(filename));
  const name = path.basename(buildName, '.node');
  await fs.promises.copyFile(
    path.join(buildPath, buildName),
    path.join(prebuildPath, `${name}-${platform}-${arch}.node`),
  );
  await fs.promises.rm(buildPath, {
    recursive: true,
  });
}
/* eslint-enable no-console */

void main();
