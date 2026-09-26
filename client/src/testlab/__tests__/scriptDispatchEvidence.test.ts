import {it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
vi.mock('../../scripts/bridge/index.js',()=>({SDKBridge:{install:vi.fn()}}));
import {ScriptHost} from '../../scripts/ScriptHost.js';
it('actual onStart dispatch emits entry hash before execution without replacing dashboard log sink',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dispatch-evidence-'));mkdirSync(join(dir,'probe'));
 const code='export default class {onStart(){globalThis.__dispatch_test_order.push("onStart")} onLoop(){return 10000} onStop(){}}';
 writeFileSync(join(dir,'probe','index.mjs'),code);writeFileSync(join(dir,'probe','realmengine.script.json'),JSON.stringify({name:'Probe',developer:'Test',version:'1',entry:'index.mjs'}));
 const host=new ScriptHost({scriptId:undefined});(host as any).scriptsDir=dir;
 const events:any[]=[];(globalThis as any).__dispatch_test_order=[];
 (globalThis as any).__realmengine_scriptEvidence_v1=(e:any)=>{events.push(e);(globalThis as any).__dispatch_test_order.push('evidence');};
 const dashboard=vi.fn();host.onLog(dashboard);
 try{expect(await host.start('probe')).toEqual({ok:true});expect(events).toEqual([{kind:'dispatch',script_id:'probe',entry_sha256:createHash('sha256').update(code).digest('hex')}]);expect((globalThis as any).__dispatch_test_order).toEqual(['evidence','onStart']);expect(dashboard).toHaveBeenCalled();}
 finally{host.stop('probe');delete (globalThis as any).__realmengine_scriptEvidence_v1;delete (globalThis as any).__dispatch_test_order;rmSync(dir,{recursive:true,force:true});}
});
it('fans SDK structured log out to the private sink and preserves dashboard delivery when observer throws',()=>{
 const host=new ScriptHost({scriptId:undefined});const dashboard=vi.fn();const deps:any={scriptSession:{scriptId:'probe'},emitScriptLog:dashboard};host.installBridge(deps);
 const sink=vi.fn(()=>{throw new Error('observer unavailable');});(globalThis as any).__realmengine_scriptEvidence_v1=sink;
 try{expect(()=>deps.emitScriptLog('probe','[probe] CAPTURE_PROBE {"event":"measurement_start"}','info')).not.toThrow();expect(sink).toHaveBeenCalledWith({kind:'log',script_id:'probe',line:'[probe] CAPTURE_PROBE {"event":"measurement_start"}'});expect(dashboard).toHaveBeenCalledOnce();}
 finally{delete (globalThis as any).__realmengine_scriptEvidence_v1;}
});
