/** A hosting platform for repositories. Only GitHub is implemented so far. */
export type Platform = 'github' | 'gitlab';

export const PLATFORMS: readonly Platform[] = ['github', 'gitlab'];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}
