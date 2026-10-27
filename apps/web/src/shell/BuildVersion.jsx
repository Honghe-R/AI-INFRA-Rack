import { BUILD_COMMIT, shortCommit } from '../app/build-info.js';

/**
 * The build the browser is running, as a quiet line in the Settings menu.
 *
 * Settings is where it belongs rather than the About dialog: the question "which build is
 * this?" is asked while looking at something that seems wrong, and the menu opens in one
 * click from wherever the workspace is. The short commit is drawn and the full value stays
 * in the title, so a reader can quote or copy either.
 *
 * A build that could not resolve a commit draws nothing. A "Build" with nothing after it is
 * a worse answer than no line at all — it reports a fact that is not there.
 */
export function BuildVersion({ commit = BUILD_COMMIT }) {
  const value = typeof commit === 'string' ? commit.trim() : '';
  const short = shortCommit(value);
  if (!short) return null;

  return (
    <p className="settings__build" title={value}>
      Build <code>{short}</code>
    </p>
  );
}
