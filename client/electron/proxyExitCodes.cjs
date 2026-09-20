// Exit code the proxy process uses to ask Electron main to quit the whole
// app after a normal, self-initiated shutdown (currently: the unattended
// run mode finishing on its own). Distinct from a normal clean exit (0),
// which keeps behaving exactly as it always has for every other caller
// (SIGINT/SIGTERM, a dev restart, ...). Shared between electron/main.cjs
// (CommonJS) and the TS/ESM proxy source, which imports this same file
// directly — see the sibling .d.ts for its type.
module.exports.PROXY_EXIT_QUIT_APP = 64;
