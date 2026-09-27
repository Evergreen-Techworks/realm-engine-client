import { readFileSync } from 'node:fs';
import { describe,it,expect } from 'vitest';
import { decodeCapture,publishCapture,subscribeCapture } from '../DllCaptureBus.js';
const decision = Object.fromEntries(['ms','sequence','generation','trigger','tick','hp','maxHp','lockId','mode','solve','x','y','goalX','goalY','targetX','targetY','speed','range','clearance','standClearance','lockX','lockY','rawGoalX','rawGoalY','move','fromLock','lockApproach','driveAccepted','dropped','suppressed'].map(k=>[k,0]));
const base = () => ({type:'encounterCapture',version:1,kind:'native_scene',processId:2,processStartUtcMs:1,anchorMs:1,anchorUtcMs:1,sceneQueueHighWater:0,decisionQueueHighWater:0,terminalQueueHighWater:0,frameQueueHighWater:0,anchorUncertaintyMs:16,memoryBytes:3322488,decision:{...decision},candidateTick:0,terrainTick:0,flags:0,enemiesObserved:0,enemyEntriesVisited:0,projectilesObserved:0,zonesObserved:0,candidatesObserved:0,enemies:[],projectiles:[],zones:[],candidates:[],cells:Array(289).fill(255),cellX:0,cellY:0,cellStep:.5});
describe('bounded native capture contract',()=>{
 it('accepts native-generated wire when supplied by host contract runner',()=>{if(process.env.CAPTURE_WIRE_FIXTURE)expect(decodeCapture(JSON.parse(readFileSync(process.env.CAPTURE_WIRE_FIXTURE,'utf8')))).not.toBeNull();});
 it('validates full-rate renderer batches without inventing frame deltas',()=>{const v={...base(),kind:'native_present_interarrival',qpcFrequency:10000000,dropped:0,frames:[[1,1,10,100,1000000],[2,1,10,117,1170000]]};expect(decodeCapture(v)).not.toBeNull();expect(decodeCapture({...v,frames:Array(129).fill(v.frames[0])})).toBeNull();expect(decodeCapture({...v,qpcFrequency:0})).toBeNull();});

 it('accepts empty observed scene with unknown terrain',()=>expect(decodeCapture(base())).not.toBeNull());
 it('strips unallowlisted secrets at every object layer',()=>{const v=base();Object.assign(v,{token:'secret'});Object.assign(v.decision,{secret:'hidden'});expect(JSON.stringify(decodeCapture(v))).not.toMatch(/secret|hidden|token/);});
 it('rejects nonfinite input',()=>{const v=base();v.decision.x=NaN;expect(decodeCapture(v)).toBeNull();});
 it('rejects oversized arrays and storage',()=>{expect(decodeCapture({...base(),enemies:Array(65).fill(Array(9).fill(0))})).toBeNull();expect(decodeCapture({...base(),memoryBytes:4194305})).toBeNull();});
 it('rejects malformed trajectory and missing fields',()=>{expect(decodeCapture({...base(),projectiles:[[0,0,0,0,0,0,0,1,[[0,0]]]]})).toBeNull();expect(decodeCapture({...base(),decision:{}})).toBeNull();});
 it('does not permit dropped arrays to imply smaller observed totals',()=>expect(decodeCapture({...base(),enemies:[Array(9).fill(0)]})).toBeNull());
 it('copies input arrays and preserves explicit unknown scalars',()=>{const v=base();const result=decodeCapture(v)!;v.cells[0]=0;expect((result.cells as number[])[0]).toBe(255);expect(decodeCapture({...v,decision:{...v.decision,clearance:null}})?.decision?.clearance).toBeNull();});
 it('bounds listener lifetime and isolates errors',()=>{let count=0;const off1=subscribeCapture(()=>{throw Error('ignored');});const off2=subscribeCapture(()=>count++);publishCapture(decodeCapture(base())!);off1();off2();publishCapture(decodeCapture(base())!);expect(count).toBe(1);});
});

// AUTONEXUS-SCAN-DIAG begin — private scan diagnostic record (strip with DllCaptureBus.ts's tagged block).
describe('AutoNexus scan diagnostic record',()=>{
 const scan=()=>JSON.parse('{"type":"encounterCapture","version":1,"kind":"native_autonexus_scan","processId":3,"processStartUtcMs":11,"anchorMs":1000,"anchorUtcMs":1790000000000,"sceneQueueHighWater":0,"decisionQueueHighWater":0,"terminalQueueHighWater":0,"frameQueueHighWater":0,"updateQueueHighWater":0,"anchorUncertaintyMs":16,"memoryBytes":4153728,"scanQueueHighWater":0,"channelBytes":31520,"dropped":2,"scan":{"ms":1000,"sequence":7,"hp":-1,"maxHp":-1,"defense":0,"totalApplied":0,"branch":1,"x":0,"y":0,"vx":0,"vy":0,"targetValid":1,"targetX":0,"targetY":0,"targetDist":0.119999997,"horizonMs":0,"hitPad":0,"threatsObserved":40,"threatCount":2},"threats":[[0,0,0,0,0,0,0,0,0,-1,-1,-1,-1,-1],[0,1,0,0,0,0,0,0,0,-1,-1,-1,-1,-1]]}');
 it('accepts native-generated scan wire when supplied by the host runner',()=>{if(process.env.SCAN_WIRE_FIXTURE)expect(decodeCapture(JSON.parse(readFileSync(process.env.SCAN_WIRE_FIXTURE,'utf8')))).not.toBeNull();});
 it('accepts the scan record shape',()=>{const r=decodeCapture(scan());expect(r).not.toBeNull();expect(r!.kind).toBe('native_autonexus_scan');expect((r!.threats as unknown[]).length).toBe(2);expect((r!.scan as Record<string,unknown>).branch).toBe(1);});
 it('strips unallowlisted keys from the scan',()=>{const v=scan();v.token='secret';v.scan.secret='hidden';expect(JSON.stringify(decodeCapture(v))).not.toMatch(/secret|hidden|token/);});
 it('rejects more than sixteen threat rows or a wrong row width',()=>{const v=scan();v.threats=Array(17).fill(v.threats[0]);expect(decodeCapture(v)).toBeNull();const w=scan();w.threats=[w.threats[0].slice(0,13)];expect(decodeCapture(w)).toBeNull();});
 it('rejects missing scan fields and nonfinite geometry',()=>{const v=scan();delete v.scan.branch;expect(decodeCapture(v)).toBeNull();const w=scan();w.scan.x=Infinity;expect(decodeCapture(w)).toBeNull();});
 it('rejects more rows than the scan says it holds',()=>{const v=scan();v.scan.threatCount=1;expect(decodeCapture(v)).toBeNull();});
});
// AUTONEXUS-SCAN-DIAG end
