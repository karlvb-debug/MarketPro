// ============================================
// TCPA quiet hours — calls/texts only between 8am and 9pm RECIPIENT local time.
//
// Waterfall (architecture plan §Module C):
//   1. Explicit CRM timezone on the contact -> enforce in that zone.
//   2. (HLR/CNAM carrier lookup — future integration, M6.)
//   3. Unknown timezone -> conservative continental-US window: send only
//      when EVERY US zone (ET..PT) is inside 8am-9pm. PT >= 8am means
//      ET >= 11am; ET <= 9pm covers PT <= 6pm. Fail closed, never early/late.
// ============================================

import { DispatchContact } from './types';

export const QUIET_HOURS_START = 8; // inclusive: first allowed local hour
export const QUIET_HOURS_END = 21; // exclusive: 9pm local

/** Local hour (0-23) in an IANA timezone; null if the zone id is invalid. */
export function localHourIn(timezone: string, now: Date): number | null {
  try {
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(now);
    const parsed = parseInt(hour, 10);
    return Number.isNaN(parsed) ? null : parsed % 24;
  } catch {
    return null; // invalid IANA id
  }
}

/**
 * True when sending to this contact is allowed right now under TCPA
 * quiet-hours rules. Unknown/invalid timezones use the conservative
 * all-continental-US window.
 */
export function isWithinSendWindow(contact: Pick<DispatchContact, 'timezone'>, now: Date): boolean {
  if (contact.timezone) {
    const hour = localHourIn(contact.timezone, now);
    if (hour !== null) {
      return hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END;
    }
    // invalid timezone string — fall through to conservative window
  }

  const easternHour = localHourIn('America/New_York', now);
  const pacificHour = localHourIn('America/Los_Angeles', now);
  if (easternHour === null || pacificHour === null) return false; // fail closed

  return (
    pacificHour >= QUIET_HOURS_START &&
    easternHour < QUIET_HOURS_END
  );
}
