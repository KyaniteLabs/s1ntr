async (page) => {
  const base = "http://127.0.0.1:18766/sinter-command-center.html";
  const results = [];
  let errors = [];
  const onError = error => errors.push(error.message);
  page.on("pageerror", onError);
  await page.addInitScript(() => {
    window.__qaInjected = 0;
    window.__qaDraws = 0;
    for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!type) continue;
      for (const key of ["drawArrays", "drawElements"]) {
        const original = type.prototype[key];
        type.prototype[key] = function (...args) {
          if (this.canvas?.closest?.("#sec-field")) window.__qaDraws++;
          return original.apply(this, args);
        };
      }
    }
  });
  const chip = name => page.locator('header [title="' + name + '"]');
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const ready = async () => {
    await page.goto(base);
    await page.waitForFunction(() => {
      const a = document.querySelector('header [title="artifacts"]');
      const s = document.querySelector('header [title="scorecards"]');
      return typeof renderCount!=='undefined' && renderCount>0 && a && s && !a.classList.contains("wait") && !s.classList.contains("wait")
        && !a.textContent.includes("loading") && !s.textContent.includes("loading");
    }, null, { timeout: 20000 });
    await page.locator('header details > summary').click();
    await page.locator('#archive-details > summary').click();
  };
  const metadataIds = url => decodeURIComponent((url.split("?ids=")[1] || "").split("&")[0]).split(",").filter(Boolean);
  const installMetadataDefaults = async () => {
    await page.route("**/api/artifact-availability*", async route => {
      const ids = metadataIds(route.request().url());
      await route.fulfill({json:{availability:Object.fromEntries(ids.map(id => [id, true]))}});
    });
    await page.route("**/api/history*", route => route.fulfill({json:{artifacts:[],scorecards:[],sources:{}}}));
    await page.route("**/api/ghosts*", route => route.fulfill({json:{available:true,entries:[]}}));
  };
  const scenario = async (name, configure, verify, wait = ready) => {
    errors = [];
    await page.unrouteAll({ behavior: "wait" });
    try {
      await installMetadataDefaults();
      if (configure) await configure();
      await wait();
      await verify();
      require(errors.length === 0, "page errors: " + errors.join("; "));
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: error.message, pageErrors: errors });
    }
  };
  await scenario('overview leads with artwork and keeps the raw archive collapsed', null, async () => {
    require(!await page.locator('#archive-details').evaluate(d=>d.open), 'raw archive opened by default');
    await page.locator('#overview-preview iframe').waitFor();
    const fitted=await page.locator('#overview-preview').evaluate(box=>{
      const a=box.getBoundingClientRect(),b=box.querySelector('iframe').getBoundingClientRect();
      return b.left>=a.left&&b.right<=a.right+1&&b.top>=a.top&&b.bottom<=a.bottom+1&&Math.abs(b.width/b.height-1280/720)<.01;
    });
    require(fitted,'featured artwork viewport was cropped or distorted');
    require((await page.locator('#overview-catalog').textContent()).includes('catalog entries'), 'catalog summary missing');
  }, async () => {
    await page.goto(base);
    await page.waitForFunction(()=>document.querySelector('#overview-preview iframe'));
  });
  await scenario('operator-held worker is not presented as merely stale', async () => {
    await page.route('**/fleet/fleet.json*', async route => {
      const response=await route.fetch(), fleet=await response.json();
      fleet.machines[0].lastScoreMinAgo=120;
      fleet.machines[0].operatorStatus={state:'held',ownerVerified:true,reason:'Capacity hold'};
      await route.fulfill({json:fleet});
    });
  }, async () => {
    require((await page.locator('.operator-status').first().textContent()).includes('Paused by operator'), 'hold was hidden');
    require((await page.locator('#overview-workers').textContent()).includes('1 deliberately paused'), 'overview omitted hold');
  });
  await scenario('overview has an explicit empty state when no verified file is available', async () => {
    await page.route('**/api/artifact-availability*',route=>{
      const ids=metadataIds(route.request().url());return route.fulfill({json:{availability:Object.fromEntries(ids.map(id=>[id,false]))}});
    });
  }, async () => {
    require(await page.locator('#overview-preview iframe').count()===0, 'unavailable artwork embedded');
    require((await page.locator('#overview-preview').textContent()).includes('No verified visual artwork'), 'empty preview kept a loading message');
  });
  await scenario("normal data and empty collections", null, async () => {
    for (const name of ["beads", "best", "elo", "scorecards", "artifacts", "provenance"]) {
      require((await chip(name).getAttribute("class")).includes("ok"), name + " is not healthy");
    }
    for (const name of ["ghosts", "improvements"]) {
      require(!(await chip(name).getAttribute("class")).includes("err"), name + " mistakes empty for failure");
    }
    require((await page.locator("body").innerText()).includes("0 re-scored verdicts"), "empty judge window not explicit");
    require((await page.locator("#champ-grid").innerText()).includes("ELO 1234"), "stale embedded ELO overrode live leaderboard");
    const connections=await page.evaluate(()=>({axis:FIELD.axisLabels.conn,degree:S.degree.size,
      text:document.querySelector('#field-vitals').textContent}));
    require(connections.degree===0 && connections.axis===null,'empty thread set exposed a connectivity axis');
    require(connections.text.includes('0/2 linked'),'historical bead identity mistaken for a thread link');
  });
  await scenario("archive mode restores the selected visualization", null, async () => {
    await page.evaluate(() => { switchViz("constellation"); setFieldMode("archive"); setFieldMode("quality"); });
    const state=await page.evaluate(() => ({mode:S.fieldMode,viz:switchViz.activeMode,
      frame:getComputedStyle(document.querySelector("#hero-viz-frame")).display,
      src:document.querySelector("#hero-viz-frame").getAttribute("src"),
      canvas:getComputedStyle(document.querySelector("#viz-canvas-wrapper")).display}));
    require(state.mode==="quality"&&state.viz==="constellation"&&state.frame==="block", "selected visualization stayed hidden after field mode restore");
    require(state.src.includes("sinter-viz-3d.html")&&state.canvas==="none", "restored visualization state was not applied");
  });
  await scenario("full history archive is the default field", async () => {
    const artifacts=Array.from({length:1200},(_,i)=>({id:`history-only-${i}`,archivedSource:i===1199}));
    await page.route("**/api/history*", route => route.fulfill({json:{artifacts,scorecards:[],sources:{archive:{name:"archive",errors:[]}}}}));
  }, async () => {
    await page.waitForFunction(() => S.fieldMode === "archive" && S.archiveCatalog.length > 1000);
    require(await page.locator("#archive-field .archive-card").count() > 1000, "full history IDs were not rendered");
    const text=await page.locator("#archive-field").innerText();
    require(text.includes("catalog entries") && text.includes("verified for comparison") && text.includes("source-only entries") && !text.includes("archived sources") && text.includes("history-only-1199") && text.includes("freshness unknown"), "archive coverage or unknown freshness labels missing");
  });
  await scenario("cached history exposes an aged producer sync", async () => {
    const old=Math.floor(Date.now()/1000)-901;
    await page.route("**/api/history*", route => route.fulfill({json:{artifacts:[{id:"aged-history"}],scorecards:[],sources:{archive:{name:"archive",checkedAt:old,lastSuccess:old,errors:{}}}}}));
  }, async () => {
    await page.waitForFunction(() => S.historyStale === true);
    const text=await page.locator("#archive-field").innerText();
    require(text.includes("stale") && text.includes("last successful archive sync"), "aged archive freshness was not surfaced");
    require(!(await chip("history").getAttribute("class")).includes("err"), "age-only history was misclassified as transport failure");
  });
  await scenario("retained snapshots do not age active history", async () => {
    const now=Math.floor(Date.now()/1000);
    await page.route("**/api/history*", route => route.fulfill({json:{artifacts:[{id:"retained-history"}],scorecards:[],sources:{
      retired:{name:"retired-vps",retained:true,lastSuccess:now-86400,errors:{transfer:"retained"}},
      active:{name:"active-archive",lastSuccess:now-30,errors:{}}
    }}}));
  }, async () => {
    await page.waitForFunction(() => S.historyLoaded && S.historyStale===false);
    const text=await page.locator("#archive-field").innerText();
    require(text.includes("fresh")&&text.includes("retained snapshot")&&text.includes("history source error"), "retained source status or errors were hidden");
    require(await page.evaluate(() => S.historyStale)===false, "old retained snapshot aged fresh active history");
  });
  await scenario("stale active history remains stale beside retained snapshots", async () => {
    const old=Math.floor(Date.now()/1000)-901;
    await page.route("**/api/history*", route => route.fulfill({json:{artifacts:[{id:"stale-active"}],scorecards:[],sources:{
      retired:{name:"retired-vps",retained:true,lastSuccess:old-86400,errors:{}},
      active:{name:"active-archive",lastSuccess:old,errors:{}}
    }}}));
  }, async () => {
    await page.waitForFunction(() => S.historyLoaded && S.historyStale===true);
    const text=await page.locator("#archive-field").innerText();
    require(text.includes("stale")&&text.includes("retained snapshot"), "stale active source was hidden or retained snapshot unlabeled");
  });
  await scenario("remote scorecards join without weakening quality mode", async () => {
    const axes={D:8,A:8,R:8,N:8};
    const judge=(vendor,score=8)=>({vendor,axes:{D:score,A:score,R:score,N:score}});
    await page.route("**/api/history*", route => route.fulfill({json:{
      artifacts:[{id:"remote-verified"},{id:"remote-unmarked"}],
      scorecards:[
        {file:"archive--score-2000000000000.json",record:{artifact:"remote-verified",domain:"p5",ensemble:axes,judges:[judge("remote-one"),judge("remote-two")],scoreScale:10,scoringContract:"spu-2.0-literal-v1"}},
        {file:"archive--score-2000000001000.json",record:{artifact:"remote-unmarked",domain:"p5",ensemble:judge("x").axes,judges:[judge("remote-one"),judge("remote-two")],scoreScale:10}}
      ],thirdJudge:[{file:"archive--tjp-2000000000000.json",record:{timestamp:2000000000000,domains:["p5"],consensus:{D:8,A:8,R:8,N:8},team:{one:{D:8},two:{D:8}}}}],sources:{archive:{name:"archive",errors:[]}}}}));
  }, async () => {
    await page.waitForFunction(() => S.archiveScorecards.size === 2 && S.archiveCatalog.some(r=>r.id === "remote-verified"));
    await page.waitForFunction(() => document.querySelector("#third-judge-body")?.innerText.includes("archived fleet panel"));
    require(await page.evaluate(() => S.scorecards.size > 0), "local scorecard cache was evicted by remote history");
    require((await page.locator("#judge-tbl").innerText()).includes("remote-one"), "remote detailed judges were omitted");
    await page.locator("#quality-field-btn").click();
    await page.waitForFunction(() => S.fieldMode === "quality" && FIELD.beads.length > 0);
    const field=await page.evaluate(() => FIELD.beads.map(b=>b.id));
    require(field.includes("remote-verified") && !field.includes("remote-unmarked"), "verified mode admitted an unmarked history score");
    await page.evaluate(() => openArtifact("remote-verified","p5",8));
    const detail=await page.locator("#modal-strip").innerText();
    require(detail.includes("Original historical record") && detail.includes("remote-one"), "playable history lost scorecard detail");
    await page.evaluate(() => closeModal());
  });
  let historyCalls=0;
  await scenario("history outage retains archive and archived source", async () => {
    const payload={artifacts:[{id:"archived-source-id",archivedSource:true},{id:"history-retained"}],scorecards:[{file:"archive--score-2000000000000.json",record:{artifact:"archived-source-id",domain:"p5",ensemble:{D:3,A:4,R:5,N:6},judges:[{vendor:"old-one",axes:{D:3,A:4,R:5,N:6}},{vendor:"old-two",axes:{D:3,A:4,R:5,N:6}}]}}],sources:{archive:{name:"archive",errors:["optional archive gap"]}}};
    const recovered={...payload,sources:{archive:{name:"archive",errors:[]}}};
    await page.route("**/api/history*", route => {
      historyCalls++;
      return route.fulfill(historyCalls===2?{status:503,body:"history outage"}:historyCalls===3?{json:recovered}:{json:payload});
    });
    await page.route("**/api/artifact-availability*", async route => {
      const ids=metadataIds(route.request().url());
      await route.fulfill({json:{availability:Object.fromEntries(ids.map(id=>[id,id!=="archived-source-id"]))}});
    });
  }, async () => {
    await page.waitForFunction(() => S.historyArtifacts.includes("archived-source-id") && S.artAvailability.get("archived-source-id") === false);
    const before=await page.locator("#archive-field .archive-card").count();
    require((await page.locator("#archive-field").innerText()).includes("history source error"), "history source errors were hidden");
    await page.evaluate(async () => { await loadHistory(); computeDerived(); renderAll(); });
    require(historyCalls === 2 && await page.locator("#archive-field .archive-card").count() === before, "history outage discarded retained archive");
    require(await page.locator('#sec-field .stale-banner[data-src="history"]').count() === 1, "history outage was not marked stale");
    await page.evaluate(() => openArtifact("archived-source-id","archive",null));
    const modalText=await page.locator("#modal-body").innerText();
    require(modalText.includes("View archived source") && modalText.includes("Original historical record") && modalText.includes("old-one"), "archived score detail or source rescue link was hidden");
    await page.evaluate(async () => { await loadHistory(); computeDerived(); renderAll(); });
    require(historyCalls === 3 && await page.locator('#sec-field .stale-banner[data-src="history"]').count() === 0, "history recovery stayed stale");
  });
  await scenario("quality contract gates aggregate scores", async () => {
    await page.route("**/fleet/merged/trend.jsonl*", async route => {
      const response = await route.fetch();
      const common = {event_type:"artifact_scored", domain:"tone", ts:new Date().toISOString(),
        axes:"D=8 A=8 R=8 N=8", scoreScale:10, scoringContract:"spu-2.0-literal-v1"};
      const rows = [
        {...common, artifact:"single-judge", judges:["one"]},
        {...common, artifact:"missing-judges"},
        {...common, artifact:"duplicate-judges", judges:["zai/GLM","glm"]},
        {...common, artifact:"verified-new", judges:["one","two"]},
      ];
      await route.fulfill({body:(await response.text())+rows.map(row=>JSON.stringify(row)).join("\n")+"\n"});
    });
  }, async () => {
    const status = await chip("scorecards").innerText();
    require(status.includes("6 artifacts") && status.includes("3 quality-unverified"), "quality gaps hidden");
    require(await page.locator('#sec-analytics .stale-banner[data-src="scorecards"]').count() === 0, "quality exclusion mislabeled as stale refresh");
    require((await page.locator("#dist-n").innerText()).startsWith("3 verified scored artifacts"), "unsupported rows entered analytics");
    const state = await page.evaluate(() => Object.fromEntries(S.scRows.map(row => [row.id, row.score])));
    require(state["single-judge"] === null && state["missing-judges"] === null && state["duplicate-judges"] === null, "unsupported rows retained a score");
    require(state["verified-new"] === 8, "two-judge row was not admitted");
    const field = await page.evaluate(() => ({ axes: document.querySelector("#hero-hud .axes").innerText,
      craft: FIELD.axisLabels.craft, vitals: document.querySelector("#field-vitals").innerText }));
    require(field.craft !== null && field.axes.includes("ensemble mean"), "current verified scores missing from field");
    require(field.vitals.includes("average ensemble score") && field.vitals.includes("score coverage") && field.vitals.includes("3/3 verified"), "field quality coverage is hidden");
    const fieldIds=await page.evaluate(()=>FIELD.beads.map(b=>b.id));
    require(fieldIds.includes("verified-new")&&!fieldIds.includes("single-judge"), "field omitted new verified art or admitted unsupported quality");
    const tip = await page.evaluate(() => { showBeadTip(S.beads[0], 1, 1); return $("#hero-tip").innerText; });
    require(tip.includes("ensemble mean —") && !tip.includes("⟨R1⟩"), "legacy bead mean rendered as verified quality");
  });
  await scenario("initial trend outage preserves rendered scorecards", async () => {
    await page.route("**/fleet/merged/trend.jsonl*", route => route.fulfill({status:503,body:"fixture outage"}));
  }, async () => {
    require((await chip("trend").getAttribute("class")).includes("err"), "trend outage hidden");
    require(await page.locator('#sec-analytics .stale-banner[data-src="trend"]').count() === 1, "trend refresh failure lost stale banner");
    require((await chip("scorecards").innerText()).includes("2 artifacts (2 detailed)"), "local scorecards lost during outage");
    require((await page.locator("#champ-grid").innerText()).includes("ELO 1234"), "outage prevented rendering");
  });
  await scenario("malformed children retain good data", async () => {
    await page.route("**/fleet/merged/beads.json*", async route => {
      const response = await route.fetch();
      const rows = await response.json();
      await route.fulfill({ json: [rows[0], null] });
    });
  }, async () => {
    require((await chip("beads").innerText()).includes("1/2"), "valid bead was lost or bad bead accepted");
    require((await chip("beads").getAttribute("class")).includes("err"), "drop not visible");
    require((await page.locator("#hud-count").innerText()) === "2", "damaged archive removed current verified scores");
  });
  await scenario("fresh score does not hide engine failures", async () => {
    await page.route("**/fleet/fleet.json*", async route => {
      const response = await route.fetch();
      const fleet = await response.json();
      fleet.machines[0].lastScoreMinAgo = 1;
      fleet.machines[0].operatorStatus = {state:'active',ownerVerified:true};
      fleet.machines[0].engineActivity = { available: true, sampleLines: 300, turnsStarted: 8, turnsFailed: 6 };
      await route.fulfill({ json: fleet });
    });
  }, async () => {
    await page.waitForFunction(() => document.querySelector('.engine-activity')?.textContent.includes('6 failed turns'));
    const body = await page.locator('#fleet-body').innerText();
    require(body.includes('6 failed turns') && body.includes('8 starts'), 'fresh score hid failed turns');
    require((await page.locator('#overview-attention').textContent()).includes('6 failed turns'), 'overview hid active worker failures');
    require(body.includes('not success rates or full engine health'), 'scope of health claim missing');
  });
  await scenario("hostile fleet values and unreachable metrics", async () => {
    await page.route("**/fleet/fleet.json*", async route => {
      const response = await route.fetch();
      const fleet = await response.json();
      const payload = '<img src=x onerror="window.__qaInjected=1">';
      fleet.partial = true;
      fleet.retiredHistoryUnavailable = true;
      fleet.machines[0].name = payload;
      fleet.machines[0].unreachable = true;
      fleet.machines[0].scored = null;
      fleet.machines[0].moves = null;
      fleet.machines[0].lastScoreMinAgo = null;
      if (fleet.recentMix) fleet.recentMix.total = payload;
      await route.fulfill({ json: fleet });
    });
  }, async () => {
    require(await page.evaluate(() => window.__qaInjected === 0), "injected handler executed");
    require(await page.locator('img[src="x"]').count() === 0, "hostile value became markup");
    const body = await page.locator("body").innerText();
    require(/partial/i.test(body) && /n\/a/.test(body), "partial/unreachable truth missing");
  });
  await scenario("quality exclusions keep the preserved-history label", async () => {
    await page.route("**/fleet/fleet.json*", async route => {
      const response=await route.fetch(); const fleet=await response.json();
      fleet.secondJudge={...(fleet.secondJudge||{}),results:Array.isArray(fleet.secondJudge?.results)?fleet.secondJudge.results:[],droppedRecords:1};
      await route.fulfill({json:fleet});
    });
  }, async () => {
    await page.waitForFunction(() => document.querySelector("#fleet-drops")?.innerText.includes("QUALITY EXCLUSIONS"));
    const text=await page.locator("#fleet-drops").innerText();
    require(text.includes("QUALITY EXCLUSIONS")&&!text.includes("DROPPED DATA"), "quality exclusions used the old dropped-data headline");
  });
  await scenario("unavailable artifact and provenance", async () => {
    await page.route("**/api/artifact-availability*", async route => {
      const ids = metadataIds(route.request().url());
      await route.fulfill({json:{availability:Object.fromEntries(ids.map(id => [id, id !== "r13-one"]))}});
    });
    await page.route("**/art/r13-one/*", route => route.fulfill({ status: 404, body: "fixture unavailable" }));
  }, async () => {
    require((await chip("artifacts").getAttribute("class")).includes("err"), "missing artifact marked available");
    require((await chip("provenance").getAttribute("class")).includes("err"), "missing provenance marked healthy");
    require(await page.locator('iframe[src*="r13-one"]').count() === 0, "missing artifact was embedded");
  });
  await scenario("provenance gaps stay visible and recover", async () => {
    let loads = 0;
    await page.route("**/fleet/fleet.json*", async route => {
      const response = await route.fetch();
      const fleet = await response.json();
      if (loads++ === 0) {
        fleet.partial = true;
        fleet.provenanceUnavailable = {"Fixture:legacy/provenance.txt": "missing"};
      } else {
        fleet.provenanceUnavailable = {};
        fleet.partial = false;
      }
      await route.fulfill({json: fleet});
    });
    await page.route("**/art/*/provenance.txt", route => route.fulfill({status: 204, body: ""}));
  }, async () => {
    await page.waitForFunction(() => document.body.innerText.includes("provenance unavailable ×1"));
    const first = await page.locator("body").innerText();
    require(first.includes("artifact identities remain unknown"), "provenance gap lacks an honest identity message");
    require(first.includes("unknown / provenance unavailable"), "unresolved identity was hidden");
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#fleet-body")?.innerText.includes("VERIFIED COMPARISONS"));
    await page.waitForFunction(() => !document.body.innerText.includes("provenance unavailable ×1"));
    require(!(await page.locator("body").innerText()).includes("provenance unavailable ×1"), "recovered provenance gap stayed visible");
  });
  await scenario("fleet history fills gaps without inventing judge scores", async () => {
    await page.route("**/fleet/merged/trend.jsonl*", async route => {
      const response=await route.fetch();
      const row={event_type:"artifact_scored",artifact:"remote-only",domain:"tone",
        ts:new Date().toISOString(),axes:"D=8 A=8 R=8 N=8 | judges: one+two | defects: 0"};
      await route.fulfill({body:(await response.text())+JSON.stringify(row)+"\n"});
    });
  }, async () => {
    require((await chip("scorecards").innerText()).includes("3 artifacts (2 detailed)"), "fleet summary absent or local detail lost");
    require((await page.locator("body").innerText()).includes("Verified detailed judge panels cover 2/3 artifacts"), "judge coverage overstated");
  });
  await scenario("referenced rounded trend retains original judge detail", null, async () => {
    const result=await page.evaluate(() => {
      const card=parseScorecardRecord({artifact:'rounding',domain:'p5',
        ensemble:{D:2.3499999999999996,A:2.55,R:2.75,N:2.3},
        judges:[{vendor:'original-one',axes:{D:2,A:2,R:2,N:2}},
          {vendor:'original-two',axes:{D:3,A:3,R:3,N:3}}]},'worker--score-1000000000000.json');
      S.scorecards=new Map([[card.file,card]]); S.archiveScorecards=new Map();
      const row={artifact:'rounding',domain:'p5',ts:1000000000001,
        axes:'D=2.35 A=2.55 R=2.75 N=2.3',parsed:{D:2.35,A:2.55,R:2.75,N:2.3},
        scorecard:'score-1000000000000.json'};
      S.trendRows=[row]; const linked=archiveScorecards()[0];
      S.trendRows=[{...row,scorecard:undefined}]; const unlinked=archiveScorecards()[0];
      S.trendRows=[{...row,parsed:{D:8,A:8,R:8,N:8}}]; const changed=archiveScorecards()[0];
      S.trendRows=[{...row,ts:card.ms,scorecard:undefined}]; const exact=archiveScorecards()[0];
      return {judges:linked.judges.length,score:linked.score,reason:linked.qualityReason,
        unlinked:unlinked.fleetSummary,changed:changed.fleetSummary,exact:exact.judges.length};
    });
    require(result.judges===2 && result.exact===2,'original judge detail discarded by rounding');
    require(result.score===null && result.reason==='scale-unverified','historical scores promoted to verified');
    require(result.unlinked && result.changed,'different or unidentified scoring events merged');
  });
  await scenario("playable paths preserve artwork identity across rescoring", async () => {
    await page.route("**/fleet/merged/beads.json*", async route => {
      const response = await route.fetch();
      const beads = await response.json();
      await route.fulfill({json:beads.map(bead => ({...bead, domain:"unknown"}))});
    });
    await page.route("**/fleet/merged/trend.jsonl*", async route => {
      const response = await route.fetch();
      const rows = (await response.text()).trim().split("\n").map(JSON.parse);
      rows.forEach(row => { row.artifact = `/runtime/artifacts/${row.artifact}/playable.html`; });
      rows.push({...rows[0], ts:new Date(Date.now()+1000).toISOString(),
        axes:"D=6 A=6 R=6 N=6 | judges: one+two | defects: 0"});
      await route.fulfill({body:rows.map(row => JSON.stringify(row)).join("\n")+"\n"});
    });
  }, async () => {
    require((await chip("scorecards").innerText()).includes("2 artifacts"), "playable filenames collapsed artwork identities or duplicated rescoring");
    const state = await page.evaluate(() => ({
      rows:S.scRows.map(row => ({id:row.id,score:row.score,domain:row.dom})),
      available:[...S.artAvailability.entries()]
    }));
    require(state.rows.find(row => row.id === "r13-one")?.score === 6, "latest rescore did not update its original artwork");
    require(state.rows.some(row => row.id === "r13-two"), "second artwork disappeared");
    require(state.rows.find(row => row.id === "r13-one")?.domain === "p5", "full-path trend did not correct the first unknown domain");
    require(state.rows.find(row => row.id === "r13-two")?.domain === "glsl", "full-path trend did not correct the second unknown domain");
    require(!state.available.some(([id]) => id === "playable.html"), "playable filename used as artifact route");
    require(state.available.some(([id,ok]) => id === "r13-one" && ok), "canonical artwork unavailable");
  });
  await scenario("undated and numeric timestamp history retains zero scores", async () => {
    await page.route("**/fleet/merged/trend.jsonl*", async route => {
      const response=await route.fetch();
      const rows=[{artifact:"undated-zero"},{artifact:"epoch-seconds",ts:Math.floor(Date.now()/1000)},
        {artifact:"epoch-milliseconds",ts:Date.now()},{artifact:"invalid-zero-date",ts:0},
        {artifact:"invalid-negative-date",ts:-1}].map(row=>JSON.stringify({
          event_type:"artifact_scored",domain:"tone",axes:"D=0 A=0 R=0 N=0",judges:["one","two"],
          scoreScale:10,scoringContract:"spu-2.0-literal-v1",...row}));
      await route.fulfill({body:(await response.text())+rows.join("\n")+"\n"});
    });
  }, async () => {
    const status=await chip("scorecards").innerText();
    require(status.includes("7 artifacts (2 detailed)") && status.includes("3 undated"), "history dates dropped or fabricated");
    require((await page.locator("#heat-n").innerText()).startsWith("7 "), "valid zero scores omitted from provenance");
    require((await page.locator("#tl-caption").innerText()).includes("4 timestamped artifacts · 3 undated omitted"), "timeline fabricated dates or omitted epoch timestamps");
  });
  await scenario("third judge selects newest panels and exposes failed files", async () => {
    await page.route("**/third-judge/*", async route => {
      const name = route.request().url().split("?")[0].split("/").pop();
      if (!name) {
        await route.fulfill({body:Array.from({length:7},(_,i)=>`<a href="panel-${i}.json">panel</a>`).join("")});
      } else if (name === "panel-6.json") {
        await route.fulfill({json:{domains:"malformed child",consensus:99}});
      } else {
        const index = Number(name.match(/\d+/)[0]);
        await route.fulfill({json:{timestamp:Date.now()-(5-index)*60000,
          domain:"qa-panel-"+index, consensus:{D:8,A:8,R:8,N:8}, team:{one:{D:8}}}});
      }
    });
  }, async () => {
    const body = await page.locator("#third-judge-body").innerText();
    require(body.includes("qa-panel-5") && !body.includes("qa-panel-0"), "newest five panel selection failed");
    require(body.indexOf("qa-panel-5") < body.indexOf("qa-panel-1"), "panels not newest first");
    require(body.includes("1 third-judge file(s) failed"), "per-file failure hidden");
  });
  let localTjpFailed=true;
  await scenario("archived TJP panels survive a local directory failure", async () => {
    const remote={timestamp:Date.now(),domain:"archived-only",consensus:{D:8,A:8,R:8,N:8},team:{one:{D:8}}};
    const local={timestamp:Date.now()+1000,domain:"local-recovered",consensus:{D:7,A:7,R:7,N:7},team:{one:{D:7}}};
    await page.route("**/api/history*", route => route.fulfill({json:{artifacts:[],scorecards:[],thirdJudge:[{file:"archive.json",record:remote}],sources:{}}}));
    await page.route("**/third-judge/*", async route => {
      const url=route.request().url();
      if(url.replace(/\/+$/,'').endsWith("/third-judge")){
        if(localTjpFailed) return route.fulfill({status:503,body:"local TJP unavailable"});
        return route.fulfill({body:'<a href="recovered.json">recovered</a>'});
      }
      return route.fulfill({json:local});
    });
  }, async () => {
    await page.waitForFunction(() => document.querySelector("#third-judge-body")?.innerText.includes("archived-only"));
    const body=await page.locator("#third-judge-body").innerText();
    require(body.includes("local third-judge directory failed") && body.includes("archived fleet panel"), "local TJP failure hid archived panels");
    require(await page.locator("#sec-third-judge .stale-banner.tjp").count()===1, "local TJP failure was not marked stale");
    localTjpFailed=false;
    await page.evaluate(async () => { await S._loadThirdJudge(); });
    require((await page.locator("#third-judge-body").innerText()).includes("local-recovered"), "local TJP recovery did not render");
    require(await page.locator("#sec-third-judge .stale-banner.tjp").count()===0, "local TJP recovery stayed stale");
  });
  await scenario("local and archived TJP duplicates consume one slot", async () => {
    const now=Date.now();
    const panel=(domain,offset)=>({timestamp:now-offset,domain,consensus:{D:8,A:8,R:8,N:8},team:{one:{D:8}}});
    const locals=[panel("duplicate-panel",1000),panel("second-panel",2000),panel("third-panel",3000),panel("fourth-panel",4000),panel("tail-panel",5000)];
    const duplicate={...locals[0],timestamp:undefined,ts:new Date(locals[0].timestamp).toISOString()};
    await page.route("**/api/history*", route => route.fulfill({json:{artifacts:[],scorecards:[],thirdJudge:[{file:"archived-duplicate.json",record:duplicate}],sources:{}}}));
    await page.route("**/third-judge/*", async route => {
      const url=route.request().url();
      if(url.replace(/\/+$/,'').endsWith("/third-judge")) return route.fulfill({body:locals.map((_,i)=>`<a href="local-${i}.json">local</a>`).join("")});
      const index=Number(url.match(/local-(\d+)\.json/)?.[1]);
      return route.fulfill({json:locals[index]});
    });
  }, async () => {
    const body=await page.locator("#third-judge-body").innerText();
    require((body.match(/duplicate-panel/g)||[]).length===1, "duplicate local/archive TJP panel rendered twice");
    require(body.includes("tail-panel"), "duplicate TJP consumed a newest-five slot");
  });
  let manifestCalls = 0, manifestIds = [], legacyManifestHeads = 0;
  await scenario("bulk artifact availability avoids legacy probe storm", async () => {
    await page.route("**/fleet/merged/trend.jsonl*", async route => {
      const response = await route.fetch();
      const rows = Array.from({length:100}, (_, i) => JSON.stringify({
        event_type:"artifact_scored", artifact:i.toString(16).padStart(16,"0"), domain:"unknown",
        ts:new Date().toISOString(), axes:"D=8 A=8 R=8 N=8 | judges: one+two | defects: 0",
        judges:["one","two"],scoreScale:10,scoringContract:"spu-2.0-literal-v1"
      }));
      await route.fulfill({body:(await response.text())+rows.join("\n")+"\n"});
    });
    await page.route("**/api/artifact-availability*", async route => {
      const query = route.request().url().split("?ids=")[1] || "";
      const ids = decodeURIComponent(query.split("&")[0]).split(",").filter(Boolean);
      manifestCalls++; manifestIds.push(ids);
      await route.fulfill({json:{availability:Object.fromEntries(ids.map((id,i) => [id,i !== 0]))}});
    });
    await page.route("**/art/*/playable.html*", async route => {
      if (route.request().method() === "HEAD") legacyManifestHeads++;
      await route.fulfill({status:500,body:"legacy probe should not run"});
    });
  }, async () => {
    require(manifestCalls === 2 && manifestIds.every(ids=>ids.length<=64), "full metadata coverage did not use bounded batches");
    require(legacyManifestHeads === 0, "manifest path still issued legacy HEAD probes");
    const status = await chip("artifacts").innerText();
    require(status.includes("102/102") && status.includes("2 unavailable") && !status.includes("unknown"), "complete metadata scan was not rendered");
    require((await chip("artifacts").getAttribute("class")).includes("err"), "unavailable files were hidden");
  }, async () => {
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('header [title="artifacts"]')?.textContent.includes("102/102"));
    await page.locator('header details > summary').click();
  });
  let malformedAvailabilityCalls = 0, malformedAvailabilityHeads = 0;
  await scenario("malformed availability stays unknown without legacy probes", async () => {
    await page.route("**/api/artifact-availability*", async route => {
      malformedAvailabilityCalls++;
      await route.fulfill({json:{availability:[]}});
    });
    await page.route("**/art/*/playable.html*", async route => {
      if (route.request().method() === "HEAD") malformedAvailabilityHeads++;
      await route.fulfill({status:500,body:"legacy probe should not run"});
    });
  }, async () => {
    const status = await chip("artifacts").innerText();
    require(malformedAvailabilityCalls === 1 && malformedAvailabilityHeads === 0, "malformed manifest triggered legacy probes");
    require(status.includes("0/2") && status.includes("unknown"), "malformed manifest hid unknown availability");
    require((await chip("artifacts").getAttribute("class")).includes("err"), "malformed manifest was reported complete");
    await page.waitForFunction(() => document.querySelector('#sec-gallery .stale-banner[data-src="artifacts"]'));
    require(await page.locator('#sec-gallery .stale-banner[data-src="artifacts"]').count() === 1, "availability refresh failure was not marked stale");
  });
  let recoveryAvailabilityCalls = 0, recoveryAvailabilityHeads = 0;
  await scenario("availability outage recovers on the next load", async () => {
    await page.route("**/api/artifact-availability*", async route => {
      recoveryAvailabilityCalls++;
      if (recoveryAvailabilityCalls === 1) return route.fulfill({status:503,body:"metadata outage"});
      const ids = metadataIds(route.request().url());
      await route.fulfill({json:{availability:Object.fromEntries(ids.map(id => [id, true]))}});
    });
    await page.route("**/art/*/playable.html*", async route => {
      if (route.request().method() === "HEAD") recoveryAvailabilityHeads++;
      await route.fulfill({status:500,body:"legacy probe should not run"});
    });
  }, async () => {
    require(recoveryAvailabilityCalls === 1 && recoveryAvailabilityHeads === 0, "outage was not bounded to metadata");
    require((await chip("artifacts").getAttribute("class")).includes("err"), "metadata outage was hidden");
    await page.reload();
    await page.waitForFunction(() => document.querySelector('header [title="artifacts"]')?.textContent.includes("2/2"));
    require(recoveryAvailabilityCalls === 2 && recoveryAvailabilityHeads === 0, "metadata recovery used legacy probes");
    require((await chip("artifacts").getAttribute("class")).includes("ok"), "recovered metadata stayed degraded");
    require(await page.locator('#sec-gallery .stale-banner[data-src="artifacts"]').count() === 0, "recovered availability stayed stale");
  });
  let ghostManifestCalls = 0, ghostDirectoryCalls = 0;
  await scenario("optional ghost manifest avoids missing-directory requests", async () => {
    await page.route("**/api/ghosts*", async route => {
      ghostManifestCalls++;
      if (ghostManifestCalls === 1) return route.fulfill({json:{available:false,entries:[]}});
      await route.fulfill({json:{available:true,entries:["r1"]}});
    });
    await page.route("**/ghost-alive-v2/**", async route => {
      const url = route.request().url();
      if (url.includes("/r1/source.txt")) return route.fulfill({body:"// recovered ghost\ns(\"bd\").n(\"0\")"});
      ghostDirectoryCalls++;
      await route.fulfill({status:500,body:"legacy ghost directory should not be requested"});
    });
  }, async () => {
    await page.waitForFunction(() => document.querySelector("#ghost-strip")?.innerText.includes("ghost archive unavailable"));
    require(ghostManifestCalls === 1, "ghost availability manifest was not fetched once");
    require(ghostDirectoryCalls === 0, "missing ghost archive still triggered directory requests");
    require((await chip("ghosts").innerText()).includes("unavailable"), "ghost archive gap was hidden");
    require(!(await chip("ghosts").getAttribute("class")).includes("err"), "optional ghost archive became transport failure");
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#ghost-strip")?.innerText.includes("r1"));
    require(ghostManifestCalls === 2 && ghostDirectoryCalls === 0, "ghost recovery used a directory probe");
    require((await chip("ghosts").getAttribute("class")).includes("ok"), "recovered ghost archive stayed unavailable");
  });
  let ghostSourceCalls = 0, failGhostSource = false;
  await scenario("ghost source failure is stale and recovers", async () => {
    await page.route("**/api/ghosts*", route => route.fulfill({json:{available:true,entries:["r1"]}}));
    await page.route("**/ghost-alive-v2/**", async route => {
      if (!route.request().url().includes("/r1/source.txt")) return route.fulfill({status:500,body:"unexpected ghost request"});
      ghostSourceCalls++;
      if (failGhostSource) return route.fulfill({status:503,body:"ghost source outage"});
      await route.fulfill({body:"// valid ghost\ns(\"bd\").n(\"0\")"});
    });
  }, async () => {
    await page.waitForFunction(() => document.querySelector("#ghost-strip")?.innerText.includes("r1"));
    require(ghostSourceCalls === 1, "initial ghost source was not loaded");
    require((await chip("ghosts").getAttribute("class")).includes("ok"), "initial ghost source was not healthy");
    failGhostSource = true;
    await page.evaluate(async () => { S._staticOk=false; await loadStaticOnce(); renderStaleBanners(); });
    require(ghostSourceCalls === 2, "ghost source failure was not retried");
    require((await chip("ghosts").getAttribute("class")).includes("err"), "ghost source failure was not explicit");
    require(await page.locator('#sec-ghosts .stale-banner[data-src="ghosts"]').count() === 1, "ghost source failure was not marked stale");
    require((await page.locator("#ghost-strip").innerText()).includes("r1"), "last valid ghost list was discarded");
    failGhostSource = false;
    await page.evaluate(async () => { S._staticOk=false; await loadStaticOnce(); renderStaleBanners(); });
    require(ghostSourceCalls === 3, "ghost source recovery was not retried");
    require((await chip("ghosts").getAttribute("class")).includes("ok"), "recovered ghost source stayed degraded");
    require(await page.locator('#sec-ghosts .stale-banner[data-src="ghosts"]').count() === 0, "recovered ghost source stayed stale");
  });
  let archiveAvailability = 0, archiveHeads = 0, archiveSources = 0;
  await scenario("large archives bound metadata and source probes", async () => {
    await page.route("**/fleet/merged/trend.jsonl*", async route => {
      const response = await route.fetch();
      const rows = Array.from({length:100}, (_, i) => JSON.stringify({
        event_type:"artifact_scored", artifact:i.toString(16).padStart(16,"0"), domain:"unknown",
        ts:new Date().toISOString(), axes:"D=8 A=8 R=8 N=8 | judges: one+two | defects: 0",
        judges:["one","two"],scoreScale:10,scoringContract:"spu-2.0-literal-v1"
      }));
      await route.fulfill({body:(await response.text())+rows.join("\n")+"\n"});
    });
    await page.route("**/api/artifact-availability*", route => { archiveAvailability++; return route.fulfill({status:503,body:"metadata outage"}); });
    await page.route("**/art/*/playable.html*", async route => {
      if (route.request().method() === "HEAD") archiveHeads++;
      await route.continue();
    });
    await page.route("**/art/*/source.txt*", async route => {
      archiveSources++;
      await route.fulfill({status:404,body:"fixture source unavailable"});
    });
  }, async () => {
    await page.waitForTimeout(200);
    require(archiveAvailability <= 2, "metadata outage exceeded the two in-flight batches");
    require(archiveHeads === 0, "metadata outage triggered legacy playable probes");
    require(archiveSources === 64, "first refresh did not bound source probes: " + archiveSources);
    require((await chip("artifacts").innerText()).includes("0/102") && (await chip("artifacts").innerText()).includes("unknown"), "unknown archive coverage hidden");
    require((await chip("artifacts").getAttribute("class")).includes("err"), "metadata outage was reported complete");
    require((await page.locator('#overview-preview').textContent()).includes('could not be refreshed'), 'preview outage kept a loading message');
  }, async () => {
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('header [title="artifacts"]')?.textContent.includes("0/102"));
    await page.locator('header details > summary').click();
  });
  await scenario("mobile controls remain reachable", null, async () => {
    await page.setViewportSize({width:390,height:844});
    try {
    await page.evaluate(()=>health('scorecards',false,'3599 artifacts (277 detailed) · 105 undated · 3528 quality-unverified'));
    const sizes=await page.evaluate(()=>({body:document.documentElement.scrollWidth,viewport:innerWidth}));
    require(sizes.body<=sizes.viewport+1,"page overflows mobile viewport");
    await page.getByRole("link",{name:"GALLERY",exact:true}).click();
    require(page.url().endsWith("/session-gallery.html"),"mobile gallery navigation failed");
    await page.goBack();
    await page.getByRole("link",{name:"TIMELINE",exact:true}).click();
    await page.waitForTimeout(500);
    require(await page.locator('nav').evaluate(el=>el.getBoundingClientRect().top>=0),'sticky navigation covered by header');
    } finally { await page.setViewportSize({width:1280,height:720}); }
  });
  await scenario("field pauses when scrolled out of view", null, async () => {
    await page.waitForFunction(() => window.__qaDraws > 0);
    await page.getByRole("link", { name: "TIMELINE", exact: true }).click();
    await page.waitForTimeout(500);
    const before = await page.evaluate(() => window.__qaDraws);
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => window.__qaDraws);
    require(before === after, "hidden field continued drawing");
  });
  await scenario("newer summaries retain detailed judge evidence", async () => {
    await page.route("**/fleet/merged/trend.jsonl*", async route=>{
      const response=await route.fetch();
      const row={event_type:"artifact_scored",artifact:"r13-one",domain:"p5",ts:Date.now()+10000,
        axes:"D=6 A=6 R=6 N=6",judges:["eye-one","eye-two"],scoreScale:10,scoringContract:"spu-2.0-literal-v1"};
      await route.fulfill({body:(await response.text())+JSON.stringify(row)+"\n"});
    });
  }, async ()=>{
    require((await page.locator('#dis-n').innerText()).startsWith('2 artifacts'), 'summary erased detailed judge panel');
    require(await page.evaluate(()=>S.scRows.find(r=>r.id==='r13-one').score)===6, 'older detail overrode current ensemble');
    require((await page.locator('#judge-tbl').innerText()).includes('eye-one'), 'individual judge breakdown is empty');
  });
  let metadataRemoved=false;
  await scenario("scorecard deletion and replacement reconcile detail cache", null, async()=>{
    const files=await page.evaluate(()=>[...S.scorecards.keys()].sort());
    await page.route('**/.omx/atelier/scorecards/?*', route=>route.fulfill({contentType:'text/html',
      body:`<a href="${files[1]}" data-revision="replacement">${files[1]}</a>`}));
    await page.route(`**/scorecards/${files[1]}*`, async route=>{
      const response=await route.fetch(), row=await response.json();
      row.ensemble={D:6,A:6,R:6,N:6}; row.judges.forEach(j=>j.axes=row.ensemble);
      await route.fulfill({json:row});
    });
    await page.evaluate(async()=>{await loadScorecards();computeDerived();renderAll();});
    require(await page.evaluate(f=>!S.scorecards.has(f),files[0]),'deleted detailed panel stayed cached');
    require(await page.evaluate(f=>S.scorecards.get(f)?.score,files[1])===6,'replacement scorecard was not reloaded');
    require((await page.locator('#dis-n').innerText()).startsWith('1 artifacts'),'deleted detail still contributes to judging analytics');
  });
  await scenario("slow metadata does not block core refresh", async ()=>{
    await page.route('**/api/artifact-availability*', async route=>{
      await new Promise(resolve=>setTimeout(resolve,4000));
      const ids=metadataIds(route.request().url());
      await route.fulfill({json:{availability:Object.fromEntries(ids.map(id=>[id,true]))}});
    });
  }, async ()=>{
    require(await page.evaluate(()=>metadataBusy),'metadata delay was not exercised');
    const refreshed=await page.evaluate(async()=>{const previous=lastRefresh;await tick();return lastRefresh>previous&&metadataBusy;});
    require(refreshed,'current score refresh waited for metadata');
    await page.waitForFunction(()=>!metadataBusy);
  }, async()=>{
    await page.goto(base);
    await page.waitForFunction(()=>typeof renderCount!=='undefined'&&renderCount>0);
  });
  await scenario("bulk provenance refresh removes stale identities", async ()=>{
    await page.route('**/api/artifact-availability*', route=>{
      const ids=metadataIds(route.request().url());
      return route.fulfill({json:{availability:Object.fromEntries(ids.map(id=>[id,true])),
        provenance:Object.fromEntries(ids.map(id=>[id,metadataRemoved?null:{identity:'bulk/model',model:'model'}]))}});
    });
  }, async ()=>{
    require(await page.evaluate(()=>S.provenance.get('r13-one')?.identity)==='bulk/model','bulk provenance not used');
    metadataRemoved=true;
    await page.evaluate(async ()=>{S._artRetry.clear();await loadArtifactAvailability();await loadProvenance();renderAll();});
    require(await page.evaluate(()=>!S.provenance.has('r13-one')),'removed provenance retained as current');
    require((await chip('provenance').innerText()).includes('2 unresolved'),'removed identity not surfaced');
  });
  await page.unrouteAll({ behavior: "wait" });
  page.off("pageerror", onError);
  return { passed: results.every(row => row.passed), scenarios: results };
}
