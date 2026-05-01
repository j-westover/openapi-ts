/**
 * Parse a Redfish SSE event payload.
 *
 * Redfish events arrive either as a single record:
 *
 *   { "@odata.type": "#Event.v1_x_x.Event", "MessageId": "...", ... }
 *
 * or as a Redfish Event envelope wrapping multiple records:
 *
 *   { "@odata.type": "#Event.v1_x_x.Event", "Events": [{...}, {...}] }
 *
 * `EventBufferExceeded` is a sentinel published by the BMC when the server-
 * side queue overflows; the caller should typically refetch state after
 * seeing it.
 */

export interface EventRecord {
  [key: string]: unknown;
  EventType?: string;
  Message?: string;
  MessageId?: string;
  OriginOfCondition?: { '@odata.id'?: string };
  Severity?: string;
  Timestamp?: string;
}

export interface ParseResult {
  error?: string;
  events: EventRecord[];
  hasBufferExceeded: boolean;
}

const BUFFER_EXCEEDED_MARKER = 'EventBufferExceeded';

export function parseSSEEventData(rawData: unknown): ParseResult {
  const result: ParseResult = { events: [], hasBufferExceeded: false };

  if (rawData == null) return result;

  // The generated SSE client already JSON-parses the `data:` payload, but
  // when it hits non-JSON it falls back to the raw string. Handle both.
  let parsed: unknown = rawData;
  if (typeof rawData === 'string') {
    if (rawData.trim() === '') return result;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      result.error = `Failed to parse SSE data: ${rawData.slice(0, 100)}`;
      return result;
    }
  }

  if (!parsed || typeof parsed !== 'object') return result;

  const envelope = parsed as { Events?: EventRecord[]; MessageId?: string };

  if (Array.isArray(envelope.Events)) {
    result.events = envelope.Events;
  } else if (envelope.MessageId) {
    result.events = [parsed as EventRecord];
  }

  result.hasBufferExceeded = result.events.some((event) =>
    event.MessageId?.includes(BUFFER_EXCEEDED_MARKER),
  );

  return result;
}
