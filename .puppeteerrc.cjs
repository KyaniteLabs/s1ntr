// #1595: never download a browser during `npm install`. An interrupted earlier download
// leaves a half-filled cache folder that puppeteer refuses to repair, and npm then rolls
// back the whole install. S1NTR's browser preflight installs the browser on first use.
/** @type {import('puppeteer').Configuration} */
module.exports = {
  skipDownload: true,
};
