#!/usr/bin/env node
// Its own file, not a link to cli.js: npm's Windows shims run a bin as
// `node <file>`, so the file name is how the launcher is told apart.
// See src/invocation.ts.
import '../cli.js';
