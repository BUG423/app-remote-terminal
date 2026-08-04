'use strict';

const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { Unicode11Addon } = require('@xterm/addon-unicode11');
const { createTerminalStateImplementation } = require('../lib/terminal-state-core');

module.exports = createTerminalStateImplementation({ Terminal, SerializeAddon, Unicode11Addon });
