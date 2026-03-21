#!/usr/bin/env node
/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Workspace-local storage: if .playwright/ marker exists in the project tree,
// default output and user-data dirs to workspace-local paths.
const _path = require('path');
const _fs = require('fs');
function _findWorkspaceDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (_fs.existsSync(_path.join(dir, '.playwright'))) return dir;
    const parent = _path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
const _wsDir = _findWorkspaceDir(process.cwd());
if (_wsDir) {
  if (!process.env.PLAYWRIGHT_MCP_OUTPUT_DIR)
    process.env.PLAYWRIGHT_MCP_OUTPUT_DIR = _path.join(_wsDir, '.playwright', 'mcp-output');
  if (!process.env.PLAYWRIGHT_MCP_USER_DATA_DIR)
    process.env.PLAYWRIGHT_MCP_USER_DATA_DIR = _path.join(_wsDir, '.playwright', 'mcp-profile');
}

const { program } = require('playwright-core/lib/utilsBundle');
const { decorateMCPCommand } = require('playwright-core/lib/tools/mcp/program');

if (process.argv.includes('install-browser')) {
  const argv = process.argv.map(arg => arg === 'install-browser' ? 'install' : arg);
  const { program: mainProgram } = require('playwright-core/lib/cli/program');
  mainProgram.parse(argv);
  return;
}

const packageJSON = require('./package.json');
const _cmdName = require('path').basename(process.argv[1] || 'playwright-mcp-multi-tab').replace(/\.(js|mjs|cjs)$/, '');
const p = program.version('Version ' + packageJSON.version).name(_cmdName);
decorateMCPCommand(p, packageJSON.version)

void program.parseAsync(process.argv);
