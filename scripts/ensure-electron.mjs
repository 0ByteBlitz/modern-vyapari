/**
 * Download the Electron binary once, before the test suite runs.
 *
 * Electron 43 has no postinstall: the binary is fetched lazily by the first
 * `require("electron")`. `node --test` runs test files in parallel processes,
 * and many of them import modules that import "electron" — so on a fresh
 * machine (every CI run) several processes start the same download and extract
 * into the same directory at once. One loses with "File exists (os error 17)"
 * and whichever test file it was running fails, at random. Requiring it here,
 * serially, means every test process finds the binary already in place.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
console.log(`Electron binary ready: ${electronPath}`);
