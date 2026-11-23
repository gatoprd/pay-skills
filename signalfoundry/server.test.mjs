import test from "node:test";
import assert from "node:assert/strict";
import { mergeReleases, normalizeRelease, runCycle } from "./server.mjs";
const future = new Date(Date.now() + 86400000 * 12).toISOString();
const past = new Date(Date.now() - 86400000 * 2).toISOString();
function sample(id,deadline=future) {
 return { ocid:"ocds-r3r7e7-"+id, date:new Date().toISOString(), buyer:{name:"Δήμος Δοκιμής"},
  tender:{ id, title:"Προμήθεια υπηρεσιών εξοπλισμού πληροφορικής",status:"active",
    tenderPeriod:{endDate:deadline},value:{amount:15400,currency:"EUR"},
    items:[{classification:{id:"72000000",scheme:"CPV"}}], documents:[{url:"https://official.example/doc.pdf"}] } };
}
test("valid release normalizes as source-grounded opportunity",()=>{
 const o=normalizeRelease(sample("1"));assert.equal(o.amount,15400);
 assert.equal(o.category,"digital");assert.ok(o.deadline);assert.equal(o.official.length,1);assert.equal(o.daysLeft>0,true);
});
test("expired or unproven deadlines cannot create active opportunities",()=>{
 assert.equal(normalizeRelease(sample("2",past)),null);
 const unknown=sample("3");delete unknown.tender.tenderPeriod;
 assert.equal(normalizeRelease(unknown),null);
});
test("deduplicates across source days",()=>{
 const a=sample("1");const b={...sample("1"),date:new Date(Date.now()+1000).toISOString()};
 assert.equal(mergeReleases([a,b]).length,1);
});
test("never interprets guessed budgets and invalid docs as verified",()=>{
 const s=sample("8");delete s.tender.value;s.tender.documents=[{url:"javascript:alert(1)"}];
 const o=normalizeRelease(s);assert.equal(o.amount,null);assert.equal(o.official.length,0);
});
test("agent cycle processes real-shaped releases and records source coverage",async()=>{
 const run=await runCycle(async()=>({releases:[sample("4"),sample("5",past)],links:{next:null}}));
 assert.equal(run.status,"ready");assert.equal(run.items.length,1);assert.equal(run.lastSources.length,7);
});
test("source outages don't create fake opportunities",async()=>{
 const run=await runCycle(async()=>{throw Error("service unavailable")});
 assert.equal(run.status,"source_unavailable");assert.ok(run.errors.length>=1);
});


test("award-only records must never be shown as live invitations",()=>{
 const r=sample("award");r.tag=["award"];assert.equal(normalizeRelease(r),null);
});
test("pagination follows only sourced same-day urls and deduplicates",async()=>{
 let calls=0;
 const state=await runCycle(async url=>{
  calls++;
  if(url.includes("cursor=next"))return {releases:[sample("one")],links:{}};
  return {releases:[sample("one")],links:{next:url+"?cursor=next"}};
 });
 assert.equal(calls,14);
 assert.equal(state.items.length,1);
 assert.equal(state.lastSources.length,14);
 assert.equal(state.partialCount,0);
});
test("untrusted pagination hosts are rejected before network fetch",async()=>{
 let calls=0;
 const state=await runCycle(async url=>{
  calls++;
  return {releases:[sample("safe")],links:{next:"https://attacker.invalid/ocds/releases/2026-11-23?cursor=steal"}};
 });
 assert.equal(calls,7);
 assert.equal(state.status,"partial");
 assert.equal(state.partialCount,7);
 assert.equal(state.items.length,1);
});
test("pagination is capped even when every page contains a next link",async()=>{
 let calls=0;
 const state=await runCycle(async url=>{
  calls++;
  const page=Number(new URL(url).searchParams.get("cursor")||0);
  const link=new URL(url);link.searchParams.set("cursor",String(page+1));
  return {releases:[sample("item-"+page)],links:{next:link.toString()}};
 });
 assert.equal(calls,21);
 assert.equal(state.partialCount,7);
 assert.equal(state.items.length,3);
});
