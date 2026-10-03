import assert from 'node:assert/strict';
import { mkdtemp, mkdir, lstat, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProfileStore, validateProfileName } from '../profiles.ts';

test('private named profile storage creation, listing, validation, and symlink rejection', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'profiles-'));
  try {
    const store = new ProfileStore(temp);
    assert.deepEqual(await store.list(), []);
    await assert.rejects(lstat(join(temp, 'browser-profiles')), { code: 'ENOENT' });
    for (const name of ['Default1', 'team_profile-2']) assert.equal(validateProfileName(name), name);
    for (const name of ['', '.', '..', '../escape', 'a/b', '-bad', 'a'.repeat(41), 'naïve']) {
      assert.throws(() => validateProfileName(name));
    }
    const profile = await store.create('Default1');
    const userData = await store.userDataDir('Default1');
    assert.equal(userData, join(profile, 'user-data'));
    assert.deepEqual(await store.list(), ['Default1']);
    assert.equal((await stat(profile)).mode & 0o777, 0o700);
    assert.equal((await stat(userData)).mode & 0o777, 0o700);
    await assert.rejects(store.create('Default1'), /already exists/);

    await mkdir(join(temp, 'external'));
    await mkdir(join(temp, 'external', 'user-data'));
    await symlink(join(temp, 'external'), join(temp, 'browser-profiles', 'linked'));
    assert.deepEqual(await store.list(), ['Default1']);
    await assert.rejects(store.userDataDir('linked'), /real directory/);

    const external = join(temp, 'external');
    await rm(join(temp, 'browser-profiles'), { recursive: true });
    await symlink(external, join(temp, 'browser-profiles'));
    assert.deepEqual(await store.list(), []);
    await assert.rejects(store.create('unsafe'), /real directory/);
    await assert.rejects(store.userDataDir('unsafe'), /real directory/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
