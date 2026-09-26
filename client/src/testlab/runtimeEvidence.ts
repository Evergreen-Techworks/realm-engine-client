/** TESTLAB_PRIVATE_ONLY: conservative stream evidence, never network delivery proof. */
export const SCRIPT_EVIDENCE_SLOT = '__realmengine_scriptEvidence_v1';
export function scriptEvidenceRecord(raw: unknown, t: number): Record<string, unknown> | null {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r !== 'object' || typeof r.script_id !== 'string' || !/^[\w-]{1,80}$/.test(r.script_id)) return null;
  if (r.kind === 'dispatch' && typeof r.entry_sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.entry_sha256))
    return {k:'script_dispatch',t,script_id:r.script_id,entry_sha256:r.entry_sha256,event_id:`${process.pid}:${t}:${r.script_id}`,process_id:process.pid,hash_scope:'entry_module',import_stable:true,transitive_imports_verified:false};
  if (r.kind !== 'log' || typeof r.line !== 'string' || r.line.length > 16384) return null;
  const match = r.line.match(/(?:^|\] )(ACCESSIBLE_BOSS_DISCOVERY|CONTINUOUS_COMBAT_DISCOVERY|COMBAT_CONTINUOUS|FARMER_COMBAT_OBSERVER|CAPTURE_PROBE|CONDITION_WITNESS)\s+(\{.*\})$/);
  if (!match) return null;
  let data: unknown; try {data=JSON.parse(match[2]);} catch {return null;}
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const payload: Record<string,unknown> = {};
  // Exact, bounded fields only; arbitrary labels/log text/credentials never persist.
  const numberKeys = ['at','t','startedAt','endedAt','bossId','bossType','bossOrdinal','initialObjectType','objectId','objectType','x','y','hp','maxHp','level','speed','distance','goalDistance','bossDistance','durationMs','lockId','nativeSequence','nativeGeneration','nativeProcessId','targetId','start_ms','end_ms','scheduledIndex'];
  const tokenKeys = ['event','phase','arm','attemptId','condition','eventId','reason','result','runId'];
  for (const key of numberKeys) {const v=(data as any)[key];if(typeof v==='number'&&Number.isFinite(v))payload[key]=v;}
  for (const key of tokenKeys) {const v=(data as any)[key];if(typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,96}$/.test(v))payload[key]=v;}
  for (const key of ['subjectModuleSha256','harnessSha256']) {const v=(data as any)[key];if(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))payload[key]=v;}
  // Existing observer schema: retain measured positions and identities, never names/text.
  const numeric = (v: unknown) => typeof v==='number'&&Number.isFinite(v)?v:null;
  const point = (v: any) => v&&typeof v==='object'?{x:numeric(v.x),y:numeric(v.y)}:null;
  const identity = (v: any): any => v&&typeof v==='object'?{objectId:numeric(v.objectId),objectType:numeric(v.objectType)}:null;
  const entity = (v: any): any => v&&typeof v==='object'?{...identity(v),position:point(v.position),hp:numeric(v.hp),maxHp:numeric(v.maxHp),isTargetable:typeof v.isTargetable==='boolean'?v.isTargetable:null}:null;
  const d=data as any;
  if(match[1]==='FARMER_COMBAT_OBSERVER') {
    payload.kind=['observation','observation_unavailable'].includes(d.kind)?d.kind:null;
    payload.seq=numeric(d.seq);
    if(d.player&&typeof d.player==='object')payload.player={position:point(d.player.position),hp:numeric(d.player.hp),level:numeric(d.player.level),equipment:Array.isArray(d.player.equipment)?d.player.equipment.slice(0,4).map(numeric):null};
    if(d.selected&&typeof d.selected==='object')payload.selected={...identity(d.selected),source:['bossEncounter','eventGoal','questGoal'].includes(d.selected.source)?d.selected.source:null,rememberedPosition:point(d.selected.rememberedPosition),observed:entity(d.selected.observed)};
    payload.serverQuest=identity(d.serverQuest);
    payload.nearbyEnemies=Array.isArray(d.nearbyEnemies)?d.nearbyEnemies.slice(0,32).map(entity):null;
    payload.nearbyObservedCount=numeric(d.nearbyObservedCount);
    payload.nearbyTruncated=typeof d.nearbyTruncated==='boolean'?d.nearbyTruncated:null;
    payload.sampleAgeMs=null; // SDK observer has no individual source timestamps
  }
  if (!Object.keys(payload).length) return null;
  return {k:'script_observation',t,script_id:r.script_id,marker:match[1],payload,process_id:process.pid,trust:'script_report_requires_independent_join'};
}

export class DamageCoverage {
  private connection: object | null = null;
  private connectionOrdinal=0;
  private mapOrdinal=0;
  private start: number | null=null;
  private end: number | null=null;
  private errors=0;
  get mapId(): string {return `proxy:${process.pid}:${this.connectionOrdinal}:${this.mapOrdinal}`;}
  reset(): void {this.start=null;this.end=null;}
  disconnect(client: object): void {if(client===this.connection){this.reset();this.connection=null;}}
  packet(client: object,t:number,name:string,valid:boolean,selfReady:boolean,errors:number): void {
    if (client!==this.connection) {this.reset();this.connection=client;this.connectionOrdinal++;this.mapOrdinal=0;}
    if (name==='MAPINFO') {this.reset();this.mapOrdinal=valid?this.mapOrdinal+1:0;}
    if (errors!==this.errors || !valid || !selfReady || !this.mapOrdinal || (this.end!==null&&(t<this.end||t-this.end>2000))) this.reset();
    this.errors=errors;
    if (!valid || !selfReady || !this.mapOrdinal) return;
    if(this.start===null)this.start=t;
    this.end=t;
  }
  /** Caller flushes packet rows first; only successfully persisted intervals qualify. */
  flushed(t:number,errors:number): Record<string,unknown>|null {
    if(errors!==this.errors){this.errors=errors;this.reset();return null;}
    if(this.start===null||this.end===null||this.end<=this.start)return null;
    const record={k:'capture_span',t,stream:'packet_damage',start_ms:this.start,end_ms:this.end,map_instance_id:this.mapId,process_id:process.pid,source:'parsed_proxy_server_packets',parser_scope:'DAMAGE',max_packet_gap_ms:2000,writer_errors:0};
    this.start=this.end;return record;
  }
}
