/**
 * Resolves a verified identity to a local user record.
 *
 * The directory is a port so that provisioning policy — auto-provision on first
 * sign-in, or only pre-provisioned subjects — is a configuration decision rather
 * than something buried in the authentication path.
 *
 * `resolveUser` returns one of:
 *   { user }            — attach this user
 *   { suspended: true } — the account exists but is disabled
 *   null                — no such user
 *
 * Keeping "missing" and "suspended" distinct matters: an unknown subject is an
 * authentication problem (401), a disabled account is an authorization problem
 * (403), and collapsing them makes an offboarded user look like a bad token.
 */
export function createUserDirectory({ repository, autoProvision = true } = {}) {
  if (!repository) throw new Error('createUserDirectory requires a repository.');

  return {
    async resolveUser(identity) {
      if (!identity?.subject) return null;

      const existing = await repository.findUserBySubject(identity.subject);
      if (existing) {
        if (existing.status !== 'ACTIVE') return { suspended: true };
        return { user: existing };
      }

      if (!autoProvision) return null;

      const user = await repository.createUser({
        subject: identity.subject,
        email: identity.email,
        displayName: identity.displayName,
      });
      return { user };
    },
  };
}
