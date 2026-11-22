// Google の読み取り connector（B08-03）。Gmail と Calendar の読み取りだけを持ち、書込みは宣言しない。
import type { ConnectorCapability } from '@buddy/domain';
import {
  createGoogleCalendarReader,
  type GoogleCalendarReader,
} from './google-calendar.js';
import {
  createGoogleGmailReader,
  type GoogleGmailReader,
} from './google-gmail.js';
import {
  GoogleHttpClient,
  type GoogleHttpClientOptions,
} from './google-http.js';

export const GOOGLE_READ_CAPABILITY: ConnectorCapability = {
  provider: 'google',
  reads: [
    { kind: 'mail.message', effect_kind: 'Read' },
    { kind: 'calendar.events', effect_kind: 'Read' },
  ],
  writes: [],
};

export interface GoogleReadConnector {
  readonly capability: ConnectorCapability;
  readonly calendar: GoogleCalendarReader;
  readonly gmail: GoogleGmailReader;
}

export function createGoogleReadConnector(
  options: GoogleHttpClientOptions,
): GoogleReadConnector {
  const client = new GoogleHttpClient(options);
  return {
    capability: GOOGLE_READ_CAPABILITY,
    calendar: createGoogleCalendarReader(client),
    gmail: createGoogleGmailReader(client),
  };
}
