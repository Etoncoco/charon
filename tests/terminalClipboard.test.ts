import { describe, expect, it } from 'vitest';
import { osc52Text } from '@/app/terminalClipboard';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('osc52Text — what a program in the shell may write to the clipboard', () => {
  it('decodes a write, UTF-8 included, whatever the target letters', () => {
    expect(osc52Text(`c;${b64('copié ✓ depuis claude')}`)).toBe('copié ✓ depuis claude');
    expect(osc52Text(`;${b64('default target')}`)).toBe('default target');
    expect(osc52Text(`pc;${b64('two targets')}`)).toBe('two targets');
    expect(osc52Text(`c;${b64('line one\nline two').replace(/(.{8})/g, '$1\n')}`)).toBe('line one\nline two');
  });

  it('never answers a read, never clears, never takes garbage', () => {
    expect(osc52Text('c;?')).toBeNull();
    expect(osc52Text('c;')).toBeNull();
    expect(osc52Text('no-separator')).toBeNull();
    expect(osc52Text(`x;${b64('bad target')}`)).toBeNull();
    expect(osc52Text('c;not base64!')).toBeNull();
    expect(osc52Text(`c;${'A'.repeat((1 << 20) + 4)}`)).toBeNull();
  });
});
