import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHROME = process.env.CHROME_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CONTRACT = "spu-2.0-literal-v1";
const baseRows = [
  {id:"valid-art", domain:"p5", axes:"D=8 A=8 R=8 N=8 | judges: one+two | defects: 0", judges:["one","two"], scoreScale:10, scoringContract:CONTRACT},
  {id:"second-art", domain:"glsl", axes:"D=7 A=7 R=7 N=7 | judges: one+two | defects: 0", judges:["one","two"], scoreScale:10, scoringContract:CONTRACT},
];
function snapshot(rows=baseRows, extra={}) { return {snapshotId:"qa", partial:false, retiredHistoryUnavailable:false,
  judgeCoverageUnavailable:0, judgeCoverageInsufficient:0, scoreScaleUnverified:0, scorecardIndex:rows, ...extra}; }
function trend(rows) { return rows.map(row=>JSON.stringify({...row,event_type:"artifact_scored",artifact:`artifacts/${row.id}/playable.html`,ts:"2026-09-06T04:00:00Z"})).join("\n")+"\n"; }
function historyFromTrend(text){return {artifacts:[],scorecards:String(text).split(/\r?\n/).filter(l=>l.trim()).map(l=>({record:JSON.parse(l)}))};}
function waitForServer(child) { return new Promise((resolveReady,reject)=>{
  const timer=setTimeout(()=>reject(new Error("fixture server did not start")),10000);
  child.stdout.on("data",data=>{if(String(data).includes("Synthetic dashboard ready")){clearTimeout(timer);resolveReady();}});
  child.once("exit",code=>{if(code&&!String(code).includes("Synthetic dashboard ready")){clearTimeout(timer);reject(new Error(`fixture exited ${code}`));}});
}); }
async function startFixture(){
  const port=19000+(process.pid%500), child=spawn("python3",["test/fixtures/dashboard_server.py",String(port)],{cwd:ROOT,stdio:["ignore","pipe","inherit"]});
  await waitForServer(child);return {child,base:`http://127.0.0.1:${port}`};
}
async function openGallery(browser,base,{data,trendText,availability,snapshotHandler,trendHandler,history}={}){
  const page=await browser.newPage(),errors=[],requests={availability:[],heads:0,playables:[]};
  page.on("pageerror",error=>errors.push(String(error)));page.on("request",request=>{
    if(request.method()==="HEAD")requests.heads++;
    if(request.url().includes("/api/artifact-availability"))requests.availability.push(new URL(request.url()).searchParams.get("ids")?.split(",")||[]);
    if(request.url().includes("/playable.html"))requests.playables.push(request.url());
  });
  if(snapshotHandler)await page.route("**/fleet/snapshot.json*",async route=>{const answer=await snapshotHandler();await route.fulfill(answer.status?{status:answer.status,body:answer.body||"snapshot outage"}:{status:200,contentType:"application/json",body:JSON.stringify(answer)});});
  else if(data)await page.route("**/fleet/snapshot.json*",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(data)}));
  if(history)await page.route('**/api/history*',route=>route.fulfill({json:history}));
  else if(trendHandler)await page.route('**/api/history*',async route=>{const answer=await trendHandler();await route.fulfill(answer.status?{status:answer.status,body:answer.body||'archive outage'}:{json:historyFromTrend(answer)});});
  else if(trendText!==undefined)await page.route('**/api/history*',route=>route.fulfill({json:historyFromTrend(trendText)}));
  if(history||data||trendText!==undefined||trendHandler)await page.route('**/fleet/merged/trend.jsonl*',route=>route.fulfill({body:''}));
  if(availability)await page.route("**/api/artifact-availability*",async route=>{
    const ids=new URL(route.request().url()).searchParams.get("ids")?.split(",").filter(Boolean)||[];
    const answer=await availability(ids,requests.availability.length);if(answer?.status){await route.fulfill({status:answer.status,body:answer.body||"outage"});return;}
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(answer)});
  });
  await page.goto(`${base}/session-gallery.html`,{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>document.getElementById('gallery-meta').textContent.includes(' indexed')&&document.querySelector('#gallery-grid .art-card,#gallery-grid .empty'));
  return {page,errors,requests};
}
function allAvailable(ids){return {availability:Object.fromEntries(ids.map(id=>[id,true]))};}
async function assertClean(errors){assert.deepEqual(errors,[]);}
async function main(){
  assert(existsSync(CHROME),`Chrome executable not found: ${CHROME}`);
  let fixture=null;const supplied=process.env.GALLERY_QA_URL;try{fixture=supplied?null:await startFixture();const base=supplied||fixture.base;
  const browser=await chromium.launch({headless:true,executablePath:CHROME,args:["--no-sandbox"]});
  try{
    const happy=await openGallery(browser,base),page=happy.page;
    assert.equal(/2026-08-30/.test(await page.title()),false);assert.equal(await page.locator(".art-card").count(),2);
    assert.match(await page.locator('[data-artifact="r13-one"]').textContent(),/8\.00 \/ 10/);assert.equal(happy.requests.heads,0);assert.equal(happy.requests.availability.length,1);
    await page.getByRole("button",{name:"Verified quality"}).click();assert.equal(await page.locator(".art-card").count(),2);
    await page.locator("#gallery-search").fill("r13-two");assert.equal(await page.locator(".art-card").count(),1);await page.locator("#gallery-search").fill("");
    const loaded=page.waitForResponse(response=>response.url().endsWith("/art/r13-one/playable.html"));
    await page.locator('[data-artifact="r13-one"]').click();assert.equal((await loaded).status(),200);await page.frameLocator("#player-stage iframe").locator("body").waitFor();assert.equal(await page.locator("#player-stage iframe").count(),1);assert.match(new URL(await page.locator("#player-stage iframe").getAttribute("src"),base).pathname,/\/art\/r13-one\/playable\.html$/);
    await page.locator('[data-artifact="r13-two"]').click();assert.equal(await page.locator("#player-stage iframe").count(),1);assert.match(new URL(await page.locator("#player-stage iframe").getAttribute("src"),base).pathname,/\/art\/r13-two\/playable\.html$/);await assertClean(happy.errors);await page.close();
    console.log("happy/filter/player PASS");
    const full=await openGallery(browser,base,{data:snapshot([baseRows[0]]),
      history:{artifacts:[{id:'valid-art'},{id:'never-scored'},{id:'source-only',archivedSource:true}],scorecards:[{record:baseRows[0]}]},
      availability:ids=>({availability:Object.fromEntries(ids.map(id=>[id,id!=='source-only']))})});
    assert.equal(await full.page.locator('.art-card').count(),3);
    assert.match(await full.page.locator('[data-artifact="never-scored"]').textContent(),/No valid score recorded/);
    await full.page.locator('[data-artifact="source-only"]').click();
    assert.equal(await full.page.locator('#player-stage iframe').count(),0);
    assert.match(await full.page.getByRole('link',{name:'View preserved source'}).getAttribute('href'),/\/art\/source-only\/source.txt$/);
    await assertClean(full.errors);await full.page.close();console.log('full inventory and source-only access PASS');
    let recoveryAvailable=true;
    const textId='a'.repeat(64),recovery=await openGallery(browser,base,{data:snapshot([]),
      history:{artifacts:[{id:textId}],scorecards:[]},
      availability:ids=>({...allAvailable(ids),recoveredText:{[textId]:recoveryAvailable}})});
    await recovery.page.route('**/art/**/recovered-text.html',route=>route.fulfill({contentType:'text/html',body:'<pre><span>\n  preserved text\n</span></pre>'}));
    await recovery.page.locator(`[data-artifact="${textId}"]`).click();
    assert.match(await recovery.page.locator('#player-stage iframe').getAttribute('src'),/recovered-text.html$/);
    assert.match(await recovery.page.locator('#player-status').textContent(),/this display is unscored/);
    assert.equal(await recovery.page.frameLocator('#player-stage iframe').locator('pre').textContent(),'\n  preserved text\n');
    assert.match(await recovery.page.getByRole('link',{name:'View original saved version'}).getAttribute('href'),/playable.html$/);
    recoveryAvailable=false;await recovery.page.locator('#refresh').click();
    await recovery.page.waitForFunction(()=>document.querySelectorAll('#player-stage iframe').length===0);
    await assertClean(recovery.errors);await recovery.page.close();console.log('verified text recovery and invalidation PASS');
    const unknownRows=[
      baseRows[0],
      {id:"legacy-art",domain:"glsl",axes:"D=9 A=9 R=9 N=9 | judges: one+two | defects: 0",judges:["one","two"]},
      {id:"bad-score",domain:"tone",axes:"D=11 A=9 R=9 N=9 | judges: one+two | defects: 0",judges:["one","two"],scoreScale:10,scoringContract:CONTRACT},
    ];
    const unknown=await openGallery(browser,base,{data:snapshot(unknownRows,{scoreScaleUnverified:0}),trendText:trend(unknownRows),availability:allAvailable});
    assert.match(await unknown.page.locator('[data-artifact="valid-art"]').textContent(),/8\.00 \/ 10/);assert.match(await unknown.page.locator('[data-artifact="legacy-art"]').textContent(),/Stored mean 9\.00 · scale unverified/);assert.match(await unknown.page.locator('[data-artifact="bad-score"]').textContent(),/No valid score recorded/);
    await unknown.page.getByRole("button",{name:"Unknown",exact:true}).click();assert.equal(await unknown.page.locator(".art-card").count(),2);assert.equal(unknown.requests.heads,0);await assertClean(unknown.errors);await unknown.page.close();console.log("unknown/malformed quality PASS");
    const malformedRows=[
      {...baseRows[0],id:"duplicate-axis",axes:"D=8 A=8 R=8 N=8 D=11"},
      {...baseRows[0],id:"prefixed-axis",axes:"xD=8 A=8 R=8 N=8"},
      {...baseRows[0],id:"false-axes",axes:0,ensemble:{D:8,A:8,R:8,N:8}},
      {...baseRows[0],id:"bad-artifact",artifact:42},
      {...baseRows[0],id:42},
      {...baseRows[0],id:"bad/path"},
      {...baseRows[0],id:"mismatched-id",artifact:"different-id/playable.html"},
    ];
    const malformed=await openGallery(browser,base,{data:snapshot([]),trendText:malformedRows.map(row=>JSON.stringify({...row,event_type:"artifact_scored"})).join("\n"),availability:allAvailable});
    assert.equal(await malformed.page.locator(".art-card").count(),3);
    for(const id of ["duplicate-axis","prefixed-axis","false-axes"])assert.match(await malformed.page.locator(`[data-artifact="${id}"]`).textContent(),/No valid score recorded/);
    for(const id of ["bad-artifact","42","path","mismatched-id"])assert.equal(await malformed.page.locator(`[data-artifact="${id}"]`).count(),0);
    await assertClean(malformed.errors);await malformed.page.close();console.log("strict axes and identity contract PASS");
    const missingRows=[
      {...baseRows[0],id:"present-art"},
      {...baseRows[1],id:"missing-art"},
    ];
    const missing=await openGallery(browser,base,{data:snapshot(missingRows),trendText:trend(missingRows),availability:ids=>({availability:Object.fromEntries(ids.map(id=>[id,id==="present-art"]))})});
    assert.equal(await missing.page.locator('[data-artifact="missing-art"]').isDisabled(),true);assert.match(await missing.page.locator('[data-artifact="missing-art"]').textContent(),/UNAVAILABLE/);assert.equal(await missing.page.locator('[data-artifact="present-art"]').isDisabled(),false);
    await missing.page.locator('[data-artifact="present-art"]').click();assert.equal(await missing.page.locator("#player-stage iframe").count(),1);assert.equal(missing.requests.heads,0);await assertClean(missing.errors);await missing.page.close();console.log("missing-art availability PASS");
    let playable=true;const active=await openGallery(browser,base,{data:snapshot([baseRows[0]]),trendText:trend([baseRows[0]]),availability:ids=>({availability:Object.fromEntries(ids.map(id=>[id,playable]))})});
    await active.page.locator('[data-artifact="valid-art"]').click();assert.equal(await active.page.locator("#player-stage iframe").count(),1);playable=false;await active.page.locator("#refresh").click();await active.page.waitForFunction(()=>document.querySelector('[data-artifact="valid-art"]')?.disabled&&document.querySelectorAll("#player-stage iframe").length===0);assert.equal(active.requests.heads,0);await assertClean(active.errors);await active.page.close();console.log("active playback stops on availability loss PASS");
    let outageCalls=0;
    const outage=await openGallery(browser,base,{data:snapshot([baseRows[0]]),trendText:trend([baseRows[0]]),availability:ids=>{outageCalls++;return outageCalls===1?{status:503,body:"metadata unavailable"}:allAvailable(ids);}});
    await outage.page.waitForFunction(()=>document.getElementById("notice").textContent.includes("Availability refresh failed"));assert.equal(await outage.page.locator("#player-stage iframe").count(),0);assert.equal(await outage.page.locator('[data-artifact="valid-art"]').isDisabled(),true);
    await outage.page.locator("#refresh").click();await outage.page.waitForFunction(()=>!document.getElementById("refresh").disabled&&!document.querySelector('[data-artifact="valid-art"]').disabled);
    assert.doesNotMatch(await outage.page.locator("#notice").textContent(),/Availability refresh failed/);await outage.page.locator('[data-artifact="valid-art"]').click();assert.equal(await outage.page.locator("#player-stage iframe").count(),1);assert.equal(outage.requests.heads,0);await assertClean(outage.errors);await outage.page.close();console.log("availability outage/recovery PASS");
    let snapshotCalls=0;const snapshotRecovery=await openGallery(browser,base,{data:snapshot([baseRows[0]]),trendText:trend([baseRows[0]]),availability:allAvailable,snapshotHandler:()=>{snapshotCalls++;return snapshotCalls===1?{status:503,body:"snapshot unavailable"}:snapshot([baseRows[0]]);}});
    await snapshotRecovery.page.waitForFunction(()=>document.getElementById("notice").textContent.includes("Snapshot refresh failed"));assert.equal(await snapshotRecovery.page.locator('[data-artifact="valid-art"]').count(),1);await snapshotRecovery.page.locator("#notice button").click();await snapshotRecovery.page.waitForFunction(()=>!document.getElementById('notice').textContent.includes('Snapshot refresh failed'));await assertClean(snapshotRecovery.errors);await snapshotRecovery.page.close();console.log("snapshot outage preserves full archive PASS");
    const historyRows=[...baseRows,{...baseRows[0],id:"history-only"}];let archiveCalls=0;const archive=await openGallery(browser,base,{data:snapshot(baseRows),availability:allAvailable,trendHandler:()=>{archiveCalls++;return archiveCalls===1?trend(historyRows):{status:503,body:"archive unavailable"};}});
    await archive.page.waitForFunction(()=>document.querySelectorAll(".art-card").length===3);await archive.page.locator("#refresh").click();await archive.page.waitForFunction(()=>document.getElementById("notice").textContent.includes("Archive history refresh failed"));assert.equal(await archive.page.locator(".art-card").count(),3);assert.match(await archive.page.locator("#notice").textContent(),/last successful artwork history/);await assertClean(archive.errors);await archive.page.close();console.log("archive outage preserves corpus PASS");
    let emptyCalls=0;const empty=await openGallery(browser,base,{data:snapshot([]),trendText:"\n",availability:ids=>{emptyCalls++;return allAvailable(ids);}});
    assert.match(await empty.page.locator("#gallery-grid").textContent(),/No archive entries/);assert.equal(emptyCalls,0);await assertClean(empty.errors);await empty.page.close();console.log("empty archive PASS");
    const manyRows=Array.from({length:130},(_,index)=>({...baseRows[index%2],id:`batch-${index}`})),batchSizes=[];
    const batched=await openGallery(browser,base,{data:snapshot(manyRows),trendText:trend(manyRows),availability:ids=>{batchSizes.push(ids.length);return allAvailable(ids);}});
    await batched.page.waitForFunction(()=>document.getElementById("gallery-meta").textContent.includes("130 files available"));assert.deepEqual(batchSizes,[64,64,2]);assert.equal(batched.requests.heads,0);await assertClean(batched.errors);await batched.page.close();console.log("availability batch/concurrency PASS");
  }finally{await browser.close();}
  }finally{if(fixture?.child&&!fixture.child.killed)fixture.child.kill("SIGTERM");}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
