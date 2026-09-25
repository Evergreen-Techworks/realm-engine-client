import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodeCapture,captureRecord} from '../../bridge/DllCaptureBus.js';
import {BufferedJsonlWriter} from '../recorderWriter.js';
it('writes native wire through actual recorder writer with packet-reader k/t and explicit limits',()=>{
 const dir=mkdtempSync(join(tmpdir(),'capture-contract-'));const path=join(dir,'packets-test.jsonl');
 const wire={type:'encounterCapture',version:1,kind:'native_present_interarrival',processId:1,processStartUtcMs:2,anchorMs:3,anchorUtcMs:4,sceneQueueHighWater:0,decisionQueueHighWater:0,terminalQueueHighWater:0,frameQueueHighWater:0,anchorUncertaintyMs:16,memoryBytes:3500000,qpcFrequency:1000,dropped:0,frames:[[1,1,2,3,100]],token:'must-not-persist'};
 const writer=new BufferedJsonlWriter(path);
 try {const record=decodeCapture(wire)!;writer.writeLine(captureRecord(record,1000));writer.flushSync();
 const text=readFileSync(path,'utf8');const result=JSON.parse(text);expect(result.k).toBe('native_present_interarrival');expect(result.t).toBe(1000);expect(result.clockUncertaintyMs).toBe(16);expect(result.calibrationProvenance).toBeNull();expect(text).not.toContain('must-not-persist');
 }finally{writer.close();rmSync(dir,{recursive:true,force:true});}
});
