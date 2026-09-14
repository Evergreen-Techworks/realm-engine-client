import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Combat } from '@realmengine/sdk';
import { BridgeCombat } from '../Combat.js';
import type { BridgeDeps } from '../../BridgeDeps.js';
import { sendDllFeature, setDllFeatureSender } from '../../../../bridge/DllFeatureBus.js';

// Auto Aim drops a lock on a structure while its wall filters are on (TargetSelector.cpp,
// Locked branch). A structure lock lifts them; the plugin's own values come back after.
let sent: Array<[string, unknown]>;
const filters = () => sent.filter(([k]) => k === 'autoAimIgnoreWalls' || k === 'autoAimIgnoreScenery');

beforeEach(() => {
  sent = [];
  // A fresh process: no plugin has sent anything yet (the bus lives on globalThis).
  delete (globalThis as Record<string, unknown>).__LFG_dllFeatureBus_v1;
  setDllFeatureSender((key, value) => { sent.push([key, value]); });
  BridgeCombat.install({ clientRef: { current: undefined }, proxy: { hookPacket: () => {} } } as unknown as BridgeDeps);
});
afterEach(() => setDllFeatureSender(null));

describe('Combat.aimAt structure locks', () => {
  it('leaves Auto Aim\'s filters alone for an ordinary lock', () => {
    sendDllFeature('autoAimIgnoreScenery', true); sent = [];
    Combat.aimAt(12);
    Combat.stopAiming();
    expect(sent).toEqual([['scriptCombatTargetId', 12], ['scriptCombatTargetId', 0]]);
  });

  it('lifts both filters before the lock and restores the plugin\'s values when aiming stops', () => {
    sendDllFeature('autoAimIgnoreWalls', false);     // the user's choice in the Auto Aim plugin
    sendDllFeature('autoAimIgnoreScenery', true);
    sent = [];
    Combat.aimAt(40, { includeStructures: true });
    expect(sent).toEqual([['autoAimIgnoreScenery', false], ['scriptCombatTargetId', 40]]);   // walls already off
    sent = [];
    Combat.stopAiming();
    expect(sent).toEqual([['scriptCombatTargetId', 0], ['autoAimIgnoreScenery', true]]);
  });

  it('restores on a switch to an ordinary target and on autoAimOff', () => {
    sendDllFeature('autoAimIgnoreWalls', true); sendDllFeature('autoAimIgnoreScenery', true);
    Combat.aimAt(40, { includeStructures: true });
    sent = [];
    Combat.aimAt(41);
    expect(sent).toEqual([['autoAimIgnoreWalls', true], ['autoAimIgnoreScenery', true], ['scriptCombatTargetId', 41]]);
    Combat.aimAt(40, { includeStructures: true });
    sent = [];
    Combat.autoAimOff();
    expect(filters()).toEqual([['autoAimIgnoreWalls', true], ['autoAimIgnoreScenery', true]]);
  });

  it('restores the DLL default when the plugin never sent a value', () => {
    Combat.aimAt(40, { includeStructures: true });
    sent = [];
    Combat.stopAiming();
    expect(filters()).toEqual([['autoAimIgnoreWalls', true], ['autoAimIgnoreScenery', true]]);
  });

  it('lets the plugin win a change made during the lift, and re-lifts on the next structure lock', () => {
    sendDllFeature('autoAimIgnoreWalls', true); sendDllFeature('autoAimIgnoreScenery', true);
    Combat.aimAt(40, { includeStructures: true });
    sendDllFeature('autoAimIgnoreScenery', true);     // the user toggles the setting mid-lift
    sent = [];
    Combat.aimAt(40, { includeStructures: true });
    expect(filters()).toEqual([['autoAimIgnoreScenery', false]]);
    sent = [];
    Combat.stopAiming();
    expect(filters()).toEqual([['autoAimIgnoreWalls', true], ['autoAimIgnoreScenery', true]]);
    sent = [];
    Combat.stopAiming();                               // nothing lifted: nothing to restore
    expect(filters()).toEqual([]);
  });
});
