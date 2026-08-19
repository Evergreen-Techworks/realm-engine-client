import type { CapturedPacket } from './PacketInspector.js';
import { normalizeSlotCount, toBoolArray, extractTradeItemIncluded } from '../../util/tradeSlots.js';

/**
 * Mutable trade-session state machine. Tracks the current trade offer/counter
 * offer between the local player and a partner. Extracted from DevServer.
 *
 * The `state` property is the live state object — DevServer reads it directly
 * from `sendLabPacket` for ACCEPTTRADE/CHANGETRADE packet construction.
 */
export interface TradeState {
  active: boolean;
  ourSlotCount: number;
  partnerSlotCount: number;
  ourOffer: boolean[];
  partnerOffer: boolean[];
  partnerOfferFromTradeChanged: boolean[];
  partnerName: string;
}

export class TradeSession {
  readonly state: TradeState = {
    active: false,
    ourSlotCount: 12,
    partnerSlotCount: 12,
    ourOffer: [],
    partnerOffer: [],
    partnerOfferFromTradeChanged: [],
    partnerName: '',
  };

  reset(): void {
    this.state.active = false;
    this.state.ourSlotCount = 12;
    this.state.partnerSlotCount = 12;
    this.state.ourOffer = [];
    this.state.partnerOffer = [];
    this.state.partnerOfferFromTradeChanged = [];
    this.state.partnerName = '';
  }

  observePacket(pkt: CapturedPacket): void {
    const name = String(pkt.name ?? '').toUpperCase();
    const direction = String(pkt.direction ?? '');
    const fromServer = direction.startsWith('S');
    const fromClient = direction.startsWith('C');
    const data = (pkt.data && typeof pkt.data === 'object') ? pkt.data : {};

    if (name === 'TRADESTART' && fromServer) {
      const clientItems = Array.isArray(data.clientItems) ? data.clientItems : [];
      const partnerItems = Array.isArray(data.partnerItems) ? data.partnerItems : [];
      this.state.active = true;
      this.state.ourSlotCount = normalizeSlotCount(clientItems.length, this.state.ourSlotCount);
      this.state.partnerSlotCount = normalizeSlotCount(partnerItems.length, this.state.partnerSlotCount);
      this.state.ourOffer = toBoolArray(
        extractTradeItemIncluded(clientItems),
        this.state.ourSlotCount,
      );
      this.state.partnerOffer = toBoolArray(
        extractTradeItemIncluded(partnerItems),
        this.state.partnerSlotCount,
      );
      this.state.partnerOfferFromTradeChanged = this.state.partnerOffer.slice();
      this.state.partnerName = typeof data.partnerName === 'string' ? data.partnerName : '';
      return;
    }

    if (name === 'TRADECHANGED' && fromServer) {
      this.state.active = true;
      const next = toBoolArray(data.offer, this.state.partnerSlotCount);
      this.state.partnerOffer = next;
      this.state.partnerOfferFromTradeChanged = next.slice();
      return;
    }

    if (name === 'CHANGETRADE' && fromClient) {
      this.state.active = true;
      this.state.ourOffer = toBoolArray(data.offer, this.state.ourSlotCount);
      return;
    }

    if (name === 'TRADEACCEPTED' && fromServer) {
      this.state.active = true;
      this.state.ourOffer = toBoolArray(data.clientOffer, this.state.ourSlotCount);
      this.state.partnerOffer = toBoolArray(data.partnerOffer, this.state.partnerSlotCount);
      // partnerOfferFromTradeChanged unchanged — ACCEPTTRADE must echo last TRADECHANGED
      return;
    }

    if ((name === 'TRADEDONE' && fromServer) || (name === 'CANCELTRADE' && fromClient)) {
      this.reset();
    }
  }
}
