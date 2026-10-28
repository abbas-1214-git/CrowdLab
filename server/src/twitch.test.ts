import { describe, expect, it } from 'vitest';
import { EventMessageDeduplicator, isTargetChatEvent } from './twitch.js';

describe('Twitch EventSub message safeguards', () => {
  it('accepts only complete chat messages for the configured broadcaster', () => {
    const event = { broadcaster_user_id: '42', broadcaster_user_login: 'crowdlab', chatter_user_id: '7', chatter_user_name: 'Viewer', message: { text: '!predict 85' } };
    expect(isTargetChatEvent(event, '42', 'crowdlab')).toBe(true);
    expect(isTargetChatEvent({ ...event, broadcaster_user_id: '99' }, '42', 'crowdlab')).toBe(false);
    expect(isTargetChatEvent({ ...event, broadcaster_user_login: 'other' }, '42', 'crowdlab')).toBe(false);
    expect(isTargetChatEvent({ ...event, message: {} }, '42', 'crowdlab')).toBe(false);
  });

  it('drops duplicate message IDs and bounds its in-memory history', () => {
    const seen = new EventMessageDeduplicator(2);
    expect(seen.hasSeen('message-1')).toBe(false);
    expect(seen.hasSeen('message-1')).toBe(true);
    seen.hasSeen('message-2');
    seen.hasSeen('message-3');
    expect(seen.hasSeen('message-1')).toBe(false);
  });
});
