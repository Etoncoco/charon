import { describe, expect, it } from 'vitest';
import {
  allowRulesOf, offeredSuggestions, parseSuggestions, ruleString,
} from '@/lib/permissionSuggestions';

describe('Claude CLI permission suggestions', () => {
  const wire = [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'allow' },
    'garbage',
    { type: 'addDirectories', directories: ['/srv/data'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: null }], behavior: 'allow', destination: 'userSettings' },
  ];

  it('offers a button per actionable option and keeps the agent\'s indices', () => {
    expect(offeredSuggestions(wire)).toEqual([
      { index: 0, label: 'always allow Bash(npm test:*) — this project' },
      { index: 3, label: 'allow access to /srv/data — this session' },
      { index: 4, label: 'allow all edits (switch to accept edits)' },
      { index: 6, label: 'always allow WebFetch — every project' },
    ]);
  });

  it('reads the DB column as JSON and keeps unreadable entries as holes', () => {
    expect(offeredSuggestions(JSON.stringify(wire)).map((o) => o.index)).toEqual([0, 3, 4, 6]);
    expect(parseSuggestions(JSON.stringify(wire))[2]).toBeNull();
    expect(parseSuggestions('not json')).toEqual([]);
    expect(parseSuggestions(null)).toEqual([]);
    expect(offeredSuggestions(undefined)).toEqual([]);
  });

  it('remembers only allow rules, in the CLI\'s own spelling', () => {
    const parsed = parseSuggestions(wire);
    expect(allowRulesOf(parsed[0])).toEqual(['Bash(npm test:*)']);
    expect(allowRulesOf(parsed[6])).toEqual(['WebFetch']);
    expect(allowRulesOf(parsed[4])).toEqual([]);
    expect(allowRulesOf(parsed[1])).toEqual([]);
    expect(ruleString({ toolName: '  ' })).toBe('');
  });
});
