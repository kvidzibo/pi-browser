#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBrowserService } from './service.ts';

// stdout belongs exclusively to MCP. Never log browser details or cookie data.
const service = createBrowserService();
let stopping;
function stop() {
  stopping ??= service.close().catch(() => {
    process.stderr.write('Browser service cleanup failed\n');
    process.exitCode = 1;
  }).finally(() => { process.stdin.pause(); });
  return stopping;
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.stdin.once('end', stop);
process.once('uncaughtException', () => { process.stderr.write('Browser service failed\n'); process.exitCode = 1; void stop(); });
process.once('unhandledRejection', () => { process.stderr.write('Browser service failed\n'); process.exitCode = 1; void stop(); });
try { await service.connect(new StdioServerTransport()); }
catch { process.stderr.write('Browser service startup failed\n'); process.exitCode = 1; await stop(); }
