/** What the TV calls the app in front is an Android package name; people know the apps by their names. */
const NAMES: Record<string, string> = {
  "com.google.android.youtube.tv": "YouTube",
  "com.google.android.youtube.tvunplugged": "YouTube TV",
  "com.netflix.ninja": "Netflix",
  "com.amazon.amazonvideo.livingroom": "Prime Video",
  "com.disney.disneyplus": "Disney+",
  "tv.twitch.android.app": "Twitch",
  "com.google.android.tvlauncher": "Home",
  "com.google.android.apps.tv.launcherx": "Home",
  "com.android.vending": "Play Store",
  "com.android.tv.settings": "Settings",
  "com.spotify.tv.android": "Spotify",
  "top.rootu.prisma": "Prisma",
  "ru.yourok.torrserve": "TorrServe",
};

export function appName(pkg: string): string {
  const known = NAMES[pkg];
  if (known) return known;
  // the launcher of a TV is "the home screen", whoever made it (com.google.android.tvlauncher, a maker's tvhome ...)
  if (/(^|\.)(tv)?(home|launcher)x?$/i.test(pkg)) return "Home";
  const parts = pkg.split(".").filter((p) => !["com", "org", "net", "android", "tv", "app", "apps", "google"].includes(p));
  const last = parts.at(-1) ?? pkg;
  const spaced = last.replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The code is six characters, digits and letters A to F; people type it in any case. */
export const CODE_PATTERN = /^[0-9a-fA-F]{6}$/;
