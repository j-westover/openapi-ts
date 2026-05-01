/**
 * Unit tests for `parseSSEEventData`.
 *
 * Covers the table of input shapes that real BMCs emit:
 *   - the DMTF envelope (`{ Events: [...] }`),
 *   - flat single-record events (some vendors do this),
 *   - the `EventBufferExceeded` sentinel,
 *   - malformed JSON,
 *   - the two `OriginOfCondition` variants (object with `@odata.id`
 *     vs. flat URI string).
 */

import { describe, expect, it } from 'vitest';

import { parseSSEEventData } from '@/composables/parseSSEEvent';

describe('parseSSEEventData', () => {
  describe('input handling', () => {
    it('returns an empty result for nullish input', () => {
      expect(parseSSEEventData(null)).toEqual({ events: [], hasBufferExceeded: false });
      expect(parseSSEEventData(undefined)).toEqual({ events: [], hasBufferExceeded: false });
    });

    it('returns an empty result for an empty / whitespace-only string', () => {
      expect(parseSSEEventData('')).toEqual({ events: [], hasBufferExceeded: false });
      expect(parseSSEEventData('   ')).toEqual({ events: [], hasBufferExceeded: false });
    });

    it('parses a JSON string and a pre-parsed object identically', () => {
      const obj = {
        '@odata.type': '#Event.v1_9_0.Event',
        Events: [{ MessageId: 'ResourceEvent.1.0.ResourceChanged' }],
      };
      const fromString = parseSSEEventData(JSON.stringify(obj));
      const fromObject = parseSSEEventData(obj);
      expect(fromString.events).toEqual(fromObject.events);
      expect(fromString.hasBufferExceeded).toBe(fromObject.hasBufferExceeded);
    });

    it('flags malformed JSON as an error and yields no events', () => {
      const result = parseSSEEventData('not json {');
      expect(result.events).toEqual([]);
      expect(result.error).toMatch(/Failed to parse SSE data/);
    });

    it('returns an empty result for primitives / non-objects', () => {
      expect(parseSSEEventData(42)).toEqual({ events: [], hasBufferExceeded: false });
      expect(parseSSEEventData(true)).toEqual({ events: [], hasBufferExceeded: false });
      expect(parseSSEEventData('"plain string"')).toEqual({ events: [], hasBufferExceeded: false });
    });
  });

  describe('envelope vs flat record', () => {
    it('extracts `Events[]` from the DMTF envelope shape', () => {
      const result = parseSSEEventData({
        '@odata.type': '#Event.v1_9_0.Event',
        Events: [
          { MessageId: 'ResourceEvent.1.0.ResourceChanged' },
          { MessageId: 'TaskEvent.1.0.TaskStarted' },
        ],
      });
      expect(result.events).toHaveLength(2);
      expect(result.events[0]?.MessageId).toBe('ResourceEvent.1.0.ResourceChanged');
      expect(result.events[1]?.MessageId).toBe('TaskEvent.1.0.TaskStarted');
    });

    it('treats a top-level record with a `MessageId` as a single-event payload', () => {
      const result = parseSSEEventData({
        '@odata.type': '#Event.v1_9_0.Event',
        MessageId: 'ResourceEvent.1.0.ResourceChanged',
      });
      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.MessageId).toBe('ResourceEvent.1.0.ResourceChanged');
    });

    it('does not synthesise events when neither `Events[]` nor a top-level `MessageId` is present', () => {
      const result = parseSSEEventData({ '@odata.type': '#Event.v1_9_0.Event' });
      expect(result.events).toEqual([]);
      expect(result.hasBufferExceeded).toBe(false);
    });
  });

  describe('EventBufferExceeded sentinel', () => {
    it('flags `hasBufferExceeded` when any event has a `EventBufferExceeded` MessageId', () => {
      const result = parseSSEEventData({
        Events: [
          { MessageId: 'ResourceEvent.1.0.ResourceChanged' },
          { MessageId: 'ResourceEvent.1.0.EventBufferExceeded' },
        ],
      });
      expect(result.hasBufferExceeded).toBe(true);
      expect(result.events).toHaveLength(2);
    });

    it('matches `EventBufferExceeded` as a substring of `MessageId`', () => {
      const result = parseSSEEventData({
        Events: [{ MessageId: 'OEM.Vendor.1.0.EventBufferExceededDetailed' }],
      });
      expect(result.hasBufferExceeded).toBe(true);
    });

    it('keeps `hasBufferExceeded` false when no event matches', () => {
      const result = parseSSEEventData({
        Events: [{ MessageId: 'ResourceEvent.1.0.ResourceChanged' }],
      });
      expect(result.hasBufferExceeded).toBe(false);
    });
  });

  describe('OriginOfCondition variants', () => {
    it('preserves the DMTF object shape', () => {
      const result = parseSSEEventData({
        Events: [
          {
            MessageId: 'ResourceEvent.1.0.ResourceChanged',
            OriginOfCondition: { '@odata.id': '/redfish/v1/Systems/system0' },
          },
        ],
      });
      expect(result.events[0]?.OriginOfCondition).toEqual({
        '@odata.id': '/redfish/v1/Systems/system0',
      });
    });

    it('preserves the flat-string vendor variant', () => {
      const result = parseSSEEventData({
        Events: [
          {
            MessageId: 'ResourceEvent.1.0.ResourceChanged',
            OriginOfCondition: '/redfish/v1/Systems/system0',
          },
        ],
      });
      expect(result.events[0]?.OriginOfCondition).toBe('/redfish/v1/Systems/system0');
    });
  });
});
