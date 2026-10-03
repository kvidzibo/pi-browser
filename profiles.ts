import { chmod, lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function validateProfileName(name: string): string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name)) {
    throw new Error('Invalid profile name: use 1–40 ASCII letters, numbers, underscores, or hyphens; the first character must be a letter or number.');
  }
  return name;
}

async function directoryIsReal(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw error;
  }
}

export class ProfileStore {
  private readonly root: string;

  constructor(directory: string) {
    this.root = join(directory, 'browser-profiles');
  }

  async list(): Promise<string[]> {
    if (!(await directoryIsReal(this.root))) return [];
    const entries = await readdir(this.root, { withFileTypes: true });
    const profiles: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(entry.name)) continue;
      const profilePath = join(this.root, entry.name);
      if (await directoryIsReal(profilePath) && await directoryIsReal(join(profilePath, 'user-data'))) profiles.push(entry.name);
    }
    return profiles.sort();
  }

  async create(name: string): Promise<string> {
    validateProfileName(name);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await directoryIsReal(this.root))) throw new Error('Profile storage root must be a real directory, not a symlink.');
    await chmod(this.root, 0o700);
    const profilePath = join(this.root, name);
    try {
      await mkdir(profilePath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Profile already exists: ${name}`);
      throw error;
    }
    try {
      await chmod(profilePath, 0o700);
      await mkdir(join(profilePath, 'user-data'), { mode: 0o700 });
      await chmod(join(profilePath, 'user-data'), 0o700);
    } catch (error) {
      throw new Error(`Could not create private storage for profile ${name}: ${(error as Error).message}`, { cause: error });
    }
    return profilePath;
  }

  async userDataDir(name: string): Promise<string> {
    validateProfileName(name);
    if (!(await directoryIsReal(this.root))) throw new Error('Profile storage does not exist or is not a real directory.');
    const profile = join(this.root, name);
    if (!(await directoryIsReal(profile))) throw new Error(`Profile does not exist or is not a real directory: ${name}`);
    const userData = join(profile, 'user-data');
    if (!(await directoryIsReal(userData))) throw new Error(`Profile user-data directory does not exist or is not a real directory: ${name}`);
    await chmod(this.root, 0o700);
    await chmod(profile, 0o700);
    await chmod(userData, 0o700);
    return userData;
  }
}
