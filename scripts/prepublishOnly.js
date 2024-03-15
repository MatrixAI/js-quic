#!/usr/bin/env node

/**
 * This runs before `npm publish` command.
 * This will take the native objects in `prebuild/`
 * and create native packages under `prepublishOnly/`.
 *
 * For example:
 *
 * /prepublishOnly
 *   /@org
 *     /name-linux-x64
 *       /package.json
 *       /node.napi.node
 *       /README.md
 */

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
  let tag;
  let dryRun = false;
  const restArgs = [];
  while (argv.length > 0) {
    const option = argv.shift();
    let match;
    if ((match = option.match(/--tag(?:=(.+)|$)/))) {
      tag = match[1] ?? argv.shift();
    } else if ((match = option.match(/--dry-run$/))) {
      dryRun = true;
    } else {
      restArgs.push(option);
    }
  }
  if (tag == null) {
    tag = process.env.npm_config_tag;
  }
  const projectRoot = path.join(__dirname, '..');
  const prebuildPath = path.join(projectRoot, 'prebuild');
  const prepublishOnlyPath = path.join(projectRoot, 'prepublishOnly');
  const buildNames = (await fs.promises.readdir(prebuildPath)).filter(
    (filename) => /^(?:[^-]+)-(?:[^-]+)-(?:[^-]+)$/.test(filename),
  );
  if (buildNames.length < 1) {
    console.error(
      'You must prebuild at least 1 native object with the filename of `name-platform-arch` before prepublish',
    );
    process.exitCode = 1;
    return process.exitCode;
  }
  // Extract out the org name, this may be undefined
  const orgName = packageJSON.name.match(/^@[^/]+/)?.[0];
  for (const buildName of buildNames) {
    // This is `name-platform-arch`
    const name = path.basename(buildName, '.node');
    // This is `@org/name-platform-arch`, uses `posix` to force usage of `/`
    let packageName = path.posix.join(orgName ?? '', name);
    // Check and rename any universal packages as universal
    if (packageName.includes('+')) {
      const packageNameSplit = packageName.split('-');
      packageNameSplit[2] = 'universal';
      packageName = packageNameSplit.join('-');
    }
    const constraints = name.match(
      /^(?:[^-]+)-(?<platform>[^-]+)-(?<arch>[^-]+)$/,
    );
    // This will be `prebuild/name-platform-arch.node`
    const buildPath = path.join(prebuildPath, buildName);
    // This will be `prepublishOnly/@org/name-platform-arch`
    const packagePath = path.join(prepublishOnlyPath, packageName);
    console.error('Packaging:', packagePath);
    try {
      await fs.promises.rm(packagePath, {
        recursive: true,
      });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await fs.promises.mkdir(packagePath, { recursive: true });
    const nativePackageJSON = {
      name: packageName,
      version: packageJSON.version,
      homepage: packageJSON.homepage,
      author: packageJSON.author,
      contributors: packageJSON.contributors,
      description: packageJSON.description,
      keywords: packageJSON.keywords,
      license: packageJSON.license,
      repository: packageJSON.repository,
      main: 'node.napi.node',
      os: [constraints.groups.platform],
      cpu: [...constraints.groups.arch.split('+')],
    };
    const packageJSONPath = path.join(packagePath, 'package.json');
    console.error(`Writing ${packageJSONPath}`);
    const packageJSONString = JSON.stringify(nativePackageJSON, null, 2);
    console.error(packageJSONString);
    await fs.promises.writeFile(packageJSONPath, packageJSONString, {
      encoding: 'utf-8',
    });
    const packageReadmePath = path.join(packagePath, 'README.md');
    console.error(`Writing ${packageReadmePath}`);
    const packageReadme = `# ${packageName}\n`;
    console.error(packageReadme);
    await fs.promises.writeFile(packageReadmePath, packageReadme, {
      encoding: 'utf-8',
    });
    const packageBuildPath = path.join(packagePath, 'node.napi.node');
    console.error(`Copying ${buildPath} to ${packageBuildPath}`);
    await fs.promises.copyFile(buildPath, packageBuildPath);
    const publishArgs = [
      'publish',
      packagePath,
      ...(tag != null ? [`--tag=${tag}`] : []),
      '--access=public',
      ...(dryRun ? ['--dry-run'] : []),
    ];
    console.error('Running npm publish:');
    console.error(['npm', ...publishArgs].join(' '));
    childProcess.execFileSync('npm', publishArgs, {
      stdio: ['inherit', 'inherit', 'inherit'],
      windowsHide: true,
      encoding: 'utf-8',
      shell: platform === 'win32' ? true : false,
    });
  }
}
/* eslint-enable no-console */

void main();
