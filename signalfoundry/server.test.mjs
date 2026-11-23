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
 assert.equal(run.status,"ready");assert.equal(run.items.length,1);assert.equal(run.lastSources.length,5);
});
test("source outages don't create fake opportunities",async()=>{
 const run=await runCycle(async()=>{throw Error("service unavailable")});
 assert.equal(run.status,"source_unavailable");assert.ok(run.errors.length>=1);
});
