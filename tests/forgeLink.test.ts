import { describe, it, expect } from 'vitest';
import { forgeOf } from '../app/forgeLink';

describe('forgeOf', () => {
  it('names the repo and the forge', () => {
    expect(forgeOf('https://github.com/acme/api')).toEqual({
      url: 'https://github.com/acme/api', name: 'acme/api', host: 'github.com', label: 'GitHub', github: true,
    });
    expect(forgeOf('https://gitlab.com/group/sub/proj')).toMatchObject({ name: 'group/sub/proj', label: 'GitLab', github: false });
    expect(forgeOf('https://git.example.org/team/x')).toMatchObject({ label: 'git.example.org', github: false });
  });

  it('reads nothing it should not link to', () => {
    expect(forgeOf(null)).toBeNull();
    expect(forgeOf('')).toBeNull();
    expect(forgeOf('not a url')).toBeNull();
    expect(forgeOf('http://github.com/a/b')).toBeNull();
    expect(forgeOf('javascript:alert(1)')).toBeNull();
    expect(forgeOf('https://github.com/')).toBeNull();
  });
});
