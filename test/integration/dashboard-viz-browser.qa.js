async (page) => {
  const base = "http://127.0.0.1:18766";
  const pages = [
    "sinter-viz-3d.html?viz=constellation",
    "sinter-viz-landscape.html",
  ];
  const failures = [];
  const rendered = [];
  const dependencyFailures = [];
  await page.addInitScript(() => {
    window.__vizDraws = 0;
    for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!type) continue;
      for (const key of ["drawArrays", "drawElements"]) {
        const original = type.prototype[key];
        type.prototype[key] = function (...args) {
          window.__vizDraws++;
          return original.apply(this, args);
        };
      }
    }
  });
  const onError = error => failures.push(error.message);
  page.on("response", response => {
    if (response.url().includes("/vendor/") && response.status() >= 400) dependencyFailures.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", onError);
  for (const path of pages) {
    const before = failures.length;
    await page.goto(`${base}/${path}`, { waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("canvas, svg"), null, { timeout: 15000 });
    await page.waitForFunction(() => window.__vizDraws > 0 ||
      document.querySelectorAll("svg path, svg circle, svg rect").length > 0);
    rendered.push({ path, ...(await page.evaluate(() => ({
      drawCalls: window.__vizDraws,
      svgShapes: document.querySelectorAll("svg path, svg circle, svg rect").length,
    }))) });
    if (failures.length !== before) throw new Error(`${path}: ${failures.slice(before).join("; ")}`);
  }
  if (dependencyFailures.length) throw new Error(`vendor dependency failures: ${dependencyFailures.join("; ")}`);
  await page.goto(`${base}/sinter-command-center.html`, { waitUntil: "load" });
  await page.locator('#archive-details > summary').click();
  for (const mode of ["constellation", "landscape"]) {
    await page.locator(`#btn-${mode}`).click();
    const expected = mode === "constellation" ? "sinter-viz-3d.html" :
      "sinter-viz-landscape.html";
    await page.waitForFunction((path) => document.querySelector("#hero-viz-frame")?.src.includes(path), expected);
    if (await page.locator("#hero-hud").isVisible()) throw new Error("field HUD overlaps embedded view");
    if (mode !== "constellation" && !(await page.locator("#hero-source").innerText()).includes("Sample data")) {
      throw new Error("embedded sample data is presented as live fleet telemetry");
    }
  }
  await page.locator("#btn-field").click();
  if (!(await page.locator("#hero-hud").isVisible())) throw new Error("live field HUD did not return");
  page.off("pageerror", onError);
  return { passed: true, pages: pages.length, navigationModes: 2, rendered };
}
